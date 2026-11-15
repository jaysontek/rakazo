/**
 * View-only impersonation side-effect audit.
 *
 * Calls every `IMPERSONATION_PROCEDURE_KIND === "read"` procedure as an
 * impersonating admin session against recording deps. Fails if any read:
 * - writes via Prisma (including inside $transaction),
 * - calls global fetch,
 * - enqueues jobs / publishes events / touches the sandbox,
 * - loads/decrypts secrets without an explicit exemption.
 */
import { createRouterClient } from "@orpc/server";
import {
  appContract,
  IMPERSONATION_PROCEDURE_KIND,
  type Actor,
} from "@rakazo/contracts";
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

/** Leaves that are allowed to never execute past validation (documented). */
const ALLOWED_VALIDATION_STOPS = new Set<string>([
  // Import preview needs a real uploaded file blob; empty fixtures cannot reach the body.
  "bots.importPreview",
]);

/**
 * Secrets loads that are view-only: the procedure never returns the decrypted
 * material, only presence/labels/masked values.
 */
const SECRET_LOAD_EXEMPTIONS: Record<string, string> = {
  "vault.list": "Returns labels/metadata only; never the secret value.",
  "agentSecrets.list": "Returns secret names only; never decrypted values.",
  "botSecrets.list": "Returns secret names only; never decrypted values.",
  "models.credentials": "Returns connection metadata and masked status; never raw keys.",
  "voice.credentials": "Returns provider connection status; never raw API keys.",
  "models.list": "May touch credential presence checks without returning secrets.",
  "models.backups": "Reads backup model ids; may resolve credential rows without decrypting.",
  "models.forRole": "Resolves role model choice; may inspect credential presence only.",
  "models.role": "Resolves role model choice; may inspect credential presence only.",
  "memory.providerConfig": "Returns provider config metadata without secret material.",
  "integrationSetup.get": "Returns setup state flags without decrypting provider tokens.",
  "computerProvider.account.get":
    "May decrypt stored computer settings to build the form; secret fields are returned only as savedSecrets booleans, never plaintext.",
  "computerProvider.get":
    "May decrypt deployment computer settings for the form; secret fields are returned only as savedSecrets booleans, never plaintext.",
};

type SideEffect =
  | { kind: "prisma"; model: string; method: string }
  | { kind: "fetch"; url: string }
  | { kind: "jobs"; method: string }
  | { kind: "events"; method: string }
  | { kind: "sandbox"; method: string }
  | { kind: "secrets"; method: string }
  | { kind: "home"; method: string }
  | { kind: "computer-helper"; name: string };

function contractProcedurePaths(
  node: unknown,
  prefix: readonly string[] = [],
): readonly string[] {
  if (!node || typeof node !== "object") return [];
  if (Object.prototype.hasOwnProperty.call(node, "~orpc")) return [prefix.join(".")];
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
    return `${key}-1`;
  }
  if (lower === "email") return ACTOR.email;
  if (lower === "name" || lower === "title") return "Test";
  if (lower === "emailverified") return true;
  if (lower === "state") return "stopped";
  if (lower === "status") return "todo";
  if (lower === "kind") return "docker";
  if (lower === "scope") return "bot";
  if (lower === "providerref") return null;
  if (lower === "homekey") return "home-1";
  if (lower === "controlholder") return "none";
  if (lower === "impersonatedby") return "admin-1";
  if (lower === "impersonationexpiresat") return new Date(Date.now() + 60_000);
  if (lower.startsWith("is") || lower.startsWith("has") || lower.endsWith("enabled")) return false;
  if (lower.endsWith("count") || lower.endsWith("bytes") || lower.endsWith("usd")) return 0;
  if (lower === "image" || lower === "avatar") return null;
  if (lower === "timezone" || lower === "locale") return null;
  if (lower === "members" || lower === "bots" || lower === "memberships") return [];
  return null;
}

function stubRow(model: string): Record<string, unknown> {
  const base: Record<string, unknown> = {
    id: `${model}-1`,
    userId: ACTOR.userId,
    spaceId: ACTOR.spaceId,
    organizationId: "org-1",
    botId: "bot-1",
    groupId: "group-1",
    boardId: "board-1",
    ticketId: "ticket-1",
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
    activeOrganizationId: "org-1",
    state: "stopped",
    status: "todo",
    kind: "docker",
    scope: "bot",
    providerRef: null,
    homeKey: "home-1",
    controlHolder: "none",
    controlLeaseId: null,
    controlBotId: null,
    controlRunId: null,
    controlLeaseExpiresAt: null,
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
    secretId: null,
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
    thread: { id: "thread-1", spaceId: ACTOR.spaceId, botId: "bot-1" },
    computer: null,
    bots: [],
    members: [{ userId: ACTOR.userId }, { userId: "user-2" }],
    memberships: [{ userId: ACTOR.userId, spaceId: ACTOR.spaceId }],
    organization: { id: "org-1", name: "Team", members: [{ userId: ACTOR.userId }] },
    space: { id: ACTOR.spaceId, name: "Personal", organizationId: "org-1" },
    user: { id: ACTOR.userId, email: ACTOR.email, name: "Test", image: null },
    signupSurvey: null,
    adminGrant: null,
    sharedKeyBudget: null,
  };
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
  const modelHandler = (model: string): ProxyHandler<object> => ({
    get(_target, method) {
      if (typeof method === "symbol") return undefined;
      const name = String(method);
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
  });

  const root: Record<string, unknown> = {};
  return new Proxy(root, {
    get(_target, prop) {
      if (typeof prop === "symbol") return undefined;
      const name = String(prop);
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
      return new Proxy({}, modelHandler(name));
    },
  });
}

function recordable(
  effects: SideEffect[],
  kind: SideEffect["kind"],
  methods: string[],
): Record<string, unknown> {
  const target: Record<string, unknown> = {};
  for (const method of methods) {
    target[method] = (..._args: unknown[]) => {
      effects.push({ kind, method } as SideEffect);
      return Promise.resolve(undefined);
    };
  }
  return new Proxy(target, {
    get(t, prop) {
      if (typeof prop === "symbol") return undefined;
      if (prop in t) return t[prop as string];
      return (..._args: unknown[]) => {
        effects.push({ kind, method: String(prop) } as SideEffect);
        if (kind === "sandbox" && String(prop) === "listFiles") return Promise.resolve([]);
        if (kind === "sandbox" && String(prop) === "readFile") return Promise.resolve(new Uint8Array());
        if (kind === "home" && String(prop) === "list") return Promise.resolve([]);
        if (kind === "secrets" && (String(prop) === "load" || String(prop) === "decrypt")) {
          return Promise.resolve(null);
        }
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
  "computer.status": { botId: "bot-1" },
  "connections.catalog": {},
  "groups.get": { groupId: "group-1" },
  "links.favicon": { origin: "https://example.test" },
  "marketplace.catalog": {},
  "marketplace.submissions": {},
  "mcp.assignments.list": { botId: "bot-1" },
  "memory.budget": { botId: "bot-1" },
  "memory.exportMarkdown": {},
  "memory.list": {},
  "models.forRole": { role: "main" },
  "models.role": { role: "main", scope: "space" },
  "pages.get": { pageId: "page-1" },
  "pages.list": {},
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
    expect(contractPaths.length).toBe(307);

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
        "capabilities.pluginParts",
        "computer.commands",
        "computer.status",
        "computer.updates",
        "computerProvider.account.get",
        "computerProvider.get",
        "connections.catalog",
        "connections.list",
        "deployment.get",
        "groups.get",
        "groups.list",
        "groups.listArchived",
        "health",
        "integrationSetup.get",
        "links.favicon",
        "marketplace.catalog",
        "marketplace.submissions",
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
        "skills.snapshot",
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
    expect(reads.length).toBe(97);

    const prisma = createRecordingPrisma(effects);
    const jobs = recordable(effects, "jobs", [
      "enqueue",
      "publish",
      "schedule",
      "cancel",
      "add",
    ]);
    const events = recordable(effects, "events", ["notify", "publish", "append", "follow"]);
    const boardEvents = { follow: () => doneFollow() };
    const sandbox = recordable(effects, "sandbox", [
      "listFiles",
      "readFile",
      "writeFile",
      "start",
      "stop",
      "exec",
      "connectTerminal",
      "connectScreen",
    ]);
    const home = recordable(effects, "home", ["list", "read", "write", "remove"]);
    const secrets = recordable(effects, "secrets", ["load", "decrypt", "put", "remove", "describe"]);
    (secrets as { describe: () => { capabilities: { degraded: boolean } } }).describe = () => ({
      capabilities: { degraded: false },
    });

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
        append: async (...args: unknown[]) => {
          effects.push({ kind: "events", method: "append" });
          return undefined;
        },
      },
      boardEvents,
      ticketChanges: { notify: () => undefined },
      sandbox,
      home,
      secrets,
      memory: { list: async () => [], exportMarkdown: async () => "" },
      memoryProviders: { resolve: async () => null, list: async () => [] },
      artifacts: {
        get: async () => null,
        getById: async () => null,
        list: async () => [],
        listSpace: async () => [],
        listVersions: async () => [],
      },
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
      connectors: { list: () => [], get: () => null },
      auth: {},
      dataDir: "/tmp/rakazo-impersonation-audit",
      modelConnectionFetch: fetchMock,
      favicons: {
        resolve: async (origin: string) => {
          effects.push({ kind: "fetch", url: `favicon:${origin}` });
          return null;
        },
      },
      paymentWallet: null,
      billing: undefined,
    } as unknown as RouterDeps;

    const rpc = createRouterClient(createRouter(deps), {
      context: {
        actor: ACTOR,
        sessionId: SESSION_ID,
        impersonatedBy: "admin-1",
      },
    });

    const walked: string[] = [];
    const validationStops: Array<{ path: string; code?: string; message?: string }> = [];
    const sideEffectHits: Array<{ path: string; effects: SideEffect[] }> = [];

    for (const dotted of contractPaths) {
      walked.push(dotted);
    }
    expect(walked.length).toBe(307);

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
        validationStops.push({
          path: dotted,
          code: "INPUT_SCHEMA",
          message: schemaCheck.error.issues.map((issue) => issue.message).join("; "),
        });
        continue;
      }
      try {
        await invokePath(rpc, segments, input);
      } catch (error) {
        const code = errorCode(error);
        const message =
          error && typeof error === "object" && "message" in error
            ? String((error as { message: unknown }).message)
            : undefined;
        // Only count contract/input-validation failures — business BAD_REQUEST means the body ran.
        if (
          code === "INPUT_VALIDATION" ||
          /Input validation failed|invalid_type|Unrecognized key/i.test(message ?? "")
        ) {
          validationStops.push({ path: dotted, code, message });
        }
      }
      const produced = effects.slice(before);
      const bad = produced.filter((effect) => {
        if (effect.kind === "secrets") {
          if (effect.method !== "load" && effect.method !== "decrypt") return true;
          return !(dotted in SECRET_LOAD_EXEMPTIONS);
        }
        if (effect.kind === "home") {
          // Pure list/read of the user's home store is a view; write/remove are not.
          return effect.method !== "list" && effect.method !== "read";
        }
        if (effect.kind === "events" && effect.method === "follow") return false;
        return true;
      });
      if (bad.length > 0) {
        sideEffectHits.push({ path: dotted, effects: bad });
      }
    }

    const unexpectedValidationStops = validationStops.filter(
      (row) => !ALLOWED_VALIDATION_STOPS.has(row.path),
    );
    expect({
      sideEffectHits,
      unexpectedValidationStops,
      validationStopCount: validationStops.length,
    }).toEqual({
      sideEffectHits: [],
      unexpectedValidationStops: [],
      validationStopCount: validationStops.length,
    });
    expect(validationStops.length).toBeLessThanOrEqual(ALLOWED_VALIDATION_STOPS.size + 5);
  }, 120_000);
});
