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

function makeDeps(): RouterDeps {
  const prisma = {
    user: {
      findUnique: async ({ where }: { where: { id: string } }) =>
        users.find((user) => user.id === where.id) ?? null,
    },
    usageRecord: {
      findMany: async () => [
        {
          id: "u1",
          botId: null,
          runId: "run1",
          provider: "google",
          model: "gemini",
          inputTokens: 10,
          outputTokens: 5,
          cacheReadTokens: null,
          cacheWriteTokens: null,
          cacheWrite1hTokens: null,
          reasoningTokens: null,
          totalTokens: 15,
          costUsd: 0.42,
          costSource: "catalog",
          pricingVersion: "v1",
          usageSource: "provider",
          callId: null,
          operationId: null,
          operationKind: "answer",
          parentRunId: null,
          agentId: null,
          createdAt: new Date("2026-11-05T12:00:00.000Z"),
        },
      ],
      groupBy: async ({ by }: { by: string[] }) => {
        if (by.includes("provider")) {
          return [
            {
              provider: "google",
              model: "gemini",
              _sum: { inputTokens: 10, outputTokens: 5, totalTokens: 15, costUsd: 0.42 },
              _count: {
                _all: 1,
                inputTokens: 1,
                outputTokens: 1,
                totalTokens: 1,
                costUsd: 1,
              },
            },
          ];
        }
        if (by.includes("userId")) {
          return [{ userId: "user", _sum: { costUsd: 25 } }];
        }
        return [{ runId: "run1", parentRunId: null }];
      },
      aggregate: async (args?: { where?: { sharedKey?: boolean } }) => {
        if (args?.where?.sharedKey) {
          return { _sum: { costUsd: 25 } };
        }
        return {
          _sum: { inputTokens: 10, outputTokens: 5, totalTokens: 15, costUsd: 0.42 },
          _count: {
            _all: 1,
            inputTokens: 1,
            outputTokens: 1,
            totalTokens: 1,
            costUsd: 1,
          },
        };
      },
    },
    deploymentSettings: {
      findUnique: async () => ({ sharedKeyMonthlyBudgetUsd: 400 }),
    },
    sharedKeyBudgetMember: {
      findUnique: async ({ where }: { where: { userId: string } }) =>
        where.userId === "user" ? { userId: "user", joinedAt: new Date() } : null,
      findMany: async () => [{ userId: "user", joinedAt: new Date() }],
    },
    sharedKeyAllotmentTransfer: {
      findMany: async () => [],
    },
    sharedKeyWeekAllotment: {
      findUnique: async () => ({
        weekStart: new Date("2026-11-02T05:00:00.000Z"),
        userId: "user",
        allotmentUsd: 100,
        reservedUsd: 0,
      }),
      findMany: async () => [
        {
          weekStart: new Date("2026-11-02T05:00:00.000Z"),
          userId: "user",
          allotmentUsd: 100,
          reservedUsd: 0,
        },
      ],
      deleteMany: async () => ({ count: 0 }),
      upsert: async () => ({}),
      updateMany: async () => ({ count: 0 }),
    },
    userModelCredential: {
      findFirst: async () => null,
    },
    $queryRaw: async () => [{ "?column?": 1 }],
    $transaction: async (fn: (tx: unknown) => unknown) => fn(prisma),
  };

  return {
    prisma,
    env: {
      adminEmails: ["admin@example.test"],
      sharedKeyMonthlyBudgetUsd: 400,
      agentRuntime: "pi",
      defaultProvider: "openai",
      defaultModel: "gpt-test",
      webOrigin: "http://127.0.0.1:5173",
      screenProxySecret: "test",
      sandboxProvider: "docker",
    },
  } as unknown as RouterDeps;
}

describe("usage.summary cost stripping", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("omits cost fields for non-admins and keeps percent/reset", async () => {
    const client = createRouterClient(createRouter(makeDeps()), {
      context: { actor: userActor, clientIp: "127.0.0.1" },
    });
    const summary = await client.usage.summary();
    expect(summary).not.toHaveProperty("costUsd");
    expect(summary.models?.[0]).not.toHaveProperty("costUsd");
    expect(summary.sharedKeyWeeklyBudget).toMatchObject({
      percentUsed: expect.any(Number),
      resetsAt: expect.any(String),
      timezone: "America/New_York",
    });
    expect(summary.sharedKeyWeeklyBudget).not.toHaveProperty("spentUsd");
    expect(summary.sharedKeyWeeklyBudget).not.toHaveProperty("weeklyCapUsd");
    expect(summary.usageLimit).toMatchObject({
      kind: "shared_weekly",
      percentUsed: expect.any(Number),
      resetsAt: expect.any(String),
    });
    expect(JSON.stringify(summary)).not.toMatch(/costUsd|spentUsd|weeklyCapUsd|\$/);

    const list = await client.usage.list();
    expect(list[0]).not.toHaveProperty("costUsd");
    expect(list[0]).not.toHaveProperty("costSource");
  });

  it("keeps cost fields for admins", async () => {
    const client = createRouterClient(createRouter(makeDeps()), {
      context: { actor: adminActor, clientIp: "127.0.0.1" },
    });
    const summary = await client.usage.summary();
    expect(summary.costUsd).toBeCloseTo(0.42);
    expect(summary.models?.[0]?.costUsd).toBeCloseTo(0.42);
    expect(summary.sharedKeyWeeklyBudget).toBeNull();
  });
});
