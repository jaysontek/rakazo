import { describe, expect, it, vi } from "vitest";
import {
  sumSharedKeyUsageByUser,
  sumSharedKeyUsageUsd,
  trackedSharedKeySpendByUser,
  trackedSharedKeySpendUsd,
  trackedSharedKeyTeamSpendUsd,
} from "./shared-key-spend.js";

type Usage = { userId: string; costUsd: number; sharedKey: boolean; createdAt: Date };
type Adjustment = {
  periodStart: Date;
  userId: string | null;
  deltaUsd: number;
};

function fakeSpendPrisma(state: { usage: Usage[]; adjustments?: Adjustment[] }) {
  const adjustments = state.adjustments ?? [];
  return {
    usageRecord: {
      aggregate: vi.fn(
        async ({
          where,
        }: {
          where: {
            userId?: string | { in: string[] };
            sharedKey: boolean;
            createdAt?: { gte?: Date; lt: Date };
          };
        }) => {
          const sum = state.usage
            .filter((row) => {
              if (row.sharedKey !== where.sharedKey) return false;
              if (typeof where.userId === "string" && row.userId !== where.userId) return false;
              if (
                where.userId &&
                typeof where.userId === "object" &&
                !where.userId.in.includes(row.userId)
              ) {
                return false;
              }
              if (where.createdAt?.gte && row.createdAt < where.createdAt.gte) return false;
              if (where.createdAt?.lt && !(row.createdAt < where.createdAt.lt)) return false;
              return true;
            })
            .reduce((acc, row) => acc + row.costUsd, 0);
          return { _sum: { costUsd: sum } };
        },
      ),
      groupBy: vi.fn(
        async ({
          where,
        }: {
          where: {
            userId: { in: string[] };
            sharedKey: boolean;
            createdAt: { gte?: Date; lt: Date };
          };
        }) => {
          const map = new Map<string, number>();
          for (const row of state.usage) {
            if (
              where.userId.in.includes(row.userId) &&
              row.sharedKey === where.sharedKey &&
              (!where.createdAt.gte || row.createdAt >= where.createdAt.gte) &&
              row.createdAt < where.createdAt.lt
            ) {
              map.set(row.userId, (map.get(row.userId) ?? 0) + row.costUsd);
            }
          }
          return [...map.entries()].map(([userId, costUsd]) => ({
            userId,
            _sum: { costUsd },
          }));
        },
      ),
    },
    sharedKeySpendAdjustment: {
      aggregate: vi.fn(
        async ({
          where,
        }: {
          where: {
            periodStart: Date;
            userId?: string | null | { in: string[] };
            OR?: Array<{ userId: null } | { userId: { in: string[] } }>;
          };
        }) => {
          const sum = adjustments
            .filter((row) => {
              if (row.periodStart.getTime() !== where.periodStart.getTime()) return false;
              if (where.OR) {
                return where.OR.some((clause) => {
                  if ("userId" in clause && clause.userId === null) return row.userId == null;
                  if (
                    "userId" in clause &&
                    clause.userId &&
                    typeof clause.userId === "object" &&
                    "in" in clause.userId
                  ) {
                    return row.userId != null && clause.userId.in.includes(row.userId);
                  }
                  return false;
                });
              }
              if (where.userId === null) return row.userId == null;
              if (typeof where.userId === "string") return row.userId === where.userId;
              if (where.userId && typeof where.userId === "object" && "in" in where.userId) {
                return row.userId != null && where.userId.in.includes(row.userId);
              }
              return true;
            })
            .reduce((acc, row) => acc + row.deltaUsd, 0);
          return { _sum: { deltaUsd: sum } };
        },
      ),
      groupBy: vi.fn(
        async ({
          where,
        }: {
          where: { periodStart: Date; userId: { in: string[] } };
        }) => {
          const map = new Map<string, number>();
          for (const row of adjustments) {
            if (
              row.periodStart.getTime() === where.periodStart.getTime() &&
              row.userId != null &&
              where.userId.in.includes(row.userId)
            ) {
              map.set(row.userId, (map.get(row.userId) ?? 0) + row.deltaUsd);
            }
          }
          return [...map.entries()].map(([userId, deltaUsd]) => ({
            userId,
            _sum: { deltaUsd },
          }));
        },
      ),
    },
  };
}

describe("shared-key tracked spend helper", () => {
  const periodStart = new Date("2026-11-02T05:00:00.000Z");
  const mid = new Date("2026-11-05T12:00:00.000Z");

  it("never counts personal-key usage (sharedKey false) in any path", async () => {
    const prisma = fakeSpendPrisma({
      usage: [
        {
          userId: "a",
          costUsd: 40,
          sharedKey: false,
          createdAt: new Date(periodStart.getTime() + 1_000),
        },
        {
          userId: "a",
          costUsd: 10,
          sharedKey: true,
          createdAt: new Date(periodStart.getTime() + 2_000),
        },
        {
          userId: "b",
          costUsd: 99,
          sharedKey: false,
          createdAt: new Date(periodStart.getTime() + 3_000),
        },
      ],
      adjustments: [{ periodStart, userId: "a", deltaUsd: 2 }],
    });

    expect(await sumSharedKeyUsageUsd(prisma, { userId: "a", since: periodStart, until: mid })).toBe(
      10,
    );
    expect(
      await trackedSharedKeySpendUsd(prisma, {
        userId: "a",
        since: periodStart,
        until: mid,
        periodStart,
      }),
    ).toBe(12);
    expect(
      await trackedSharedKeyTeamSpendUsd(prisma, {
        since: periodStart,
        until: mid,
        periodStart,
      }),
    ).toBe(12);
    const byUser = await trackedSharedKeySpendByUser(prisma, {
      userIds: ["a", "b"],
      since: periodStart,
      until: mid,
      periodStart,
    });
    expect(byUser.get("a")).toBe(12);
    expect(byUser.get("b") ?? 0).toBe(0);
    expect(await sumSharedKeyUsageByUser(prisma, { userIds: ["a", "b"], since: periodStart, until: mid }).then((m) => m.get("b") ?? 0)).toBe(0);

    // Invariant: every aggregate/groupBy call filtered sharedKey: true.
    for (const call of prisma.usageRecord.aggregate.mock.calls) {
      expect(call[0].where.sharedKey).toBe(true);
    }
    for (const call of prisma.usageRecord.groupBy.mock.calls) {
      expect(call[0].where.sharedKey).toBe(true);
    }
  });

  it("applies adjustments exactly and supports team-wide deltas", async () => {
    const prisma = fakeSpendPrisma({
      usage: [
        {
          userId: "a",
          costUsd: 20,
          sharedKey: true,
          createdAt: new Date(periodStart.getTime() + 1_000),
        },
      ],
      adjustments: [
        { periodStart, userId: "a", deltaUsd: 5 },
        { periodStart, userId: null, deltaUsd: 3 },
      ],
    });
    expect(
      await trackedSharedKeySpendUsd(prisma, {
        userId: "a",
        since: periodStart,
        until: mid,
        periodStart,
      }),
    ).toBe(25);
    expect(
      await trackedSharedKeyTeamSpendUsd(prisma, {
        since: periodStart,
        until: mid,
        periodStart,
        includeUserAdjustments: true,
      }),
    ).toBe(28);
  });
});
