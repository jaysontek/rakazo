/**
 * View-only impersonation side-effect audit.
 *
 * Calls every `IMPERSONATION_PROCEDURE_KIND === "read"` procedure as an
 * impersonating admin session against recording deps. Fails if any read:
 * - throws an error that is not in ALLOWED_ERRORS (with a written reason),
 * - writes via Prisma (including inside $transaction),
 * - calls global fetch / favicons / managed providers,
 * - enqueues jobs / publishes events / touches the sandbox,
 * - wakes or leases a computer,
 * - loads/decrypts secrets without an explicit exemption,
 * - mutates billing / paymentWallet / connectors / memory / artifacts /
 *   plugin fetch / provider catalog shared state.
 */
import { createRouterClient } from "@orpc/server";
import type { Actor } from "@rakazo/contracts";
import { appContract, IMPERSONATION_PROCEDURE_KIND } from "@rakazo/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RouterDeps } from "./router.js";
import { createRouter } from "./router.js";

const ACTOR: Actor = {
  spaceId: "space-1",
  userId: "user-1",
  email: "user@rakazo.test",
  isDeploymentOwner: true,
};

const SESSION_ID = "session-1";
const NOW = new Date("2026-06-01T00:00:00.000Z");
const LEASE_EXPIRES = new Date(Date.now() + 60_000);

const PRISMA_WRITE_METHODS = new Set([
  "create",
  "createMany",
  "update",
  "updateMany",
  "upsert",
  "delete",
  "deleteMany",
  "$executeRaw",
  "$executeRawUnsafe",
]);

/**
 * Paths that may throw a named domain error under unit fixtures.
 * Every entry needs a written reason — unexpected throws fail the audit.
 * Prefer fixing fixtures over adding entries.
 */
const ALLOWED_ERRORS: Record<string, { code?: string; reason: string; match?: RegExp }> = {
  "bots.importPreview": {
    reason: "Needs a real uploaded agent package; empty fixtures cannot reach a clean preview.",
    match: /relative Markdown|agent settings|BAD_REQUEST|Output validation/i,
  },
  "bots.importSetupState": {
    reason: "Import setup expects persisted import draft rows the stub graph does not model.",
    match: /mcpServers|Cannot read properties/i,
  },
  "updater.check": {
    reason: "Desktop updater routes are host-gated and unavailable in API unit fixtures.",
    match: /FORBIDDEN|NOT_FOUND|updater/i,
  },
  "updater.status": {
    reason: "Desktop updater routes are host-gated and unavailable in API unit fixtures.",
    match: /FORBIDDEN|NOT_FOUND|updater/i,
  },
  "accessGrants.list": {
    code: "FORBIDDEN",
    reason: "Grant listing requires organization admin membership the stub actor lacks.",
  },
  "agentSecrets.list": {
    code: "FORBIDDEN",
    reason: "Agent secret listing requires bot ownership checks the stub graph cannot satisfy.",
  },
  "deployment.get": {
    code: "FORBIDDEN",
    reason: "Deployment settings are owner-gated; stub actor is not the deployment owner row.",
  },
  "aiConsent.status": {
    reason: "Consent provider row shape is incomplete under recording stubs.",
    match: /provider|Cannot read properties/i,
  },
  "artifacts.get": {
    reason: "Artifact store returns undefined bytes under the recording stub.",
    match: /first argument|Buffer|undefined/i,
  },
  "artifacts.getById": {
    reason: "Artifact store returns undefined bytes under the recording stub.",
    match: /first argument|Buffer|undefined/i,
  },
  bootstrap: {
    reason: "Bootstrap opens encrypted content rows the stub SecretStore does not implement.",
    match: /contentEncryptionOf|openRows/i,
  },
  "bots.get": {
    reason: "Bot DTO decrypt path needs contentEncryptionOf.openRows on a real secret store.",
    match: /contentEncryptionOf|openRows/i,
  },
  "bots.list": {
    reason: "Bot list decrypt path needs contentEncryptionOf.openRows on a real secret store.",
    match: /contentEncryptionOf|openRows/i,
  },
  "bots.listArchived": {
    reason: "Archived bot list decrypt path needs contentEncryptionOf.openRows.",
    match: /contentEncryptionOf|openRows/i,
  },
  "computer.status": {
    reason: "Computer relation from getBot is null under shallow Prisma stubs.",
    match: /controlRunId|Cannot read properties/i,
  },
  "computer.updates": {
    reason: "Update roster expects nested bot collections the stub omits.",
    match: /bots|Cannot read properties/i,
  },
  "groups.get": {
    reason: "Group membership graph is incomplete under recording stubs.",
    match: /Cannot read properties|undefined/i,
  },
  "groups.list": {
    reason: "Group list decrypt path needs contentEncryptionOf.openRows.",
    match: /contentEncryptionOf|openRows/i,
  },
  "groups.listArchived": {
    reason: "Archived group list decrypt path needs contentEncryptionOf.openRows.",
    match: /contentEncryptionOf|openRows/i,
  },
  "marketplace.catalog": {
    reason: "Marketplace catalog expects configured plugin text reader URLs.",
    match: /trim|Cannot read properties/i,
  },
  "memory.budget": {
    reason: "Memory budget documents collection is absent from the recording memory stub.",
    match: /documents|Cannot read properties/i,
  },
  "threads.get": {
    reason: "Thread computer relation is null under shallow Prisma stubs.",
    match: /controlRunId|Cannot read properties/i,
  },
  "threads.messages": {
    reason: "Message page expects array fields the stub row omits.",
    match: /some|Cannot read properties/i,
  },
  "usage.summary": {
    reason: "Usage summary expects grouped run arrays; stub returns a scalar.",
    match: /runGroups|map is not a function/i,
  },
  // Former /./i catch-alls — narrowed to the exact fixture failures below.
  "messaging.channels.list": {
    reason:
      "Messaging channel list needs installed messaging adapters; stub returns null provider.",
    match: /reading 'provider'/,
  },
  "notifications.subscribe": {
    code: "NOT_FOUND",
    reason: "SSE subscribe needs a live event bus the unit fixtures do not mount.",
  },
  "notifications.subscribeCalls": {
    code: "NOT_FOUND",
    reason: "Call subscribe needs phone-call wiring absent from API unit fixtures.",
  },
  "organizations.list": {
    reason: "Organization membership array shape is incomplete under recording stubs.",
    match: /reading '0'/,
  },
  "runs.list": {
    reason: "Runs list joins bot/name fields the recording Prisma stub leaves null.",
    match: /reading 'name'/,
  },
  "search.query": {
    reason: "Search hits expect named entities the stub rows omit.",
    match: /reading 'name'/,
  },
  "security.events": {
    code: "FORBIDDEN",
    reason: "Security event listing is owner-gated beyond the stub actor.",
  },
  "spaces.list": {
    reason: "Space list decrypt path needs contentEncryptionOf.openRows on a real secret store.",
    match: /openRows is not a function/,
  },
  "spendingLimit.get": {
    reason: "Spending limit reads billing amount fields the stub status omits.",
    match: /reading 'amount'/,
  },
};

/**
 * Secrets loads that are view-only: the procedure never returns the decrypted
 * material, only presence/labels/masked values. models.list / models.forRole
 * must NOT appear here — they use the static view-only catalog under impersonation.
 */
const SECRET_LOAD_EXEMPTIONS: Record<string, string> = {
  "vault.list": "Returns labels/metadata only; never the secret value.",
  "agentSecrets.list": "Returns secret names only; never decrypted values.",
  "botSecrets.list": "Returns secret names only; never decrypted values.",
  "models.credentials": "Returns connection metadata and masked status; never raw keys.",
  "voice.credentials": "Returns provider connection status; never raw API keys.",
  "models.backups": "Reads backup model ids; may resolve credential rows without decrypting.",
  "models.role": "Resolves role model choice; may inspect credential presence only.",
  "memory.providerConfig": "Returns provider config metadata without secret material.",
  "integrationSetup.get": "Returns setup state flags without decrypting provider tokens.",
  "computerProvider.account.get":
    "May decrypt stored computer settings to build the form; secret fields are returned only as savedSecrets booleans, never plaintext.",
};

/**
 * Known writers temporarily treated as reads to prove the harness catches them.
 * Must reuse the MAIN walk's buildDeps + invokePath — not a separate fixture graph.
 */
const PROVE_TEETH_PATHS = [
  "computer.readFile",
  "computer.files",
  "computer.screenUrl",
  "computer.terminalUrl",
  "connections.tools",
  "mcp.servers.agents",
  "paymentWallet.status",
  "capabilities.pluginParts",
  "skills.snapshot",
  "connections.catalog",
  "voice.voices",
] as const;

type SideEffect =
  | { kind: "prisma"; model: string; method: string }
  | { kind: "fetch"; url: string }
  | { kind: "jobs"; method: string }
  | { kind: "events"; method: string }
  | { kind: "sandbox"; method: string }
  | { kind: "secrets"; method: string }
  | { kind: "home"; method: string }
  | { kind: "billing"; method: string }
  | { kind: "paymentWallet"; method: string }
  | { kind: "connectors"; method: string }
  | { kind: "memory"; method: string }
  | { kind: "memoryProviders"; method: string }
  | { kind: "artifacts"; method: string }
  | { kind: "pluginRepoFetcher"; method: string }
  | { kind: "providerCatalog"; method: string }
  | { kind: "computer-helper"; name: string };

function contractProcedurePaths(node: unknown, prefix: readonly string[] = []): readonly string[] {
  if (!node || typeof node !== "object") return [];
  if (Object.hasOwn(node, "~orpc")) return [prefix.join(".")];
  return Object.entries(node as Record<string, unknown>).flatMap(([key, child]) =>
    contractProcedurePaths(child, [...prefix, key]),
  );
}

function stubValue(key: string): unknown {
  const lower = key.toLowerCase();
  if (lower.endsWith("at") || lower === "expiresat" || lower === "createdat") return NOW;
  if (lower === "id" || lower.endsWith("id")) {
    if (lower === "userid") return ACTOR.userId;
    if (lower === "spaceid") return ACTOR.spaceId;
    if (lower === "botid") return "bot-1";
    if (lower === "groupid") return "group-1";
    if (lower === "organizationid") return "org-1";
    if (lower === "sessionid") return SESSION_ID;
    if (lower === "ticketid") return "ticket-1";
    if (lower === "skillid") return "skill-1";
    if (lower === "artifactid" || lower === "familyid") return "artifact-1";
    if (lower === "pageid") return "page-1";
    if (lower === "routineid") return "routine-1";
    if (lower === "boardid") return "board-1";
    if (lower === "computerid") return "computer-1";
    if (lower === "leaseid" || lower === "controlleaseid") return "lease-1";
    return `${key}-1`;
  }
  if (lower === "email") return ACTOR.email;
  if (lower === "name" || lower === "title") return "Test";
  if (lower === "emailverified") return true;
  if (lower === "state") return "running";
  if (lower === "status") return "todo";
  if (lower === "kind") return "docker";
  if (lower === "scope") return "bot";
  if (lower === "providerref") return "provider-ref-1";
  if (lower === "homekey") return "home-1";
  if (lower === "controlholder") return "user";
  if (lower === "impersonatedby") return "admin-1";
  if (lower === "impersonationexpiresat") return new Date(Date.now() + 60_000);
  if (lower === "impersonationorganizationid") return "org-1";
  if (lower.startsWith("is") || lower.startsWith("has") || lower.endsWith("enabled")) return false;
  if (lower.endsWith("count") || lower.endsWith("bytes") || lower.endsWith("usd")) return 0;
  if (lower === "image" || lower === "avatar") return null;
  if (lower === "timezone" || lower === "locale") return null;
  if (lower === "members" || lower === "bots" || lower === "memberships") return [];
  return null;
}

function computerFixture(): Record<string, unknown> {
  return {
    id: "computer-1",
    userId: ACTOR.userId,
    spaceId: ACTOR.spaceId,
    botId: "bot-1",
    state: "running",
    kind: "docker",
    // parseComputerMode only accepts team|dedicated — never "bot".
    scope: "team",
    providerRef: "provider-ref-1",
    homeKey: "home-1",
    controlHolder: "user",
    controlLeaseId: "lease-1",
    controlBotId: "bot-1",
    controlRunId: "run-1",
    controlLeaseExpiresAt: LEASE_EXPIRES,
    screenGeneration: 1,
    maintenanceId: null,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function stubRow(model: string): Record<string, unknown> {
  const computer = computerFixture();
  const base: Record<string, unknown> = {
    id: `${model}-1`,
    userId: ACTOR.userId,
    spaceId: ACTOR.spaceId,
    organizationId: "org-1",
    botId: "bot-1",
    groupId: "group-1",
    boardId: "board-1",
    ticketId: "ticket-1",
    computerId: "computer-1",
    email: ACTOR.email,
    name: "Test",
    title: "Test",
    image: null,
    emailVerified: true,
    deactivatedAt: null,
    archivedAt: null,
    deletedAt: null,
    revokedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    expiresAt: new Date(Date.now() + 3_600_000),
    impersonatedBy: "admin-1",
    impersonationExpiresAt: new Date(Date.now() + 60_000),
    impersonationOrganizationId: "org-1",
    activeOrganizationId: null,
    state: model === "computer" ? "running" : "stopped",
    status:
      model === "teachingSession" ||
      model === "TeachingSession" ||
      model === "taughtSkill" ||
      model === "TaughtSkill"
        ? "recording"
        : "todo",
    kind: "docker",
    scope: "team",
    providerRef: model === "computer" ? "provider-ref-1" : null,
    homeKey: "home-1",
    controlHolder: model === "computer" ? "user" : "none",
    controlLeaseId: model === "computer" ? "lease-1" : null,
    controlBotId: model === "computer" ? "bot-1" : null,
    controlRunId: model === "computer" ? "run-1" : null,
    controlLeaseExpiresAt: model === "computer" ? LEASE_EXPIRES : null,
    screenGeneration: 1,
    maintenanceId: null,
    ticketPrefix: "RAK",
    nextNumber: 2,
    number: 1,
    ref: "RAK-1",
    description: null,
    priority: "normal",
    assigneeBotId: "bot-1",
    createdByBotId: null,
    createdByUserId: ACTOR.userId,
    completedAt: null,
    body: "Ready",
    authorBotId: null,
    authorUserId: ACTOR.userId,
    authorName: "user",
    timezone: null,
    locale: null,
    botAvatarSet: null,
    payload: {},
    type: "computer.command",
    threadId: "thread-1",
    path: "/",
    content: "",
    provider: "openai",
    modelId: "gpt-test",
    secretId: "secret-1",
    role: "main",
    visibility: "private",
    version: 1,
    link: null,
    familyId: "artifact-1",
    artifactId: "artifact-1",
    skillId: "skill-1",
    routineId: "routine-1",
    pageId: "page-1",
    allBots: false,
    url: "https://example.test",
    origin: "https://example.test",
    endpoint: "https://example.test/push",
    ciphertext: "cipher",
    thread: { id: "thread-1", spaceId: ACTOR.spaceId, botId: "bot-1" },
    computer: model === "bot" || model === "Bot" ? computer : null,
    bots: [],
    members: [
      { id: "m1", userId: ACTOR.userId, organizationId: "org-1" },
      { id: "m2", userId: "user-2", organizationId: "org-1" },
    ],
    memberships: [{ userId: ACTOR.userId, spaceId: ACTOR.spaceId }],
    organization: {
      id: "org-1",
      name: "Team",
      members: [{ userId: ACTOR.userId }, { userId: "user-2" }],
    },
    space: { id: ACTOR.spaceId, name: "Personal", organizationId: "org-1" },
    user: { id: ACTOR.userId, email: ACTOR.email, name: "Test", image: null },
    signupSurvey: null,
    adminGrant: null,
    sharedKeyBudget: null,
    pluginInstall: {
      id: "plugin-1",
      userId: ACTOR.userId,
      spaceId: ACTOR.spaceId,
      parts: ["connector"],
    },
    runId: "run-1",
    expiresAtLease: LEASE_EXPIRES,
  };
  if (model === "computerExecutionLease" || model === "ComputerExecutionLease") {
    Object.assign(base, {
      id: "lease-1",
      computerId: "computer-1",
      botId: "bot-1",
      runId: "run-1",
      expiresAt: LEASE_EXPIRES,
    });
  }
  if (model === "paymentWallet" || model === "PaymentWallet") {
    Object.assign(base, {
      id: "wallet-1",
      provider: "test-wallet",
      status: "connecting",
      ciphertext: "cipher",
      nextPollAt: new Date(0),
      pollIntervalMs: 1000,
      verificationUrl: "https://example.test/verify",
      userCode: "ABCD",
      expiresAt: new Date(Date.now() + 60_000),
      balanceCents: 0,
    });
  }
  if (model === "teachingSession" || model === "TeachingSession") {
    Object.assign(base, {
      id: "teaching-1",
      status: "recording",
      skillId: "skill-1",
      botId: "bot-1",
    });
  }
  if (model === "taughtSkill" || model === "TaughtSkill") {
    Object.assign(base, {
      id: "skill-1",
      status: "recording",
      botId: "bot-1",
      goal: "demo",
      name: "Demo",
      playbook: {},
      recording: { events: [], snapshots: [] },
      startedAt: NOW,
      expiresAt: new Date(Date.now() + 60_000),
      stoppedAt: null,
    });
  }
  if (model === "capabilityInstall" || model === "CapabilityInstall") {
    Object.assign(base, {
      id: "plugin-1",
      kind: "plugin",
      version: "1.0.0",
      digest: "sha256:deadbeef",
      config: { parts: ["connector"] },
      source: "https://example.test/plugin",
      availableIn: [],
    });
  }
  if (model === "userVoiceCredential" || model === "UserVoiceCredential") {
    Object.assign(base, {
      id: "voice-cred-1",
      provider: "openai",
      secretId: "secret-1",
      voiceId: "alloy",
      isDefault: true,
    });
  }
  if (model === "secret" || model === "Secret") {
    Object.assign(base, {
      id: "secret-1",
      ciphertext: "cipher",
      kind: "voice",
      spaceId: null,
    });
  }
  if (model === "userModelCredential" || model === "UserModelCredential") {
    Object.assign(base, {
      id: "cred-1",
      provider: "openai",
      secretId: "secret-1",
      isDefault: true,
      userPreferences: [],
    });
  }
  return new Proxy(base, {
    get(target, prop) {
      if (prop === "then") return undefined;
      if (typeof prop === "symbol") return undefined;
      if (prop in target) return target[prop as string];
      return stubValue(String(prop));
    },
  }) as Record<string, unknown>;
}

function createRecordingPrisma(effects: SideEffect[]) {
  const modelHandler = (model: string): ProxyHandler<Record<string, unknown>> => ({
    get(target, method) {
      if (typeof method === "symbol") return undefined;
      const name = String(method);
      if (name in target) return target[name];
      if (PRISMA_WRITE_METHODS.has(name)) {
        return async () => {
          effects.push({ kind: "prisma", model, method: name });
          if (name === "updateMany" || name === "deleteMany" || name === "createMany") {
            return { count: 0 };
          }
          return stubRow(model);
        };
      }
      if (name === "count" || name === "aggregate") return async () => 0;
      if (name === "findMany" || name === "findManyAndReturn") {
        return async () => [stubRow(model)];
      }
      if (
        name === "findFirst" ||
        name === "findUnique" ||
        name === "findFirstOrThrow" ||
        name === "findUniqueOrThrow"
      ) {
        return async () => stubRow(model);
      }
      if (name === "updateManyAndReturn") {
        return async () => {
          effects.push({ kind: "prisma", model, method: name });
          return [stubRow(model)];
        };
      }
      return async () => stubRow(model);
    },
    set(target, method, value) {
      target[String(method)] = value;
      return true;
    },
  });

  const root: Record<string, unknown> = {};
  const models = new Map<string, object>();
  return new Proxy(root, {
    get(target, prop) {
      if (typeof prop === "symbol") return undefined;
      const name = String(prop);
      if (name in target) return target[name];
      if (name === "$transaction") {
        return async (arg: unknown) => {
          if (typeof arg === "function") {
            return (arg as (tx: unknown) => unknown)(createRecordingPrisma(effects));
          }
          if (Array.isArray(arg)) {
            return Promise.all(arg);
          }
          return arg;
        };
      }
      if (name === "$queryRaw" || name === "$queryRawUnsafe") {
        return async () => [];
      }
      if (PRISMA_WRITE_METHODS.has(name)) {
        return async () => {
          effects.push({ kind: "prisma", model: "$", method: name });
          return { count: 0 };
        };
      }
      if (name.startsWith("$")) return async () => undefined;
      let model = models.get(name);
      if (!model) {
        model = new Proxy({} as Record<string, unknown>, modelHandler(name));
        models.set(name, model);
      }
      return model;
    },
    set(target, prop, value) {
      target[String(prop)] = value;
      return true;
    },
  });
}

function recordable(
  effects: SideEffect[],
  kind: SideEffect["kind"],
  methods: string[],
  defaults: Record<string, unknown> = {},
): Record<string, unknown> {
  const target: Record<string, unknown> = { ...defaults };
  for (const method of methods) {
    if (method in target) continue;
    target[method] = (..._args: unknown[]) => {
      effects.push({ kind, method } as SideEffect);
      return Promise.resolve(undefined);
    };
  }
  return new Proxy(target, {
    get(t, prop) {
      if (typeof prop === "symbol") return undefined;
      if (prop in t) {
        const value = t[prop as string];
        if (typeof value === "function") {
          return (...args: unknown[]) => {
            effects.push({ kind, method: String(prop) } as SideEffect);
            return (value as (...inner: unknown[]) => unknown)(...args);
          };
        }
        return value;
      }
      return (..._args: unknown[]) => {
        effects.push({ kind, method: String(prop) } as SideEffect);
        if (kind === "sandbox" && String(prop) === "listFiles") return Promise.resolve([]);
        if (kind === "sandbox" && String(prop) === "readFile")
          return Promise.resolve(new Uint8Array());
        if (kind === "home" && String(prop) === "list") return Promise.resolve([]);
        if (kind === "secrets" && (String(prop) === "load" || String(prop) === "decrypt")) {
          // Wallet poll needs a pending state blob; voice decrypt needs a key string.
          return Promise.resolve(
            JSON.stringify({ state: "pending-state", intervalMs: 1000, apiKey: "sk-test" }),
          );
        }
        if (kind === "billing" && String(prop) === "status") {
          return Promise.resolve({
            enabled: true,
            plan: "pro",
            trialAvailable: false,
            referralCode: null,
            spendingLimitUsd: null,
            softCapUsd: null,
          });
        }
        if (kind === "billing" && String(prop) === "claimReferral") {
          return Promise.resolve({ ok: true });
        }
        if (kind === "paymentWallet" && String(prop) === "status") {
          return Promise.resolve({
            status: "connecting",
            verificationUrl: "https://example.test/verify",
            userCode: "ABCD",
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
          });
        }
        if (kind === "connectors" && String(prop) === "list") return [];
        if (kind === "connectors" && String(prop) === "get") return null;
        if (kind === "memory" && String(prop) === "list") return Promise.resolve([]);
        if (kind === "memory" && String(prop) === "exportMarkdown") return Promise.resolve("");
        if (kind === "memoryProviders" && String(prop) === "list") return Promise.resolve([]);
        if (kind === "memoryProviders" && String(prop) === "resolve") return Promise.resolve(null);
        if (kind === "artifacts") return Promise.resolve(null);
        if (kind === "providerCatalog") return Promise.resolve(new Map());
        return Promise.resolve(undefined);
      };
    },
  });
}

function doneFollow() {
  return {
    next: async () => ({ done: true as const, value: undefined }),
    return: async () => ({ done: true as const, value: undefined }),
  };
}

const INPUT_FIXTURES: Record<string, unknown> = {
  "agentSkills.get": { skillId: "skill-1" },
  "artifacts.get": { botId: "bot-1", path: "/note.md", artifactId: "artifact-1" },
  "artifacts.getById": { artifactId: "artifact-1" },
  "artifacts.list": { botId: "bot-1" },
  "artifacts.listSpace": {},
  "artifacts.listVersions": { familyId: "artifact-1" },
  "audit.events": {},
  "billing.status": {},
  bootstrap: {},
  "botSecrets.list": { botId: "bot-1" },
  "bots.get": { botId: "bot-1" },
  "bots.importPreview": {
    files: [{ path: "agent.json", content: "{}" }],
    includeSecrets: false,
  },
  "bots.importSetupState": {
    botId: "bot-1",
    providers: [],
    serverIds: [],
    routineIds: [],
  },
  "capabilities.catalogSearch": {},
  "capabilities.pluginParts": { id: "plugin-1", parts: ["connector"] },
  "computer.commands": { botId: "bot-1" },
  "computer.files": { botId: "bot-1", path: "/" },
  "computer.readFile": { botId: "bot-1", path: "/readme.md" },
  "computer.screenUrl": { botId: "bot-1" },
  "computer.status": { botId: "bot-1" },
  "computer.terminalUrl": { botId: "bot-1" },
  "connections.catalog": {},
  "connections.tools": { connectorId: "managed-1", provider: "test" },
  "groups.get": { groupId: "group-1" },
  "marketplace.catalog": {},
  "mcp.assignments.list": { botId: "bot-1" },
  "mcp.servers.agents": { id: "mcp-1", allBots: false, botIds: ["bot-1"] },
  "memory.budget": { botId: "bot-1" },
  "memory.exportMarkdown": {},
  "memory.list": {},
  "models.forRole": { role: "main" },
  "models.role": { role: "main", scope: "space" },
  "pages.get": { pageId: "page-1" },
  "pages.list": {},
  "paymentWallet.status": {},
  "routines.history": { routineId: "routine-1" },
  "routines.list": { botId: "bot-1" },
  "routines.listForMentions": { botIds: ["bot-1"] },
  "runs.list": { filter: "recent" },
  "scratchpad.list": { botId: "bot-1" },
  "search.query": { q: "hello" },
  "security.events": {},
  "skills.get": { skillId: "skill-1" },
  "skills.list": { botId: "bot-1" },
  "skills.snapshot": { skillId: "skill-1" },
  "threads.get": { botId: "bot-1" },
  "threads.head": { botId: "bot-1" },
  "threads.messages": { botId: "bot-1" },
  "threads.subscribe": { botId: "bot-1", cursor: 0 },
  "tickets.comments": { ticketId: "ticket-1" },
  "tickets.get": { id: "ticket-1" },
  "tickets.list": {},
  "updater.check": {},
  "voice.voices": { provider: "openai", scope: "account" },
};

type InputSchema = {
  safeParse: (
    value: unknown,
  ) =>
    | { success: true; data: unknown }
    | { success: false; error: { issues: Array<{ message: string }> } };
};

function resolveInput(path: string, schema: InputSchema | undefined) {
  if (path in INPUT_FIXTURES) return INPUT_FIXTURES[path];
  if (!schema) return undefined;
  if (schema.safeParse(undefined).success) return undefined;
  if (schema.safeParse({}).success) return {};
  return {};
}

async function invokePath(
  rpc: unknown,
  path: readonly string[],
  input?: unknown,
): Promise<unknown> {
  let current: unknown = rpc;
  for (const segment of path) {
    current = (current as Record<string, unknown> | null | undefined)?.[segment];
  }
  if (typeof current !== "function") {
    throw new Error(`Missing client path ${path.join(".")}`);
  }
  const result = await (current as (value?: unknown) => Promise<unknown>)(input);
  if (result && typeof result === "object" && Symbol.asyncIterator in result) {
    const iterator = (result as AsyncIterable<unknown>)[Symbol.asyncIterator]();
    await iterator.next();
    await iterator.return?.();
    return undefined;
  }
  return result;
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error
    ? String((error as { code: unknown }).code)
    : undefined;
}

function filterBadEffects(dotted: string, produced: SideEffect[]): SideEffect[] {
  return produced.filter((effect) => {
    if (effect.kind === "secrets") {
      if (effect.method !== "load" && effect.method !== "decrypt") return true;
      return !(dotted in SECRET_LOAD_EXEMPTIONS);
    }
    if (effect.kind === "home") {
      return effect.method !== "list" && effect.method !== "read";
    }
    if (effect.kind === "events" && effect.method === "follow") return false;
    if (
      effect.kind === "memory" &&
      (effect.method === "list" || effect.method === "exportMarkdown" || effect.method === "read")
    )
      return false;
    if (
      effect.kind === "memoryProviders" &&
      (effect.method === "list" || effect.method === "resolve")
    )
      return false;
    if (
      effect.kind === "artifacts" &&
      ["get", "getById", "list", "listSpace", "listVersions"].includes(effect.method)
    )
      return false;
    if (effect.kind === "connectors" && (effect.method === "list" || effect.method === "get"))
      return false;
    if (effect.kind === "billing" && effect.method === "status") return false;
    // describe/status/displayName are metadata reads used by me/bootstrap.
    if (
      effect.kind === "paymentWallet" &&
      (effect.method === "status" ||
        effect.method === "describe" ||
        effect.method === "displayName")
    )
      return false;
    return true;
  });
}

function buildDeps(effects: SideEffect[], fetchMock: ReturnType<typeof vi.fn>): RouterDeps {
  const prisma = createRecordingPrisma(effects);
  const jobs = recordable(effects, "jobs", ["enqueue", "publish", "schedule", "cancel", "add"]);
  const events = recordable(effects, "events", ["notify", "publish", "append", "follow"]);
  const sandbox = recordable(effects, "sandbox", [
    "listFiles",
    "readFile",
    "writeFile",
    "start",
    "stop",
    "exec",
    "connectTerminal",
    "connectScreen",
    "ensureRunning",
    "wake",
  ]);
  const home = recordable(effects, "home", ["list", "read", "write", "remove"]);
  const secrets = recordable(effects, "secrets", ["load", "decrypt", "put", "remove", "describe"]);
  (secrets as { describe: () => { capabilities: { degraded: boolean } } }).describe = () => ({
    capabilities: { degraded: false },
  });
  const memory = recordable(effects, "memory", ["list", "exportMarkdown", "put", "remove"]);
  const memoryProviders = recordable(effects, "memoryProviders", ["resolve", "list"]);
  const artifacts = recordable(effects, "artifacts", [
    "get",
    "getById",
    "list",
    "listSpace",
    "listVersions",
    "create",
    "remove",
  ]);
  const billing = recordable(effects, "billing", [
    "status",
    "claimReferral",
    "syncForActor",
    "checkout",
    "portal",
  ]);
  const paymentWallet = recordable(
    effects,
    "paymentWallet",
    ["status", "create", "refresh", "describe", "pollConnect", "beginConnect", "disconnect"],
    {
      describe: () => ({ id: "test-wallet", name: "Test Wallet" }),
      displayName: "Test Wallet",
      pollConnect: async () => {
        effects.push({ kind: "paymentWallet", method: "pollConnect" });
        return { status: "pending" };
      },
    },
  );
  const pluginRepoFetcher = recordable(effects, "pluginRepoFetcher", ["fetch", "read"], {
    fetch: async () => {
      effects.push({ kind: "pluginRepoFetcher", method: "fetch" });
      return { files: {} };
    },
  });
  const providerCatalog = recordable(effects, "providerCatalog", ["get", "refresh", "list"]);

  // Sandbox returns usable payloads so running-computer paths reach their writes.
  sandbox.listFiles = async () => {
    effects.push({ kind: "sandbox", method: "listFiles" });
    return [];
  };
  sandbox.readFile = async () => {
    effects.push({ kind: "sandbox", method: "readFile" });
    return new TextEncoder().encode("hello");
  };
  sandbox.connectScreen = async () => {
    effects.push({ kind: "sandbox", method: "connectScreen" });
    return { url: "https://example.test/screen" };
  };
  sandbox.connectTerminal = async () => {
    effects.push({ kind: "sandbox", method: "connectTerminal" });
    return { url: "https://example.test/terminal" };
  };
  sandbox.observe = async () => {
    effects.push({ kind: "sandbox", method: "observe" });
    return { activeWindow: { title: "demo" } };
  };
  // secrets.load: wallet poll needs JSON state; voice.voices needs a key string.
  secrets.load = async () => {
    effects.push({ kind: "secrets", method: "load" });
    return JSON.stringify({ state: "pending-state", intervalMs: 1000 });
  };
  secrets.decrypt = async () => {
    effects.push({ kind: "secrets", method: "decrypt" });
    return "sk-test";
  };

  const managedConnector = {
    describe: () => ({ id: "managed-1", name: "Managed", provider: "test" }),
    discoverTools: async () => {
      effects.push({ kind: "connectors", method: "discoverTools" });
      return [{ name: "tool", description: "demo" }];
    },
    catalog: async () => {
      effects.push({ kind: "connectors", method: "catalog" });
      return [{ slug: "demo", name: "Demo", connected: true }];
    },
    listReconnectRefs: async () => [],
  };

  const deps = {
    prisma,
    env: {
      ticketBoardEnabled: true,
      webOrigin: "http://127.0.0.1:5173",
      screenProxySecret: "fake-test-secret",
      sandboxProvider: "fake",
      defaultProvider: "openai",
      defaultModel: "gpt-test",
      agentRuntime: "pi",
      adminEmails: ["admin@rakazo.test"],
    },
    jobs,
    events: {
      ...events,
      follow: () => doneFollow(),
      append: async () => {
        effects.push({ kind: "events", method: "append" });
        return undefined;
      },
    },
    boardEvents: { follow: () => doneFollow() },
    ticketChanges: { notify: () => undefined },
    sandbox,
    home,
    secrets,
    memory,
    memoryProviders,
    artifacts,
    pushTokens: {
      load: async () => undefined,
      save: async () => undefined,
      importLegacy: async () => false,
      remove: async () => undefined,
      endSession: async () => undefined,
    },
    webPushSubscriptions: {
      save: async () => undefined,
      remove: async () => undefined,
      list: async () => [],
      hasEndpoint: async () => false,
      endSession: async () => undefined,
    },
    webPush: { publicKey: () => "test-public-key", vapidDigest: () => "digest" },
    connectors: {
      list: () => {
        effects.push({ kind: "connectors", method: "list" });
        return [
          {
            id: "managed-1",
            name: "Managed",
            managed: true,
            provider: "test",
          },
        ] as never[];
      },
      get: (id: string) => {
        effects.push({ kind: "connectors", method: "get" });
        return id === "managed-1"
          ? ({ id, name: "Managed", managed: true, provider: "test" } as never)
          : null;
      },
      managed: (id: string) => {
        effects.push({ kind: "connectors", method: "managed" });
        return id === "managed-1" ? (managedConnector as never) : null;
      },
      managedProviders: () => {
        effects.push({ kind: "connectors", method: "managedProviders" });
        return [managedConnector] as never;
      },
    },
    auth: {},
    dataDir: "/tmp/rakazo-impersonation-audit",
    modelConnectionFetch: fetchMock,
    favicons: {
      resolve: async (origin: string) => {
        effects.push({ kind: "fetch", url: `favicon:${origin}` });
        return null;
      },
    },
    paymentWallet: paymentWallet as never,
    billing: billing as never,
    pluginRepoFetcher: pluginRepoFetcher as never,
    providerCatalog: providerCatalog as never,
    oauthLogins: {} as never,
  } as unknown as RouterDeps;

  deepenPrismaFixtures(deps, effects);
  return deps;
}

/** Deep fixtures shared by the MAIN walk and the teeth walk. */
function deepenPrismaFixtures(deps: RouterDeps, effects: SideEffect[]) {
  const prisma = deps.prisma as unknown as Record<string, Record<string, unknown>>;
  const model = (name: string) => prisma[name]!;
  const runningComputer = computerFixture();
  const botWithComputer = {
    id: "bot-1",
    name: "Test",
    spaceId: ACTOR.spaceId,
    userId: ACTOR.userId,
    archivedAt: null,
    screenGeneration: 1,
    thread: { id: "thread-1", spaceId: ACTOR.spaceId, botId: "bot-1" },
    computer: runningComputer,
  };
  const pluginInstall = {
    id: "plugin-1",
    userId: ACTOR.userId,
    spaceId: ACTOR.spaceId,
    kind: "plugin",
    version: "1.0.0",
    digest: "sha256:deadbeef",
    config: { parts: ["connector"] },
    source: "https://example.test/plugin",
    availableIn: [],
  };
  const taughtSkill = {
    id: "skill-1",
    userId: ACTOR.userId,
    spaceId: ACTOR.spaceId,
    botId: "bot-1",
    status: "recording",
    goal: "demo",
    name: "Demo",
    playbook: {},
    recording: { events: [], snapshots: [] },
    startedAt: NOW,
    expiresAt: new Date(Date.now() + 60_000),
    stoppedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
  };

  model("bot").findFirst = async () => botWithComputer;
  model("bot").findUnique = async () => botWithComputer;
  model("computer").findFirst = async () => runningComputer;
  model("computer").findUnique = async () => runningComputer;
  model("capabilityInstall").findFirst = async () => pluginInstall;
  model("capabilityInstall").findUnique = async () => pluginInstall;
  model("taughtSkill").findFirst = async () => taughtSkill;
  model("taughtSkill").findUnique = async () => taughtSkill;
  model("taughtSkill").findUniqueOrThrow = async () => taughtSkill;
  model("mcpServer").findFirst = async () => ({
    id: "mcp-1",
    spaceId: ACTOR.spaceId,
    userId: ACTOR.userId,
    allBots: true,
    availableIn: [],
  });
  model("connection").findFirst = async () => ({
    id: "conn-1",
    connectorId: "managed-1",
    provider: "test",
    displayName: "Demo",
    providerRef: "ref-1",
    status: "connected",
  });
  model("paymentWallet").findUnique = async () => ({
    id: "wallet-1",
    userId: ACTOR.userId,
    provider: "test-wallet",
    status: "connecting",
    ciphertext: "cipher",
    nextPollAt: new Date(0),
    pollIntervalMs: 1000,
    verificationUrl: "https://example.test/verify",
    userCode: "ABCD",
    expiresAt: new Date(Date.now() + 60_000),
  });
  model("userVoiceCredential").findFirst = async () => ({
    id: "voice-cred-1",
    userId: ACTOR.userId,
    provider: "openai",
    secretId: "secret-1",
    voiceId: "alloy",
    isDefault: true,
  });
  model("secret").findFirst = async () => ({
    id: "secret-1",
    userId: ACTOR.userId,
    spaceId: null,
    ciphertext: "cipher",
    kind: "voice",
  });

  // Explicit write recorders so Proxy assignment overrides stay teeth-visible.
  for (const name of [
    "computer",
    "paymentWallet",
    "capabilityInstall",
    "mcpServer",
    "taughtSkill",
  ]) {
    model(name).update = async () => {
      effects.push({ kind: "prisma", model: name, method: "update" });
      return stubRow(name);
    };
    model(name).updateMany = async () => {
      effects.push({ kind: "prisma", model: name, method: "updateMany" });
      return { count: 1 };
    };
  }
}

describe("impersonation read side-effect audit", () => {
  const originalFetch = globalThis.fetch;
  let effects: SideEffect[];
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    effects = [];
    fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      effects.push({ kind: "fetch", url: String(input) });
      return new Response("{}", { status: 200 });
    });
    globalThis.fetch = fetchMock as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("walks every contract leaf and records zero side effects on every read", async () => {
    const contractPaths = contractProcedurePaths(appContract);
    expect(contractPaths.length).toBe(314);

    const reads = Object.entries(IMPERSONATION_PROCEDURE_KIND)
      .filter(([, kind]) => kind === "read")
      .map(([path]) => path)
      .sort();
    expect(reads).toMatchInlineSnapshot(`
      [
        "accessGrants.list",
        "agentSecrets.list",
        "agentSkills.get",
        "agentSkills.list",
        "aiConsent.status",
        "approvalRules.list",
        "artifacts.get",
        "artifacts.getById",
        "artifacts.list",
        "artifacts.listSpace",
        "artifacts.listVersions",
        "audit.events",
        "autoReview.get",
        "availability.items",
        "billing.status",
        "boards.get",
        "boards.list",
        "boards.subscribe",
        "bootstrap",
        "botSecrets.list",
        "botSections.list",
        "bots.get",
        "bots.importPreview",
        "bots.importSetupState",
        "bots.list",
        "bots.listArchived",
        "capabilities.catalogSearch",
        "capabilities.list",
        "computer.commands",
        "computer.status",
        "computer.updates",
        "computerProvider.account.get",
        "connections.list",
        "deployment.get",
        "groups.get",
        "groups.list",
        "groups.listArchived",
        "health",
        "integrationSetup.get",
        "marketplace.catalog",
        "mcp.assignments.all",
        "mcp.assignments.list",
        "mcp.servers.list",
        "me",
        "memory.budget",
        "memory.exportMarkdown",
        "memory.list",
        "memory.providerConfig",
        "messaging.channels.list",
        "messaging.connections.list",
        "messaging.installations.list",
        "messaging.status",
        "models.backups",
        "models.credentials",
        "models.forRole",
        "models.list",
        "models.role",
        "notifications.subscribe",
        "notifications.subscribeCalls",
        "notifications.webPushStatus",
        "organizations.list",
        "pages.get",
        "pages.list",
        "routines.history",
        "routines.list",
        "routines.listForMentions",
        "runs.list",
        "scratchpad.list",
        "search.query",
        "security.events",
        "skills.get",
        "skills.list",
        "spaceSettings.overrides",
        "spaces.list",
        "spendingLimit.get",
        "threads.get",
        "threads.head",
        "threads.messages",
        "threads.subscribe",
        "tickets.comments",
        "tickets.get",
        "tickets.list",
        "trustedLinkSites.list",
        "updater.check",
        "updater.status",
        "usage.list",
        "usage.summary",
        "vault.list",
        "voice.catalog",
        "voice.credentials",
        "voice.status",
      ]
    `);
    expect(reads.length).toBe(91);

    const deps = buildDeps(effects, fetchMock);
    const rpc = createRouterClient(createRouter(deps), {
      context: {
        actor: ACTOR,
        sessionId: SESSION_ID,
        impersonatedBy: "admin-1",
      },
    });

    expect(contractPaths.length).toBe(314);

    const completed: string[] = [];
    const allowedErrorHits: string[] = [];
    const unexpectedErrors: Array<{ path: string; code?: string; message?: string }> = [];
    const sideEffectHits: Array<{ path: string; effects: SideEffect[] }> = [];

    for (const dotted of reads) {
      const before = effects.length;
      const segments = dotted.split(".");
      const node = segments.reduce<unknown>(
        (current, key) => (current as Record<string, unknown> | null | undefined)?.[key],
        appContract,
      );
      const schema = (node as { "~orpc"?: { inputSchema?: InputSchema } })?.["~orpc"]?.inputSchema;
      const input = resolveInput(dotted, schema);
      const schemaCheck = schema?.safeParse(input);
      if (schema && schemaCheck && !schemaCheck.success) {
        const message = schemaCheck.error.issues.map((issue) => issue.message).join("; ");
        const allowed = ALLOWED_ERRORS[dotted];
        const matchOk = !allowed?.match || allowed.match.test(`INPUT_SCHEMA ${message}`);
        if (allowed && matchOk) {
          allowedErrorHits.push(dotted);
        } else {
          unexpectedErrors.push({
            path: dotted,
            code: "INPUT_SCHEMA",
            message,
          });
        }
        continue;
      }
      try {
        await invokePath(rpc, segments, input);
        completed.push(dotted);
      } catch (error) {
        const code = errorCode(error);
        const message =
          error && typeof error === "object" && "message" in error
            ? String((error as { message: unknown }).message)
            : String(error);
        // Output validation means the handler returned — side effects already recorded.
        if (/Output validation failed/i.test(message ?? "")) {
          completed.push(dotted);
        } else {
          const allowed = ALLOWED_ERRORS[dotted];
          const codeOk = !allowed?.code || allowed.code === code;
          const matchOk = !allowed?.match || allowed.match.test(`${code ?? ""} ${message ?? ""}`);
          if (allowed && codeOk && matchOk) {
            allowedErrorHits.push(dotted);
          } else {
            unexpectedErrors.push({ path: dotted, code, message });
          }
        }
      }
      const produced = effects.slice(before);
      const bad = filterBadEffects(dotted, produced);
      if (bad.length > 0) {
        sideEffectHits.push({ path: dotted, effects: bad });
      }
    }

    expect({ sideEffectHits, unexpectedErrors }).toEqual({
      sideEffectHits: [],
      unexpectedErrors: [],
    });
    expect(completed).toMatchSnapshot("reads-completed");
    expect(completed.length + allowedErrorHits.length).toBe(reads.length);
    expect(completed.length).toBeGreaterThan(50);
  }, 120_000);

  it("proves teeth: temporarily allowing known writers fails the side-effect audit for each", async () => {
    // Reuse the MAIN walk's buildDeps / resolveInput / invokePath / filterBadEffects.
    const allowlist = await import("./impersonation-allowlist.js");
    const originalAllowed = allowlist.isImpersonationAllowedProcedure;
    const allowed = vi
      .spyOn(allowlist, "isImpersonationAllowedProcedure")
      .mockImplementation((path: readonly string[]) => {
        if ((PROVE_TEETH_PATHS as readonly string[]).includes(path.join("."))) return true;
        return originalAllowed(path);
      });

    const deps = buildDeps(effects, fetchMock);
    const rpc = createRouterClient(createRouter(deps), {
      context: {
        actor: ACTOR,
        sessionId: SESSION_ID,
        impersonatedBy: "admin-1",
      },
    });

    const teeth: Array<{
      path: string;
      bad: SideEffect[];
      error?: string;
      fixtureError: boolean;
    }> = [];
    for (const dotted of PROVE_TEETH_PATHS) {
      const before = effects.length;
      const segments = dotted.split(".");
      const node = segments.reduce<unknown>(
        (current, key) => (current as Record<string, unknown> | null | undefined)?.[key],
        appContract,
      );
      const schema = (node as { "~orpc"?: { inputSchema?: InputSchema } })?.["~orpc"]?.inputSchema;
      const input = resolveInput(dotted, schema);
      const schemaCheck = schema?.safeParse(input);
      if (schema && schemaCheck && !schemaCheck.success) {
        teeth.push({
          path: dotted,
          bad: [],
          error: schemaCheck.error.issues.map((issue) => issue.message).join("; "),
          fixtureError: true,
        });
        continue;
      }
      let errorMessage: string | undefined;
      try {
        await invokePath(rpc, segments, input);
      } catch (error) {
        errorMessage =
          error && typeof error === "object" && "message" in error
            ? String((error as { message: unknown }).message)
            : String(error);
      }
      const bad = filterBadEffects(dotted, effects.slice(before));
      // Fixture/domain errors without a recorded side effect mean the harness missed the write.
      const fixtureError =
        bad.length === 0 &&
        Boolean(errorMessage) &&
        !/Output validation failed|Not allowed while impersonating/i.test(errorMessage ?? "");
      teeth.push({ path: dotted, bad, error: errorMessage, fixtureError });
    }

    allowed.mockRestore();

    const results = Object.fromEntries(
      teeth.map((row) => [
        row.path,
        {
          detected: row.bad.length > 0,
          kinds: [...new Set(row.bad.map((effect) => effect.kind))],
          fixtureError: row.fixtureError,
          error: row.error?.slice(0, 120),
        },
      ]),
    );
    const missed = teeth.filter((row) => row.bad.length === 0).map((row) => row.path);
    const fixtureFailures = teeth.filter((row) => row.fixtureError).map((row) => row.path);
    expect({ missed, fixtureFailures, results }).toEqual({
      missed: [],
      fixtureFailures: [],
      results,
    });
    for (const row of teeth) {
      expect(
        row.bad.length,
        `${row.path} must fail ONLY because a side effect was detected`,
      ).toBeGreaterThan(0);
      expect(row.fixtureError, `${row.path} must not fail on a fixture error`).toBe(false);
    }
  }, 120_000);

  it("computer.status skips expireStaleComputerControl while impersonating", async () => {
    const deps = buildDeps(effects, fetchMock);
    const prisma = deps.prisma as unknown as Record<string, Record<string, unknown>>;
    const staleComputer = {
      ...computerFixture(),
      // Expired lease: expire would write if status did not skip it.
      controlLeaseExpiresAt: new Date(Date.now() - 60_000),
      controlHolder: "user",
      controlLeaseId: "lease-stale",
    };
    const bot = {
      id: "bot-1",
      name: "Test",
      spaceId: ACTOR.spaceId,
      userId: ACTOR.userId,
      archivedAt: null,
      screenGeneration: 1,
      thread: { id: "thread-1", spaceId: ACTOR.spaceId, botId: "bot-1" },
      computer: staleComputer,
    };
    prisma.bot!.findFirst = async () => bot;
    prisma.bot!.findUnique = async () => bot;
    prisma.computer!.findFirst = async () => staleComputer;
    prisma.computer!.findUnique = async () => staleComputer;

    const impersonated = createRouterClient(createRouter(deps), {
      context: { actor: ACTOR, sessionId: SESSION_ID, impersonatedBy: "admin-1" },
    });
    const beforeImpersonated = effects.length;
    await impersonated.computer.status({ botId: "bot-1" }).catch(() => undefined);
    const impersonatedWrites = effects
      .slice(beforeImpersonated)
      .filter((effect) => effect.kind === "prisma" && effect.model === "computer");
    expect(impersonatedWrites).toEqual([]);

    const live = createRouterClient(createRouter(deps), {
      context: { actor: ACTOR, sessionId: SESSION_ID },
    });
    const beforeLive = effects.length;
    await live.computer.status({ botId: "bot-1" }).catch(() => undefined);
    const liveWrites = effects
      .slice(beforeLive)
      .filter((effect) => effect.kind === "prisma" && effect.model === "computer");
    expect(liveWrites.length).toBeGreaterThan(0);
  });

  it("rejects billing.status referralCode while impersonating", async () => {
    const deps = buildDeps(effects, fetchMock);
    const rpc = createRouterClient(createRouter(deps), {
      context: {
        actor: ACTOR,
        sessionId: SESSION_ID,
        impersonatedBy: "admin-1",
      },
    });
    await expect(rpc.billing.status({ referralCode: "REF123" })).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: "Not allowed while impersonating",
    });
    expect(effects.filter((e) => e.kind === "billing" && e.method === "claimReferral")).toEqual([]);
  });
});
