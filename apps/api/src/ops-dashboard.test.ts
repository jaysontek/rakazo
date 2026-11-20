import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  listOpsAgents,
  listOpsOrganizations,
  loadOpsOverview,
  loadOpsTeam,
} from "./ops-dashboard.js";

type UserRow = {
  id: string;
  email: string;
  name: string;
  deactivatedAt: Date | null;
  deletionRequestedAt?: Date | null;
  purgeAfter?: Date | null;
};

type CredSpec = {
  userId: string;
  id: string;
  provider: string;
  secretId: string;
  plaintext?: string | Error;
  spaceId?: string | null;
};

function opsPrisma(
  users: UserRow[],
  options: {
    members?: string[];
    notEnrolledHits?: string[];
    credentials?: CredSpec[];
    hostedCreditUserIds?: string[];
  } = {},
) {
  const credentials = options.credentials ?? [];
  const secretById = new Map(
    credentials.map((cred) => [
      cred.secretId,
      {
        id: cred.secretId,
        userId: cred.userId,
        spaceId: cred.spaceId ?? null,
        ciphertext: `ct-${cred.secretId}`,
        plaintext: cred.plaintext,
      },
    ]),
  );

  const prisma = {
    user: {
      findMany: vi.fn(async () => users),
    },
    usageRecord: {
      groupBy: vi.fn(async () => []),
      findMany: vi.fn(async () => []),
      aggregate: vi.fn(async () => ({ _sum: { costUsd: 0 } })),
    },
    bot: {
      findMany: vi.fn(async () =>
        users
          .filter(
            (user) =>
              !user.email.endsWith("@builddrive.net") && !user.email.endsWith(".builddrive.net"),
          )
          .map((user) => ({
            id: `bot-${user.id}`,
            name: `${user.name} bot`,
            userId: user.id,
            spaceId: "space",
            modelProvider: null,
            modelId: null,
            archivedAt: null,
          })),
      ),
    },
    run: {
      findMany: vi.fn(async () => [
        {
          userId: users[0]?.id,
          status: "completed",
          error: null,
          createdAt: new Date("2026-11-05T12:00:00Z"),
          startedAt: null,
          firstResponseAt: null,
          completedAt: null,
          sourceMessage: null,
        },
      ]),
    },
    deploymentSettings: {
      findUnique: vi.fn(async () => ({
        sharedKeyMonthlyBudgetUsd: null,
        modelCreditsEnabled: Boolean(options.hostedCreditUserIds?.length),
      })),
    },
    sharedKeyBudgetMember: {
      findMany: vi.fn(async () => (options.members ?? []).map((userId) => ({ userId }))),
      findUnique: vi.fn(async ({ where }: { where: { userId: string } }) =>
        (options.members ?? []).includes(where.userId) ? { userId: where.userId } : null,
      ),
    },
    sharedKeyBudgetEnrollmentRequest: {
      findMany: vi.fn(async () => (options.notEnrolledHits ?? []).map((userId) => ({ userId }))),
    },
    sharedKeyWeekAllotment: {
      findMany: vi.fn(async () => []),
      findUnique: vi.fn(async () => null),
      updateMany: vi.fn(async () => ({ count: 0 })),
      upsert: vi.fn(async () => ({})),
      update: vi.fn(async () => ({})),
      deleteMany: vi.fn(async () => ({ count: 0 })),
    },
    sharedKeyAllotmentTransfer: {
      findMany: vi.fn(async () => []),
    },
    sharedKeyMemberOverride: {
      findMany: vi.fn(async () => []),
    },
    sharedKeySpendAdjustment: {
      findMany: vi.fn(async () => []),
      aggregate: vi.fn(async () => ({ _sum: { deltaUsd: 0 } })),
      groupBy: vi.fn(async () => []),
    },
    adminGrant: {
      findMany: vi.fn(async () => []),
    },
    spaceMember: {
      findMany: vi.fn(async () =>
        users.map((user) => ({ userId: user.id, spaceId: "space", createdAt: new Date() })),
      ),
    },
    userModelPreference: {
      findMany: vi.fn(async () => []),
      findFirst: vi.fn(async () => null),
    },
    userModelRoleChoice: {
      findMany: vi.fn(async () => []),
    },
    spaceModelRoleChoice: {
      findMany: vi.fn(async () => []),
    },
    userModelCredential: {
      findMany: vi.fn(async ({ where }: { where: { userId: string; provider?: unknown } }) =>
        credentials
          .filter((cred) => cred.userId === where.userId)
          .filter((_cred) => {
            // provider filter is an object from modelCredentialProviderFilter; match google loosely.
            return true;
          })
          .map((cred) => ({
            id: cred.id,
            userId: cred.userId,
            provider: cred.provider,
            secretId: cred.secretId,
            updatedAt: new Date("2026-06-01T00:00:00Z"),
            createdAt: new Date("2026-06-01T00:00:00Z"),
          })),
      ),
      findFirst: vi.fn(async ({ where }: { where: { userId: string; provider?: string } }) => {
        const match = credentials.find(
          (cred) =>
            cred.userId === where.userId &&
            (where.provider == null || cred.provider === where.provider),
        );
        return match
          ? {
              id: match.id,
              userId: match.userId,
              provider: match.provider,
              secretId: match.secretId,
              updatedAt: new Date("2026-06-01T00:00:00Z"),
              createdAt: new Date("2026-06-01T00:00:00Z"),
            }
          : null;
      }),
    },
    secret: {
      findFirst: vi.fn(
        async ({ where }: { where: { id: string; userId: string; spaceId: null } }) => {
          const row = secretById.get(where.id);
          if (!row || row.userId !== where.userId) return null;
          if (row.spaceId !== null) return null;
          return { id: row.id, ciphertext: row.ciphertext, spaceId: null, userId: row.userId };
        },
      ),
    },
    space: {
      findFirst: vi.fn(async ({ where }: { where: { id: string } }) => {
        // hasHostedModelCredits looks up the space; return credits for opted-in users only
        // when membership matches — we key off space id "space" for everyone and gate below.
        if (where.id !== "space") return null;
        return {
          organization: {
            modelCredits: { mode: "credits", balanceMicros: 1_000_000n },
            members: { some: true },
          },
        };
      }),
    },
    member: {
      findUnique: vi.fn(async () => ({ role: "owner" })),
    },
    modelCreditAccount: {
      findUniqueOrThrow: vi.fn(async () => ({ mode: "credits", balanceMicros: 1_000_000n })),
      upsert: vi.fn(async () => ({ mode: "credits", balanceMicros: 1_000_000n })),
    },
    usageLatestByUser: [] as Array<{ userId: string; provider: string; model: string }>,
    $queryRaw: vi.fn(async (query: { strings?: readonly string[] } | unknown) => {
      const text =
        query && typeof query === "object" && "strings" in query && Array.isArray(query.strings)
          ? query.strings.join(" ")
          : String(query ?? "");
      if (text.includes("usage_records") && text.includes("DISTINCT ON")) {
        return prisma.usageLatestByUser;
      }
      return [{ "?column?": 1 }];
    }),
    $executeRaw: vi.fn(async () => 0),
    $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(prisma)),
    secretsLoad: async (ciphertext: string) => {
      for (const row of secretById.values()) {
        if (row.ciphertext === ciphertext) {
          if (row.plaintext instanceof Error) throw row.plaintext;
          if (typeof row.plaintext === "string") return row.plaintext;
          throw new Error("missing plaintext");
        }
      }
      throw new Error("unknown ciphertext");
    },
  };
  return prisma;
}

function apiKeyPlaintext(key: string) {
  return JSON.stringify({ kind: "api_key", key });
}

describe("loadOpsOverview", () => {
  it("resolves a model for every account: latest usage, configured, or deployment default", async () => {
    const prisma = opsPrisma([
      { id: "user-a", email: "a@example.test", name: "Heavy", deactivatedAt: null },
      { id: "user-b", email: "b@example.test", name: "Old", deactivatedAt: null },
      { id: "user-c", email: "c@example.test", name: "Fresh", deactivatedAt: null },
    ]);
    // User A would have filled a global take:2000 window; DISTINCT ON still returns one row.
    prisma.usageLatestByUser = [
      { userId: "user-a", provider: "google", model: "gemini-3.8-flash" },
      { userId: "user-b", provider: "openai", model: "gpt-4.1" },
    ];
    // User C has no usage — fall through to deployment default via resolveDeploymentModel.
    prisma.userModelRoleChoice.findMany = vi.fn(async () => []);
    prisma.userModelPreference.findMany = vi.fn(async () => []);
    prisma.spaceModelRoleChoice.findMany = vi.fn(async () => []);

    const overview = await loadOpsOverview(
      prisma as never,
      {},
      new Date("2026-11-05T17:00:00.000Z"),
      null,
      { deploymentModelKey: "deployment-key" },
    );

    const byId = new Map(overview.accounts.map((row) => [row.userId, row]));
    expect(byId.get("user-a")).toMatchObject({
      modelProvider: "google",
      modelId: "gemini-3.8-flash",
      modelSource: "last used",
    });
    expect(byId.get("user-b")).toMatchObject({
      modelProvider: "openai",
      modelId: "gpt-4.1",
      modelSource: "last used",
    });
    const fresh = byId.get("user-c");
    expect(fresh?.modelProvider).toBeTruthy();
    expect(fresh?.modelId).toBeTruthy();
    expect(fresh?.modelSource).toBe("default");
  });

  it("filters builddrive.net accounts out of the overview", async () => {
    const prisma = opsPrisma([
      { id: "visible", email: "user@tekweld.com", name: "User", deactivatedAt: null },
      { id: "hidden", email: "ops@builddrive.net", name: "Hidden", deactivatedAt: null },
      {
        id: "hidden-sub",
        email: "dev@corp.builddrive.net",
        name: "Sub",
        deactivatedAt: null,
      },
    ]);

    const overview = await loadOpsOverview(
      prisma as never,
      {},
      new Date("2026-11-05T17:00:00.000Z"),
      null,
    );

    expect(overview.accounts.map((row) => row.email)).toEqual(["user@tekweld.com"]);
    expect(overview.agents.names.map((bot) => bot.id)).toEqual(["bot-visible"]);
    expect(overview.performance.runCount).toBe(1);
    expect(overview.performance.errorCount).toBe(0);
  });

  it("never returns a missing or none keyType, including users with zero usage rows", async () => {
    const prisma = opsPrisma([
      { id: "zero-usage", email: "fresh@example.test", name: "Fresh", deactivatedAt: null },
      { id: "also-zero", email: "also@example.test", name: "Also", deactivatedAt: null },
    ]);

    const overview = await loadOpsOverview(
      prisma as never,
      {},
      new Date("2026-11-05T17:00:00.000Z"),
      null,
      {
        deploymentModelKey: "deployment-key",
        secrets: {
          load: async () => {
            throw new Error("unused");
          },
        } as never,
      },
    );

    expect(overview.accounts).toHaveLength(2);
    for (const account of overview.accounts) {
      expect(account.keyType === "company" || account.keyType === "personal").toBe(true);
      expect(account.keyType).not.toBe("none");
      expect(account.keyType.length).toBeGreaterThan(0);
      expect(typeof account.needsReconnect).toBe("boolean");
    }
    expect(overview.accounts.every((account) => account.keyType === "company")).toBe(true);
  });

  describe("pendingSharedBudgetApproval", () => {
    const now = new Date("2026-11-05T17:00:00.000Z");
    const budgetUsd = 400;

    beforeEach(() => {
      // Ops resolves key type for the deployment provider (no explicit provider).
      vi.stubEnv("PI_DEFAULT_PROVIDER", "google");
      vi.stubEnv("GEMINI_API_KEY", "deployment-key");
    });
    afterEach(() => {
      vi.unstubAllEnvs();
    });

    async function load(options: {
      users: UserRow[];
      members?: string[];
      notEnrolledHits?: string[];
      credentials?: CredSpec[];
      hostedCreditUserIds?: string[];
      envBudget?: number | null;
      deploymentModelKey?: string;
    }) {
      const prisma = opsPrisma(options.users, {
        members: options.members,
        notEnrolledHits: options.notEnrolledHits,
        credentials: options.credentials,
        hostedCreditUserIds: options.hostedCreditUserIds,
      });
      // hasHostedModelCredits only for opted-in users: gate space.findFirst.
      const hosted = new Set(options.hostedCreditUserIds ?? []);
      prisma.space.findFirst = vi.fn(async () => null);
      // Re-bind hosted check via credential clear path: when hostedCreditUserIds set,
      // resolveModelKeyType reads hasHostedModelCredits which needs space + billing.
      if (hosted.size > 0) {
        prisma.deploymentSettings.findUnique = vi.fn(async () => ({
          sharedKeyMonthlyBudgetUsd: null,
          modelCreditsEnabled: true,
        }));
        prisma.space.findFirst = vi.fn(async ({ where }: { where: { id: string } }) => {
          // Ops picks spaceId "space" for every user; return credits only when the
          // caller is in the hosted set by checking credentials isn't enough — use
          // organization credits for all and rely on per-user billing+hosted tests
          // calling resolve with the right user. For pending tests we only need one
          // hosted user at a time, so always return credits when any are configured.
          if (where.id !== "space") return null;
          return {
            organization: {
              modelCredits: { mode: "credits", balanceMicros: 1_000_000n },
              members: { some: true },
            },
          };
        });
      }
      const envBudget = options.envBudget === undefined ? budgetUsd : options.envBudget;
      return loadOpsOverview(prisma as never, {}, now, envBudget, {
        deploymentModelKey: options.deploymentModelKey ?? "deployment-key",
        secrets: { load: prisma.secretsLoad } as never,
      });
    }

    it("a no-key non-member with no hit is not pending", async () => {
      const overview = await load({
        users: [{ id: "u1", email: "a@example.test", name: "A", deactivatedAt: null }],
      });
      expect(overview.accounts[0]?.keyType).toBe("company");
      expect(overview.accounts[0]?.pendingSharedBudgetApproval).toBe(false);
    });

    it("a no-key non-member with a hit is pending", async () => {
      const overview = await load({
        users: [{ id: "u1", email: "a@example.test", name: "A", deactivatedAt: null }],
        notEnrolledHits: ["u1"],
      });
      expect(overview.accounts[0]?.keyType).toBe("company");
      expect(overview.accounts[0]?.pendingSharedBudgetApproval).toBe(true);
    });

    it("a personal non-member with a hit is not pending", async () => {
      const overview = await load({
        users: [{ id: "u1", email: "a@example.test", name: "A", deactivatedAt: null }],
        notEnrolledHits: ["u1"],
        credentials: [
          {
            userId: "u1",
            id: "cred-1",
            provider: "google",
            secretId: "sec-1",
            plaintext: apiKeyPlaintext("personal-key"),
          },
        ],
      });
      expect(overview.accounts[0]?.keyType).toBe("personal");
      expect(overview.accounts[0]?.pendingSharedBudgetApproval).toBe(false);
    });

    it("a hosted-credit non-member with no hit is not pending", async () => {
      const overview = await load({
        users: [{ id: "u1", email: "a@example.test", name: "A", deactivatedAt: null }],
        hostedCreditUserIds: ["u1"],
        credentials: [
          {
            userId: "u1",
            id: "cred-1",
            provider: "google",
            secretId: "sec-1",
            plaintext: apiKeyPlaintext("personal-key"),
          },
        ],
      });
      expect(overview.accounts[0]?.keyType).toBe("company");
      expect(overview.accounts[0]?.pendingSharedBudgetApproval).toBe(false);
    });

    it("a member is never pending", async () => {
      const overview = await load({
        users: [{ id: "u1", email: "a@example.test", name: "A", deactivatedAt: null }],
        members: ["u1"],
        notEnrolledHits: ["u1"],
      });
      expect(overview.accounts[0]?.pendingSharedBudgetApproval).toBe(false);
    });

    it("with no budget configured, nobody is pending", async () => {
      const overview = await load({
        users: [{ id: "u1", email: "a@example.test", name: "A", deactivatedAt: null }],
        notEnrolledHits: ["u1"],
        envBudget: null,
      });
      expect(overview.accounts[0]?.pendingSharedBudgetApproval).toBe(false);
    });
  });

  it("classifies mixed key states in a single overview load", async () => {
    vi.stubEnv("PI_DEFAULT_PROVIDER", "google");
    vi.stubEnv("GEMINI_API_KEY", "deployment-key");
    try {
      const prisma = opsPrisma(
        [
          { id: "company", email: "company@example.test", name: "Company", deactivatedAt: null },
          { id: "personal", email: "personal@example.test", name: "Personal", deactivatedAt: null },
          { id: "broken", email: "broken@example.test", name: "Broken", deactivatedAt: null },
          { id: "pending", email: "pending@example.test", name: "Pending", deactivatedAt: null },
        ],
        {
          notEnrolledHits: ["pending"],
          credentials: [
            {
              userId: "personal",
              id: "cred-personal",
              provider: "google",
              secretId: "sec-personal",
              plaintext: apiKeyPlaintext("personal-key"),
            },
            {
              userId: "broken",
              id: "cred-broken",
              provider: "google",
              secretId: "sec-broken",
              plaintext: new Error("decrypt failed"),
            },
          ],
        },
      );
      // No hosted credits in this mix — company/personal/pending must come from credentials.
      prisma.space.findFirst = vi.fn(async () => null);

      const overview = await loadOpsOverview(
        prisma as never,
        {},
        new Date("2026-11-05T17:00:00.000Z"),
        400,
        {
          deploymentModelKey: "deployment-key",
          secrets: { load: prisma.secretsLoad } as never,
        },
      );

      const byId = Object.fromEntries(overview.accounts.map((row) => [row.userId, row]));
      expect(byId.company?.keyType).toBe("company");
      expect(byId.company?.needsReconnect).toBe(false);
      expect(byId.company?.pendingSharedBudgetApproval).toBe(false);

      expect(byId.personal?.keyType).toBe("personal");
      expect(byId.personal?.needsReconnect).toBe(false);

      expect(byId.broken?.keyType).toBe("personal");
      expect(byId.broken?.needsReconnect).toBe(true);

      expect(byId.pending?.keyType).toBe("company");
      expect(byId.pending?.pendingSharedBudgetApproval).toBe(true);

      for (const account of overview.accounts) {
        expect(account.keyType === "company" || account.keyType === "personal").toBe(true);
        expect(account.keyType.length).toBeGreaterThan(0);
      }
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("listOpsOrganizations", () => {
  it("omits sole-member Personal orgs from the Teams list", async () => {
    const prisma = {
      organization: {
        findMany: vi.fn(async () => [
          { id: "personal", name: "Personal", _count: { members: 1 } },
          { id: "solo-named", name: "Ada", _count: { members: 1 } },
          { id: "team", name: "Acme", _count: { members: 2 } },
          { id: "large", name: "Big Co", _count: { members: 5 } },
        ]),
      },
    };

    await expect(listOpsOrganizations(prisma as never)).resolves.toEqual([
      { id: "team", name: "Acme", memberCount: 2 },
      { id: "large", name: "Big Co", memberCount: 5 },
    ]);
  });
});

describe("loadOpsTeam", () => {
  it("refuses a Personal org accessed by id", async () => {
    const prisma = {
      organization: {
        findUnique: vi.fn(async () => ({
          id: "personal",
          name: "Personal",
          members: [{ userId: "user-1" }],
        })),
      },
    };

    await expect(loadOpsTeam(prisma as never, "personal")).rejects.toThrow(
      "Organization not found",
    );
  });

  it("refuses an org with duplicate membership rows for one user", async () => {
    const prisma = {
      organization: {
        findUnique: vi.fn(async () => ({
          id: "solo-dup",
          name: "Solo Dup",
          members: [{ userId: "user-1" }, { userId: "user-1" }],
        })),
      },
    };

    await expect(loadOpsTeam(prisma as never, "solo-dup")).rejects.toThrow(
      "Organization not found",
    );
  });
});

describe("listOpsAgents", () => {
  beforeEach(() => {
    vi.stubEnv("PI_DEFAULT_PROVIDER", "google");
    vi.stubEnv("GEMINI_API_KEY", "deployment-key");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  function agentsPrisma(args: {
    bots: Array<{
      id: string;
      name: string;
      userId: string;
      spaceId: string;
      createdAt: Date;
      archivedAt: Date | null;
    }>;
    users: UserRow[];
    lastActive?: Array<{ botId: string; createdAt: Date }>;
    credentials?: CredSpec[];
  }) {
    const base = opsPrisma(args.users, { credentials: args.credentials }) as ReturnType<
      typeof opsPrisma
    > & {
      run: { findMany: unknown; groupBy: ReturnType<typeof vi.fn> };
    };
    base.bot.findMany = vi.fn(async () => args.bots) as never;
    base.user.findMany = vi.fn(async ({ where }: { where?: { id?: { in: string[] } } } = {}) => {
      const ids = where?.id?.in;
      if (!ids) return args.users;
      return args.users.filter((user) => ids.includes(user.id));
    }) as never;
    base.run.groupBy = vi.fn(async ({ where }: { where?: { botId?: { in: string[] } } } = {}) => {
      const ids = new Set(where?.botId?.in ?? args.bots.map((bot) => bot.id));
      const byBot = new Map<string, Date>();
      for (const row of args.lastActive ?? []) {
        if (!ids.has(row.botId)) continue;
        const prev = byBot.get(row.botId);
        if (!prev || row.createdAt > prev) byBot.set(row.botId, row.createdAt);
      }
      return [...byBot.entries()].map(([botId, createdAt]) => ({
        botId,
        _max: { createdAt },
      }));
    });
    return base;
  }

  it("returns owners, orphans, deactivated owners, and null lastActiveAt without runs", async () => {
    const prisma = agentsPrisma({
      users: [
        { id: "alice", email: "alice@example.test", name: "Alice", deactivatedAt: null },
        {
          id: "gone",
          email: "gone@example.test",
          name: "Gone",
          deactivatedAt: new Date("2026-10-01T00:00:00Z"),
        },
      ],
      bots: [
        {
          id: "bot-alice",
          name: "Alice bot",
          userId: "alice",
          spaceId: "space",
          createdAt: new Date("2026-01-01T00:00:00Z"),
          archivedAt: null,
        },
        {
          id: "bot-archived",
          name: "Archived bot",
          userId: "alice",
          spaceId: "space",
          createdAt: new Date("2026-01-02T00:00:00Z"),
          archivedAt: new Date("2026-02-01T00:00:00Z"),
        },
        {
          id: "bot-deactivated",
          name: "Deactivated owner bot",
          userId: "gone",
          spaceId: "space",
          createdAt: new Date("2026-01-03T00:00:00Z"),
          archivedAt: null,
        },
        {
          id: "bot-orphan",
          name: "Orphan bot",
          userId: "missing-user",
          spaceId: "space",
          createdAt: new Date("2026-01-04T00:00:00Z"),
          archivedAt: null,
        },
      ],
      lastActive: [
        { botId: "bot-alice", createdAt: new Date("2026-11-01T12:00:00Z") },
        { botId: "bot-alice", createdAt: new Date("2026-11-05T09:00:00Z") },
      ],
    });

    const agents = await listOpsAgents(prisma as never, {
      deploymentModelKey: "deployment-key",
      secrets: { load: prisma.secretsLoad } as never,
    });

    expect(agents.map((row) => row.id)).toEqual([
      "bot-alice",
      "bot-archived",
      "bot-deactivated",
      "bot-orphan",
    ]);

    const byId = Object.fromEntries(agents.map((row) => [row.id, row]));
    expect(byId["bot-alice"]?.owner).toEqual({
      id: "alice",
      name: "Alice",
      email: "alice@example.test",
      deactivated: false,
    });
    expect(byId["bot-alice"]?.status).toBe("active");
    expect(byId["bot-alice"]?.lastActiveAt).toBe("2026-11-05T09:00:00.000Z");
    expect(byId["bot-alice"]?.createdAt).toBe("2026-01-01T00:00:00.000Z");
    expect(
      byId["bot-alice"]?.keyType === "company" || byId["bot-alice"]?.keyType === "personal",
    ).toBe(true);

    expect(byId["bot-archived"]?.status).toBe("archived");
    expect(byId["bot-archived"]?.lastActiveAt).toBeNull();

    expect(byId["bot-deactivated"]?.owner).toMatchObject({
      id: "gone",
      deactivated: true,
    });

    expect(byId["bot-orphan"]?.owner).toBeNull();
    expect(byId["bot-orphan"]?.lastActiveAt).toBeNull();
    expect(byId["bot-orphan"]?.status).toBe("active");
    expect(byId["bot-orphan"]?.keyType).toBe("company");

    expect(prisma.run.groupBy).toHaveBeenCalledWith(
      expect.objectContaining({
        by: ["botId"],
        _max: { createdAt: true },
      }),
    );
  });

  it("hides bots owned by builddrive.net accounts but keeps orphans", async () => {
    const prisma = agentsPrisma({
      users: [
        { id: "hidden", email: "ops@builddrive.net", name: "Hidden", deactivatedAt: null },
        { id: "visible", email: "user@example.test", name: "Visible", deactivatedAt: null },
      ],
      bots: [
        {
          id: "bot-hidden",
          name: "Hidden bot",
          userId: "hidden",
          spaceId: "space",
          createdAt: new Date("2026-01-01T00:00:00Z"),
          archivedAt: null,
        },
        {
          id: "bot-visible",
          name: "Visible bot",
          userId: "visible",
          spaceId: "space",
          createdAt: new Date("2026-01-02T00:00:00Z"),
          archivedAt: null,
        },
        {
          id: "bot-orphan",
          name: "Orphan bot",
          userId: "deleted-user",
          spaceId: "space",
          createdAt: new Date("2026-01-03T00:00:00Z"),
          archivedAt: null,
        },
      ],
    });

    const agents = await listOpsAgents(prisma as never, {
      deploymentModelKey: "deployment-key",
      secrets: { load: prisma.secretsLoad } as never,
    });

    expect(agents.map((row) => row.id)).toEqual(["bot-visible", "bot-orphan"]);
  });

  it("matches Accounts key labels when the oldest membership is credits and the bot space is not", async () => {
    const prisma = agentsPrisma({
      users: [{ id: "owner", email: "owner@example.test", name: "Owner", deactivatedAt: null }],
      bots: [
        {
          id: "bot-archived-other-space",
          name: "Archived elsewhere",
          userId: "owner",
          spaceId: "space-no-credits",
          createdAt: new Date("2026-01-01T00:00:00Z"),
          archivedAt: new Date("2026-02-01T00:00:00Z"),
        },
      ],
      credentials: [
        {
          userId: "owner",
          id: "cred-personal",
          provider: "google",
          secretId: "sec-personal",
          plaintext: apiKeyPlaintext("personal-key"),
        },
      ],
    });
    prisma.deploymentSettings.findUnique = vi.fn(async () => ({
      sharedKeyMonthlyBudgetUsd: null,
      modelCreditsEnabled: true,
    }));
    // Oldest membership is the credits space; a newer membership holds the archived bot.
    prisma.spaceMember.findMany = vi.fn(async () => [
      {
        userId: "owner",
        spaceId: "space-credits",
        createdAt: new Date("2026-01-01T00:00:00Z"),
      },
      {
        userId: "owner",
        spaceId: "space-no-credits",
        createdAt: new Date("2026-03-01T00:00:00Z"),
      },
    ]);
    prisma.space.findFirst = vi.fn(async ({ where }: { where: { id: string } }) => {
      if (where.id !== "space-credits") return null;
      return {
        organization: {
          modelCredits: { mode: "credits", balanceMicros: 1_000_000n },
          members: { some: true },
        },
      };
    });

    const keyOptions = {
      deploymentModelKey: "deployment-key",
      secrets: { load: prisma.secretsLoad } as never,
    };
    const overview = await loadOpsOverview(
      prisma as never,
      {},
      new Date("2026-11-05T17:00:00.000Z"),
      null,
      keyOptions,
    );
    const agents = await listOpsAgents(prisma as never, keyOptions);

    expect(overview.accounts).toHaveLength(1);
    expect(overview.accounts[0]?.keyType).toBe("company");
    expect(agents).toHaveLength(1);
    expect(agents[0]?.keyType).toBe("company");
    expect(agents[0]?.keyType).toBe(overview.accounts[0]?.keyType);
  });
});
