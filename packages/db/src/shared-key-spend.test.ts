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
  scope?: "user" | "team";
  userId: string | null;
  userIdSnapshot?: string | null;
  deltaUsd: number;
  createdAt?: Date;
};

function normalizeAdjustment(row: Adjustment): Required<
  Pick<Adjustment, "scope" | "userIdSnapshot" | "createdAt">
> &
  Adjustment {
  const scope = row.scope ?? (row.userId == null ? "team" : "user");
  return {
    ...row,
    scope,
    userIdSnapshot: row.userIdSnapshot ?? row.userId,
    createdAt: row.createdAt ?? row.periodStart,
  };
}

function fakeSpendPrisma(state: { usage: Usage[]; adjustments?: Adjustment[] }) {
  const adjustments = (state.adjustments ?? []).map(normalizeAdjustment);
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
            scope?: string;
            userId?: string | null | { in: string[] };
            userIdSnapshot?: string | { in: string[] };
            OR?: Array<Record<string, unknown>>;
            createdAt?: { gte?: Date; lt?: Date };
          };
        }) => {
          const sum = adjustments
            .filter((row) => {
              if (row.periodStart.getTime() !== where.periodStart.getTime()) return false;
              if (where.scope && row.scope !== where.scope) return false;
              if (where.createdAt?.lt && !(row.createdAt! < where.createdAt.lt)) return false;
              if (where.createdAt?.gte && row.createdAt! < where.createdAt.gte) return false;
              if (where.OR) {
                return where.OR.some((clause) => {
                  if (clause.scope === "team") return row.scope === "team";
                  if (clause.userId === null) return row.scope === "team";
                  if (
                    clause.userIdSnapshot &&
                    typeof clause.userIdSnapshot === "object" &&
                    "in" in (clause.userIdSnapshot as object)
                  ) {
                    const ids = (clause.userIdSnapshot as { in: string[] }).in;
                    return (
                      row.scope === "user" &&
                      row.userIdSnapshot != null &&
                      ids.includes(row.userIdSnapshot)
                    );
                  }
                  if (typeof clause.userIdSnapshot === "string") {
                    return row.userIdSnapshot === clause.userIdSnapshot;
                  }
                  if (typeof clause.userId === "string") {
                    return row.userId === clause.userId || row.userIdSnapshot === clause.userId;
                  }
                  return false;
                });
              }
              if (where.userId === null || where.scope === "team") return row.scope === "team";
              if (typeof where.userId === "string") {
                return (
                  row.scope === "user" &&
                  (row.userId === where.userId || row.userIdSnapshot === where.userId)
                );
              }
              if (typeof where.userIdSnapshot === "string") {
                return row.scope === "user" && row.userIdSnapshot === where.userIdSnapshot;
              }
              if (
                where.userIdSnapshot &&
                typeof where.userIdSnapshot === "object" &&
                "in" in where.userIdSnapshot
              ) {
                return (
                  row.scope === "user" &&
                  row.userIdSnapshot != null &&
                  where.userIdSnapshot.in.includes(row.userIdSnapshot)
                );
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
          where: {
            periodStart: Date;
            scope?: string;
            userIdSnapshot?: { in: string[] };
            userId?: { in: string[] };
          };
        }) => {
          const map = new Map<string, number>();
          for (const row of adjustments) {
            if (row.periodStart.getTime() !== where.periodStart.getTime()) continue;
            if (where.scope && row.scope !== where.scope) continue;
            const id = row.userIdSnapshot ?? row.userId;
            if (id == null) continue;
            const allowed =
              where.userIdSnapshot?.in.includes(id) || where.userId?.in.includes(id);
            if (!allowed) continue;
            map.set(id, (map.get(id) ?? 0) + row.deltaUsd);
          }
          return [...map.entries()].map(([userIdSnapshot, deltaUsd]) => ({
            userIdSnapshot,
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
    expect(
      await sumSharedKeyUsageByUser(prisma, {
        userIds: ["a", "b"],
        since: periodStart,
        until: mid,
      }).then((m) => m.get("b") ?? 0),
    ).toBe(0);

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

  it("counts a deleted user's scope=user row via userIdSnapshot, never as team", async () => {
    const prisma = fakeSpendPrisma({
      usage: [
        {
          userId: "gone",
          costUsd: 7,
          sharedKey: true,
          createdAt: new Date(periodStart.getTime() + 1_000),
        },
      ],
      adjustments: [
        {
          periodStart,
          scope: "user",
          userId: null,
          userIdSnapshot: "gone",
          deltaUsd: 3,
        },
        {
          periodStart,
          scope: "team",
          userId: null,
          userIdSnapshot: null,
          deltaUsd: 11,
        },
      ],
    });
    expect(
      await trackedSharedKeySpendUsd(prisma, {
        userId: "gone",
        since: periodStart,
        until: mid,
        periodStart,
      }),
    ).toBe(10);
    const byUser = await trackedSharedKeySpendByUser(prisma, {
      userIds: ["gone"],
      since: periodStart,
      until: mid,
      periodStart,
    });
    expect(byUser.get("gone")).toBe(10);
    // Team total includes usage + user adj + team adj; the null-FK user row stays user-scoped.
    expect(
      await trackedSharedKeyTeamSpendUsd(prisma, {
        since: periodStart,
        until: mid,
        periodStart,
        includeUserAdjustments: true,
      }),
    ).toBe(21);
    expect(
      await trackedSharedKeyTeamSpendUsd(prisma, {
        since: periodStart,
        until: mid,
        periodStart,
        includeUserAdjustments: false,
      }),
    ).toBe(18);
  });

  it("limits baseline adjustments to createdAt before join, including negative deltas", async () => {
    const joinAt = new Date(periodStart.getTime() + 3 * 24 * 60 * 60 * 1000);
    const prisma = fakeSpendPrisma({
      usage: [
        {
          userId: "c",
          costUsd: 20,
          sharedKey: true,
          createdAt: new Date(joinAt.getTime() + 1_000),
        },
      ],
      adjustments: [
        {
          periodStart,
          userId: "c",
          deltaUsd: -10,
          createdAt: new Date(periodStart.getTime() + 1_000),
        },
        {
          periodStart,
          userId: "c",
          deltaUsd: 5,
          createdAt: new Date(joinAt.getTime() + 2_000),
        },
      ],
    });
    const baseline = await trackedSharedKeySpendUsd(prisma, {
      userId: "c",
      since: periodStart,
      until: joinAt,
      periodStart,
      adjustmentCreatedBefore: joinAt,
    });
    expect(baseline).toBe(-10);
    const monday = await trackedSharedKeySpendUsd(prisma, {
      userId: "c",
      since: periodStart,
      until: mid,
      periodStart,
    });
    expect(monday).toBe(15); // 20 − 10 + 5
  });
});
