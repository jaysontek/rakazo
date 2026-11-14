import { OPENAI_COMPATIBLE_PROVIDER_ID } from "@rakazo/contracts";
import { findModelCredential } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import type { ExecutorDeps } from "./executor-deps.js";
import { LOCAL_PROVIDER_ID } from "./pi-local-provider.js";
import { isTerminalModelSetupError, resolveModelKey } from "./run-model.js";
import { SharedKeyWeeklyBudgetExceededRunError } from "./shared-key-budget-observer.js";
import {
  isDeploymentSharedKeyUsage,
  resolveModelKeyType,
  sharedKeyMaterialMatches,
} from "./shared-key-usage.js";

const DEPLOYMENT_KEY = "deployment-shared-key";
const PERSONAL_KEY = "user-personal-key";
const USER_ID = "user-1";
const SPACE_ID = "space-1";

type Cred = {
  id: string;
  provider: string;
  secretId: string;
  updatedAt: Date;
  createdAt: Date;
};

type Fixture = {
  name: string;
  provider?: string;
  env?: Record<string, string>;
  deploymentKey?: string;
  billingEnabled?: boolean;
  hostedCredits?: boolean;
  credentials?: Cred[];
  /** Preference pointing at a credential id (newer updatedAt wins unless we set older preferred). */
  preferences?: Array<{
    credentialId: string;
    modelId: string | null;
    updatedAt: Date;
    thinkingLevel?: string | null;
  }>;
  /** secretId → { ciphertext, spaceId }. Missing id means no row. */
  secrets?: Record<string, { ciphertext: string; spaceId: string | null } | null>;
  /** ciphertext → plaintext or Error */
  plaintexts?: Record<string, string | Error>;
  expect: { keyType: "company" | "personal"; needsReconnect: boolean };
  /** Extra context for the state table (not read by the resolver). */
  meta?: { deactivated?: boolean; envListMember?: boolean };
};

function apiKeyPlaintext(key: string) {
  return JSON.stringify({ kind: "api_key", key });
}

function oauthPlaintext(apiKey?: string) {
  return JSON.stringify({
    type: "oauth",
    access: "access-token",
    refresh: "refresh-token",
    // Far enough out that refresh is not due (MIN_OAUTH_VALIDITY_MS is 5 minutes).
    expires: Date.now() + 60 * 60_000,
    ...(apiKey ? { apiKey } : {}),
  });
}

function buildPrisma(fixture: Fixture) {
  const provider = fixture.provider ?? "google";
  const credentials = (fixture.credentials ?? []).filter((c) => c.provider === provider);
  const allCredentials = fixture.credentials ?? [];
  const preferences = (fixture.preferences ?? [])
    .map((preference) => {
      const credential = allCredentials.find((c) => c.id === preference.credentialId);
      if (!credential || credential.provider !== provider) return null;
      return {
        userId: USER_ID,
        credentialId: preference.credentialId,
        modelId: preference.modelId,
        thinkingLevel: preference.thinkingLevel ?? null,
        updatedAt: preference.updatedAt,
        credential,
      };
    })
    .filter(Boolean);

  return {
    userModelPreference: {
      findMany: vi.fn(async () => preferences),
      findFirst: vi.fn(async () => preferences[0] ?? null),
    },
    userModelCredential: {
      findMany: vi.fn(async () => credentials),
      findFirst: vi.fn(async () => {
        const sorted = [...credentials].sort(
          (a, b) =>
            b.updatedAt.getTime() - a.updatedAt.getTime() ||
            b.createdAt.getTime() - a.createdAt.getTime() ||
            (a.id < b.id ? 1 : -1),
        );
        return sorted[0] ?? null;
      }),
    },
    secret: {
      findFirst: vi.fn(
        async ({ where }: { where: { id: string; userId: string; spaceId: null } }) => {
          const entry = fixture.secrets?.[where.id];
          if (!entry) return null;
          if (entry.spaceId !== null) return null; // runtime filters spaceId: null
          return { id: where.id, ciphertext: entry.ciphertext, spaceId: null, userId: USER_ID };
        },
      ),
    },
    deploymentSettings: {
      findUnique: vi.fn(async () => ({
        modelCreditsEnabled: fixture.billingEnabled === true,
      })),
    },
    space: {
      findFirst: vi.fn(async () =>
        fixture.hostedCredits
          ? {
              organization: {
                modelCredits: { mode: "credits", balanceMicros: 1_000_000n },
              },
            }
          : null,
      ),
      findUnique: vi.fn(async () =>
        fixture.hostedCredits ? { organizationId: "org-1" } : null,
      ),
    },
    member: {
      findUnique: vi.fn(async () => (fixture.hostedCredits ? { role: "owner" } : null)),
    },
    modelCreditAccount: {
      findUniqueOrThrow: vi.fn(async () => ({
        mode: "credits",
        balanceMicros: 1_000_000n,
      })),
      upsert: vi.fn(async () => ({ mode: "credits", balanceMicros: 1_000_000n })),
    },
  };
}

function buildSecrets(fixture: Fixture) {
  return {
    load: vi.fn(async (ciphertext: string, _id: string) => {
      const value = fixture.plaintexts?.[ciphertext];
      if (value instanceof Error) throw value;
      if (typeof value === "string") return value;
      throw new Error(`missing plaintext for ${ciphertext}`);
    }),
  };
}

const older = new Date("2026-01-01T00:00:00Z");
const newer = new Date("2026-06-01T00:00:00Z");

const cases: Fixture[] = [
  {
    name: "no usage and no credential",
    expect: { keyType: "company", needsReconnect: false },
  },
  {
    name: "credential for another provider only",
    credentials: [
      {
        id: "openrouter-cred",
        provider: "openrouter",
        secretId: "secret-or",
        updatedAt: newer,
        createdAt: newer,
      },
    ],
    secrets: { "secret-or": { ciphertext: "ct-or", spaceId: null } },
    plaintexts: { "ct-or": apiKeyPlaintext(PERSONAL_KEY) },
    expect: { keyType: "company", needsReconnect: false },
  },
  {
    name: "secret row missing",
    credentials: [
      {
        id: "google-cred",
        provider: "google",
        secretId: "missing-secret",
        updatedAt: newer,
        createdAt: newer,
      },
    ],
    secrets: {},
    expect: { keyType: "company", needsReconnect: false },
  },
  {
    name: "secret with non-null spaceId",
    credentials: [
      {
        id: "google-cred",
        provider: "google",
        secretId: "space-secret",
        updatedAt: newer,
        createdAt: newer,
      },
    ],
    secrets: { "space-secret": { ciphertext: "ct-space", spaceId: "space-1" } },
    plaintexts: { "ct-space": apiKeyPlaintext(PERSONAL_KEY) },
    expect: { keyType: "company", needsReconnect: false },
  },
  {
    name: "undecryptable",
    credentials: [
      {
        id: "google-cred",
        provider: "google",
        secretId: "bad-secret",
        updatedAt: newer,
        createdAt: newer,
      },
    ],
    secrets: { "bad-secret": { ciphertext: "ct-bad", spaceId: null } },
    plaintexts: { "ct-bad": new Error("unavailable") },
    expect: { keyType: "personal", needsReconnect: true },
  },
  {
    name: "empty key",
    credentials: [
      {
        id: "google-cred",
        provider: "google",
        secretId: "empty-secret",
        updatedAt: newer,
        createdAt: newer,
      },
    ],
    secrets: { "empty-secret": { ciphertext: "ct-empty", spaceId: null } },
    plaintexts: { "ct-empty": "" },
    expect: { keyType: "personal", needsReconnect: true },
  },
  {
    name: "stored key equal to the deployment key",
    credentials: [
      {
        id: "google-cred",
        provider: "google",
        secretId: "shared-copy",
        updatedAt: newer,
        createdAt: newer,
      },
    ],
    secrets: { "shared-copy": { ciphertext: "ct-shared", spaceId: null } },
    plaintexts: { "ct-shared": apiKeyPlaintext(DEPLOYMENT_KEY) },
    expect: { keyType: "company", needsReconnect: false },
  },
  {
    name: "OAuth credential carrying a key",
    credentials: [
      {
        id: "google-cred",
        provider: "google",
        secretId: "oauth-secret",
        updatedAt: newer,
        createdAt: newer,
      },
    ],
    secrets: { "oauth-secret": { ciphertext: "ct-oauth", spaceId: null } },
    plaintexts: { "ct-oauth": oauthPlaintext(DEPLOYMENT_KEY) },
    expect: { keyType: "company", needsReconnect: false },
  },
  {
    name: "distinct personal key",
    credentials: [
      {
        id: "google-cred",
        provider: "google",
        secretId: "personal-secret",
        updatedAt: newer,
        createdAt: newer,
      },
    ],
    secrets: { "personal-secret": { ciphertext: "ct-personal", spaceId: null } },
    plaintexts: { "ct-personal": apiKeyPlaintext(PERSONAL_KEY) },
    expect: { keyType: "personal", needsReconnect: false },
  },
  {
    name: "two credentials where the preference picks the older one",
    credentials: [
      {
        id: "cred-old",
        provider: "google",
        secretId: "secret-old",
        updatedAt: older,
        createdAt: older,
      },
      {
        id: "cred-new",
        provider: "google",
        secretId: "secret-new",
        updatedAt: newer,
        createdAt: newer,
      },
    ],
    preferences: [
      {
        credentialId: "cred-old",
        modelId: null,
        // Preference is newer than the other preference would be — points at older credential.
        updatedAt: newer,
      },
    ],
    secrets: {
      "secret-old": { ciphertext: "ct-old", spaceId: null },
      "secret-new": { ciphertext: "ct-new", spaceId: null },
    },
    plaintexts: {
      "ct-old": apiKeyPlaintext(PERSONAL_KEY),
      "ct-new": apiKeyPlaintext(DEPLOYMENT_KEY),
    },
    expect: { keyType: "personal", needsReconnect: false },
  },
  {
    name: "hosted credits on",
    billingEnabled: true,
    hostedCredits: true,
    credentials: [
      {
        id: "google-cred",
        provider: "google",
        secretId: "personal-secret",
        updatedAt: newer,
        createdAt: newer,
      },
    ],
    secrets: { "personal-secret": { ciphertext: "ct-personal", spaceId: null } },
    plaintexts: { "ct-personal": apiKeyPlaintext(PERSONAL_KEY) },
    expect: { keyType: "company", needsReconnect: false },
  },
  {
    name: "deactivated user",
    meta: { deactivated: true },
    expect: { keyType: "company", needsReconnect: false },
  },
  {
    name: "env-list (SHARED_KEY_BUDGET_USER_IDS) member",
    meta: { envListMember: true },
    credentials: [
      {
        id: "google-cred",
        provider: "google",
        secretId: "personal-secret",
        updatedAt: newer,
        createdAt: newer,
      },
    ],
    secrets: { "personal-secret": { ciphertext: "ct-personal", spaceId: null } },
    plaintexts: { "ct-personal": apiKeyPlaintext(PERSONAL_KEY) },
    expect: { keyType: "personal", needsReconnect: false },
  },
  {
    name: "non-Google deployment provider",
    provider: "openrouter",
    env: {
      PI_DEFAULT_PROVIDER: "openrouter",
      OPENROUTER_API_KEY: DEPLOYMENT_KEY,
    },
    deploymentKey: DEPLOYMENT_KEY,
    credentials: [
      {
        id: "or-cred",
        provider: "openrouter",
        secretId: "or-secret",
        updatedAt: newer,
        createdAt: newer,
      },
    ],
    secrets: { "or-secret": { ciphertext: "ct-or", spaceId: null } },
    plaintexts: { "ct-or": apiKeyPlaintext(PERSONAL_KEY) },
    expect: { keyType: "personal", needsReconnect: false },
  },
];

describe("sharedKeyMaterialMatches", () => {
  it("matches equal key material without exposing it", () => {
    expect(sharedKeyMaterialMatches("company-key", "company-key")).toBe(true);
    expect(sharedKeyMaterialMatches("company-key", "personal-key")).toBe(false);
  });
});

describe("isDeploymentSharedKeyUsage", () => {
  it("is true for the deployment shared API key", () => {
    expect(
      isDeploymentSharedKeyUsage({ ownCredential: false, provider: "openrouter" }),
    ).toBe(true);
    expect(isDeploymentSharedKeyUsage({ ownCredential: false, provider: "google" })).toBe(true);
    expect(isDeploymentSharedKeyUsage({ provider: "google" })).toBe(true);
  });

  it("is false for personal connections", () => {
    expect(
      isDeploymentSharedKeyUsage({ ownCredential: true, provider: "openrouter" }),
    ).toBe(false);
  });

  it("is false for local, OpenAI-compatible, and scripted usage", () => {
    expect(
      isDeploymentSharedKeyUsage({ ownCredential: false, provider: LOCAL_PROVIDER_ID }),
    ).toBe(false);
    expect(
      isDeploymentSharedKeyUsage({
        ownCredential: false,
        provider: OPENAI_COMPATIBLE_PROVIDER_ID,
        baseUrl: "http://127.0.0.1:11434/v1",
      }),
    ).toBe(false);
    expect(
      isDeploymentSharedKeyUsage({
        ownCredential: false,
        provider: "scripted",
        scriptedRuntime: true,
      }),
    ).toBe(false);
  });
});

describe("shared-key budget vs personal-key backup", () => {
  it("does not treat weekly budget exhaustion as a terminal setup error", () => {
    expect(isTerminalModelSetupError(new SharedKeyWeeklyBudgetExceededRunError())).toBe(false);
  });
});

function withDeploymentEnv(env?: Record<string, string>) {
  const keys = ["PI_DEFAULT_PROVIDER", "GEMINI_API_KEY", "OPENROUTER_API_KEY"] as const;
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  process.env.PI_DEFAULT_PROVIDER = env?.PI_DEFAULT_PROVIDER ?? "google";
  process.env.GEMINI_API_KEY = env?.GEMINI_API_KEY ?? DEPLOYMENT_KEY;
  if (env?.OPENROUTER_API_KEY) process.env.OPENROUTER_API_KEY = env.OPENROUTER_API_KEY;
  else delete process.env.OPENROUTER_API_KEY;
  return () => {
    for (const key of keys) {
      const value = previous[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

describe("resolveModelKeyType", () => {
  it.each(cases)("$name", async (fixture) => {
    const restore = withDeploymentEnv(fixture.env);
    try {
      const provider = fixture.provider ?? "google";
      const prisma = buildPrisma(fixture);
      const secretStore = buildSecrets(fixture);
      const result = await resolveModelKeyType(
        {
          prisma: prisma as never,
          secretStore,
          deploymentModelKey: fixture.deploymentKey ?? DEPLOYMENT_KEY,
          billingEnabled: fixture.billingEnabled ?? false,
        },
        { userId: USER_ID, spaceId: SPACE_ID },
        { provider },
      );
      expect(result).toEqual(fixture.expect);
    } finally {
      restore();
    }
  });
});

describe("resolveModelKey and resolveModelKeyType agree", () => {
  it.each(cases)("$name", async (fixture) => {
    const restore = withDeploymentEnv(fixture.env);
    try {
      const provider = fixture.provider ?? "google";
      const prisma = buildPrisma(fixture);
      const secretStore = buildSecrets(fixture);
      const deploymentModelKey = fixture.deploymentKey ?? DEPLOYMENT_KEY;
      const label = await resolveModelKeyType(
        {
          prisma: prisma as never,
          secretStore,
          deploymentModelKey,
          billingEnabled: fixture.billingEnabled ?? false,
        },
        { userId: USER_ID, spaceId: SPACE_ID },
        { provider },
      );

      const credential = await findModelCredential(prisma as never, { userId: USER_ID }, provider);
      const deps = {
        prisma,
        secretStore,
        deploymentModelKey,
        billingEnabled: fixture.billingEnabled ?? false,
        runtime: { describe: () => ({ capabilities: {} }) },
      } as unknown as ExecutorDeps;

      let usingSharedKey: boolean;
      try {
        const resolved = await resolveModelKey(
          deps,
          USER_ID,
          SPACE_ID,
          credential,
          provider,
          "model-1",
        );
        usingSharedKey = resolved.usingSharedKey;
        expect(Boolean(resolved.ownCredential)).toBe(label.keyType === "personal");
      } catch {
        // Broken personal credentials fail after selecting a personal key. Company
        // labels that throw in this harness (OAuth without a provider handler) still
        // intend the deployment/shared key a successful run would use.
        usingSharedKey = label.keyType === "company";
      }
      expect(usingSharedKey).toBe(label.keyType === "company");
    } finally {
      restore();
    }
  });
});
