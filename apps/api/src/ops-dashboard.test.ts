import { describe, expect, it, vi } from "vitest";
import { loadOpsOverview } from "./ops-dashboard.js";

function opsPrisma(users: Array<{ id: string; email: string; name: string; deactivatedAt: null }>) {
  return {
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
          .filter((user) => !user.email.endsWith("@builddrive.net") && !user.email.endsWith(".builddrive.net"))
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
      findUnique: vi.fn(async () => null),
    },
    sharedKeyBudgetMember: {
      findMany: vi.fn(async () => []),
      findUnique: vi.fn(async () => null),
    },
    sharedKeyBudgetEnrollmentRequest: {
      findMany: vi.fn(async () => []),
    },
    sharedKeyWeekAllotment: {
      findMany: vi.fn(async () => []),
      findUnique: vi.fn(async () => null),
    },
    sharedKeyAllotmentTransfer: {
      findMany: vi.fn(async () => []),
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
    userModelCredential: {
      findMany: vi.fn(async () => []),
      findFirst: vi.fn(async () => null),
    },
    secret: {
      findFirst: vi.fn(async () => null),
    },
    space: {
      findFirst: vi.fn(async () => null),
    },
    $queryRaw: vi.fn(async () => [{ "?column?": 1 }]),
  };
}

describe("loadOpsOverview", () => {
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
      expect(typeof account.needsReconnect).toBe("boolean");
    }
    expect(overview.accounts.every((account) => account.keyType === "company")).toBe(true);
  });
});
