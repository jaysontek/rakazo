import { createRouterClient } from "@orpc/server";
import type { Actor } from "@rakazo/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RouterDeps } from "./router.js";
import { createRouter } from "./router.js";

const adminActor: Actor = {
  userId: "admin",
  spaceId: "space",
  email: "admin@example.test",
  isDeploymentOwner: false,
};

const userActor: Actor = {
  userId: "user",
  spaceId: "space",
  email: "user@example.test",
  isDeploymentOwner: false,
};

const users = [
  { id: "admin", email: "admin@example.test", emailVerified: true },
  { id: "user", email: "user@example.test", emailVerified: true },
];

function makeDeps(allowlist = ["192.168.140.0/24"]): RouterDeps {
  const prisma = {
    user: {
      findUnique: async ({ where }: { where: { id: string } }) =>
        users.find((user) => user.id === where.id) ?? null,
      findMany: async () => [],
    },
    session: {
      findUnique: async () => ({ impersonatedBy: null }),
    },
    adminGrant: {
      findMany: async () => [],
      findUnique: async () => null,
      upsert: async () => ({}),
      deleteMany: async () => ({ count: 0 }),
    },
    usageRecord: {
      groupBy: async () => [],
      findMany: async () => [],
      aggregate: async () => ({ _sum: { costUsd: 0 } }),
    },
    bot: {
      findMany: async () => [],
    },
    run: {
      findMany: async () => [],
      findUnique: async () => null,
    },
    message: {
      findMany: async () => [],
    },
    deploymentSettings: {
      findUnique: async () => null,
      upsert: async ({
        create,
        update,
      }: {
        create: { sharedKeyMonthlyBudgetUsd?: number };
        update: { sharedKeyMonthlyBudgetUsd?: number };
      }) => {
        const value = update.sharedKeyMonthlyBudgetUsd ?? create.sharedKeyMonthlyBudgetUsd ?? null;
        return { sharedKeyMonthlyBudgetUsd: value };
      },
    },
    sharedKeyBudgetMember: {
      findUnique: async () => null,
      findMany: async () => [],
    },
    sharedKeyWeekAllotment: {
      findUnique: async () => null,
      findMany: async () => [],
      deleteMany: async () => ({ count: 0 }),
      upsert: async () => ({}),
      updateMany: async () => ({ count: 0 }),
    },
    sharedKeyAllotmentTransfer: {
      findMany: async () => [],
    },
    $queryRaw: async () => [{ "?column?": 1 }],
    $transaction: async (fn: (tx: unknown) => unknown) => fn(prisma),
  };

  return {
    prisma,
    env: {
      adminEmails: ["admin@example.test"],
      opsDashboardAllowlist: allowlist,
      sharedKeyMonthlyBudgetUsd: 50,
      agentRuntime: "pi",
      defaultProvider: "openai",
      defaultModel: "gpt-test",
      webOrigin: "http://127.0.0.1:5173",
      screenProxySecret: "test",
      sandboxProvider: "docker",
    },
  } as unknown as RouterDeps;
}

describe("ops dashboard routes", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("denies non-admins for overview, requestLog, and chatLog", async () => {
    const client = createRouterClient(createRouter(makeDeps()), {
      context: { actor: userActor, clientIp: "192.168.140.10" },
    });
    await expect(client.ops.overview()).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: "Admins only",
    });
    await expect(client.ops.requestLog({})).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: "Admins only",
    });
    await expect(client.ops.chatLog({ runId: "run_missing" })).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: "Admins only",
    });
  });

  it("denies an otherwise-valid admin outside the CIDR allowlist", async () => {
    const client = createRouterClient(createRouter(makeDeps()), {
      context: { actor: adminActor, clientIp: "203.0.113.9" },
    });
    await expect(client.ops.overview()).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: "Operations dashboard is limited to allowed networks",
    });
    await expect(client.ops.requestLog({})).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: "Operations dashboard is limited to allowed networks",
    });
    await expect(client.ops.chatLog({ threadId: "thread_1" })).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: "Operations dashboard is limited to allowed networks",
    });
  });

  it("keeps chatLog and requestLog unreachable without admin+LAN", async () => {
    const anonymous = createRouterClient(createRouter(makeDeps()), {
      context: { actor: null, clientIp: "192.168.140.10" } as never,
    });
    await expect(anonymous.ops.requestLog({})).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(anonymous.ops.chatLog({ runId: "run_1" })).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
  });

  it("allows an admin on the LAN allowlist to load overview", async () => {
    const client = createRouterClient(createRouter(makeDeps()), {
      context: { actor: adminActor, clientIp: "192.168.140.10" },
    });
    const overview = await client.ops.overview();
    expect(overview.accounts).toEqual([]);
    // Env fallback (50) when DB has no override.
    expect(overview.sharedKeyBudget.monthlyCapUsd).toBe(50);
    expect(overview.sharedKeyBudget.rosterConfigured).toBe(false);
    expect(overview.agents.total).toBe(0);
  });

  it("lets an admin set the monthly shared-key cap and denies non-admins", async () => {
    const deps = makeDeps();
    const admin = createRouterClient(createRouter(deps), {
      context: { actor: adminActor, clientIp: "192.168.140.10" },
    });
    const user = createRouterClient(createRouter(deps), {
      context: { actor: userActor, clientIp: "192.168.140.10" },
    });
    await expect(user.ops.setSharedKeyMonthlyBudget({ monthlyCapUsd: 75 })).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: "Admins only",
    });
    await expect(
      admin.ops.setSharedKeyMonthlyBudget({ monthlyCapUsd: 75 }),
    ).resolves.toEqual({ monthlyCapUsd: 75 });
    await expect(admin.ops.setSharedKeyMonthlyBudget({ monthlyCapUsd: 0 })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
  });
});
