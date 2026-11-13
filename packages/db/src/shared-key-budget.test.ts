import { sharedKeyWeekEnd } from "@rakazo/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  addSharedKeyBudgetMember,
  reconcileSharedKeyBudgetMembers,
  releaseSharedKeyBudgetHold,
  removeSharedKeyBudgetMember,
  reserveSharedKeyBudget,
  resolveUsageLimitView,
  setSharedKeyMonthlyBudgetUsd,
  SHARED_KEY_BUDGET_HOLD_STALE_MS,
  SharedKeyWeeklyBudgetExceededError,
  sharedKeyMonthlyBudgetUsd,
  sharedKeyWeeklyBudgetStatus,
} from "./shared-key-budget.js";

vi.mock("@rakazo/logging", () => ({
  getLogger: () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

type Member = { userId: string; joinedAt: Date };
type Allotment = {
  weekStart: Date;
  userId: string;
  allotmentUsd: number;
  reservedUsd: number;
  updatedAt: Date;
};
type Usage = { userId: string; costUsd: number; sharedKey: boolean; createdAt: Date };

function fakePrisma(state: {
  monthly: number | null;
  members: Member[];
  allotments: Allotment[];
  usage: Usage[];
  knownUserIds?: string[];
  locks?: string[];
}) {
  const locks = state.locks ?? [];
  const client = {
    deploymentSettings: {
      findUnique: vi.fn(async () =>
        state.monthly == null ? null : { sharedKeyMonthlyBudgetUsd: state.monthly },
      ),
      upsert: vi.fn(
        async ({
          create,
          update,
        }: {
          create: { sharedKeyMonthlyBudgetUsd: number };
          update: { sharedKeyMonthlyBudgetUsd: number };
        }) => {
          state.monthly = update.sharedKeyMonthlyBudgetUsd ?? create.sharedKeyMonthlyBudgetUsd;
          return { sharedKeyMonthlyBudgetUsd: state.monthly };
        },
      ),
    },
    userModelCredential: {
      findFirst: vi.fn(async () => null),
    },
    user: {
      findMany: vi.fn(async ({ where }: { where: { id: { in: string[] } } }) =>
        (state.knownUserIds ?? where.id.in)
          .filter((id) => where.id.in.includes(id))
          .map((id) => ({ id })),
      ),
    },
    sharedKeyBudgetMember: {
      findMany: vi.fn(async () =>
        [...state.members].sort((a, b) => a.joinedAt.getTime() - b.joinedAt.getTime()),
      ),
      findUnique: vi.fn(async ({ where }: { where: { userId: string } }) =>
        state.members.find((m) => m.userId === where.userId) ?? null,
      ),
      upsert: vi.fn(
        async ({
          where,
          create,
        }: {
          where: { userId: string };
          create: Member;
        }) => {
          if (!state.members.some((m) => m.userId === where.userId)) {
            state.members.push({ userId: create.userId, joinedAt: create.joinedAt });
          }
        },
      ),
      create: vi.fn(async ({ data }: { data: Member }) => {
        state.members.push({ userId: data.userId, joinedAt: data.joinedAt });
      }),
      delete: vi.fn(async ({ where }: { where: { userId: string } }) => {
        state.members = state.members.filter((m) => m.userId !== where.userId);
      }),
      deleteMany: vi.fn(async ({ where }: { where: { userId: string } }) => {
        state.members = state.members.filter((m) => m.userId !== where.userId);
      }),
    },
    sharedKeyWeekAllotment: {
      findMany: vi.fn(async ({ where }: { where: { weekStart: Date } }) =>
        state.allotments.filter((row) => row.weekStart.getTime() === where.weekStart.getTime()),
      ),
      findUnique: vi.fn(
        async ({ where }: { where: { weekStart_userId: { weekStart: Date; userId: string } } }) =>
          state.allotments.find(
            (row) =>
              row.weekStart.getTime() === where.weekStart_userId.weekStart.getTime() &&
              row.userId === where.weekStart_userId.userId,
          ) ?? null,
      ),
      deleteMany: vi.fn(
        async ({
          where,
        }: {
          where: { weekStart: Date; userId?: { notIn: string[] } };
        }) => {
          state.allotments = state.allotments.filter((row) => {
            if (row.weekStart.getTime() !== where.weekStart.getTime()) return true;
            if (where.userId?.notIn) return where.userId.notIn.includes(row.userId);
            return false;
          });
        },
      ),
      updateMany: vi.fn(
        async ({
          where,
          data,
        }: {
          where: {
            weekStart: Date;
            reservedUsd: { gt: number };
            updatedAt: { lt: Date };
          };
          data: { reservedUsd: number };
        }) => {
          let count = 0;
          for (const row of state.allotments) {
            if (
              row.weekStart.getTime() === where.weekStart.getTime() &&
              row.reservedUsd > where.reservedUsd.gt &&
              row.updatedAt < where.updatedAt.lt
            ) {
              row.reservedUsd = data.reservedUsd;
              row.updatedAt = new Date();
              count += 1;
            }
          }
          return { count };
        },
      ),
      upsert: vi.fn(
        async ({
          where,
          create,
          update,
        }: {
          where: { weekStart_userId: { weekStart: Date; userId: string } };
          create: Allotment;
          update: { allotmentUsd: number };
        }) => {
          const existing = state.allotments.find(
            (row) =>
              row.weekStart.getTime() === where.weekStart_userId.weekStart.getTime() &&
              row.userId === where.weekStart_userId.userId,
          );
          if (existing) {
            existing.allotmentUsd = update.allotmentUsd;
            return existing;
          }
          state.allotments.push({
            ...create,
            reservedUsd: create.reservedUsd ?? 0,
            updatedAt: create.updatedAt ?? new Date(),
          });
          return create;
        },
      ),
      update: vi.fn(
        async ({
          where,
          data,
        }: {
          where: { weekStart_userId: { weekStart: Date; userId: string } };
          data: { reservedUsd: number | { increment: number } };
        }) => {
          const row = state.allotments.find(
            (entry) =>
              entry.weekStart.getTime() === where.weekStart_userId.weekStart.getTime() &&
              entry.userId === where.weekStart_userId.userId,
          );
          if (!row) throw new Error("missing allotment");
          if (typeof data.reservedUsd === "number") row.reservedUsd = data.reservedUsd;
          else row.reservedUsd += data.reservedUsd.increment;
          row.updatedAt = new Date();
          return row;
        },
      ),
    },
    usageRecord: {
      aggregate: vi.fn(
        async ({
          where,
        }: {
          where: {
            userId: string;
            sharedKey: boolean;
            createdAt: { gte: Date; lt: Date };
          };
        }) => {
          const sum = state.usage
            .filter(
              (row) =>
                row.userId === where.userId &&
                row.sharedKey === where.sharedKey &&
                row.createdAt >= where.createdAt.gte &&
                row.createdAt < where.createdAt.lt,
            )
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
            createdAt: { gte: Date; lt: Date };
          };
        }) => {
          const map = new Map<string, number>();
          for (const row of state.usage) {
            if (
              where.userId.in.includes(row.userId) &&
              row.sharedKey === where.sharedKey &&
              row.createdAt >= where.createdAt.gte &&
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
    $queryRaw: vi.fn(async (query: { values?: unknown[] }) => {
      const key = query && Array.isArray(query.values) ? String(query.values[0] ?? "") : "";
      if (key) locks.push(key);
      return [{ lock: "1" }];
    }),
    $transaction: vi.fn(async (work: (tx: unknown) => Promise<unknown>) => work(client)),
  };
  return { client, locks };
}

describe("shared-key weekly budget", () => {
  const weekStart = new Date("2026-11-02T05:00:00.000Z");
  const midweek = new Date("2026-11-05T17:00:00.000Z");

  beforeEach(() => {
    vi.useRealTimers();
  });

  it("exempts spend that is not on the shared key", async () => {
    const state = {
      monthly: 400,
      members: [{ userId: "u1", joinedAt: weekStart }],
      allotments: [] as Allotment[],
      usage: [
        {
          userId: "u1",
          costUsd: 100,
          sharedKey: false,
          createdAt: new Date(weekStart.getTime() + 60_000),
        },
      ],
    };
    const { client } = fakePrisma(state);
    await addSharedKeyBudgetMember(client as never, "u1", weekStart);
    await reserveSharedKeyBudget(client as never, "u1", 1, weekStart);
    expect(state.allotments[0]?.allotmentUsd).toBe(100);
    expect(state.allotments[0]?.reservedUsd).toBe(1);
  });

  it("hard-stops once the weekly cap is reached and stays stopped until the week resets", async () => {
    const state = {
      monthly: 400,
      members: [{ userId: "u1", joinedAt: weekStart }],
      allotments: [] as Allotment[],
      usage: [] as Usage[],
    };
    const { client } = fakePrisma(state);
    await addSharedKeyBudgetMember(client as never, "u1", weekStart);
    state.usage.push({
      userId: "u1",
      costUsd: 100,
      sharedKey: true,
      createdAt: new Date(weekStart.getTime() + 1_000),
    });
    await expect(
      reserveSharedKeyBudget(client as never, "u1", 0.01, midweek),
    ).rejects.toBeInstanceOf(SharedKeyWeeklyBudgetExceededError);

    await expect(reserveSharedKeyBudget(client as never, "u1", 0, midweek)).rejects.toBeInstanceOf(
      SharedKeyWeeklyBudgetExceededError,
    );

    const nextWeek = new Date("2026-11-09T05:00:00.000Z");
    await reserveSharedKeyBudget(client as never, "u1", 1, nextWeek);
    const nextAllotment = state.allotments.find(
      (row) => row.weekStart.getTime() === nextWeek.getTime() && row.userId === "u1",
    );
    expect(nextAllotment?.allotmentUsd).toBe(100);
  });

  it("clears stale reserved holds so a crash does not hard-stop the rest of the week", async () => {
    const state = {
      monthly: 400,
      members: [{ userId: "u1", joinedAt: weekStart }],
      allotments: [
        {
          weekStart,
          userId: "u1",
          allotmentUsd: 100,
          reservedUsd: 80,
          updatedAt: new Date(midweek.getTime() - SHARED_KEY_BUDGET_HOLD_STALE_MS - 1_000),
        },
      ] as Allotment[],
      usage: [
        {
          userId: "u1",
          costUsd: 10,
          sharedKey: true,
          createdAt: new Date(weekStart.getTime() + 1_000),
        },
      ],
    };
    const { client } = fakePrisma(state);
    // Without cleanup, spent(10)+reserved(80)+1 would fit under 100, but a full 20 would not —
    // after stale clear, reserved is 0 and a 20 reserve succeeds.
    await reserveSharedKeyBudget(client as never, "u1", 20, midweek);
    expect(state.allotments[0]?.reservedUsd).toBe(20);
  });

  it("re-divides remaining budget excluding reservedUsd and uses the members lock", async () => {
    const locks: string[] = [];
    const state = {
      monthly: 400,
      members: [
        { userId: "a", joinedAt: weekStart },
        { userId: "b", joinedAt: weekStart },
      ],
      allotments: [
        {
          weekStart,
          userId: "a",
          allotmentUsd: 50,
          reservedUsd: 15,
          updatedAt: midweek,
        },
        {
          weekStart,
          userId: "b",
          allotmentUsd: 50,
          reservedUsd: 0,
          updatedAt: midweek,
        },
      ] as Allotment[],
      usage: [
        { userId: "a", costUsd: 10, sharedKey: true, createdAt: new Date(weekStart.getTime() + 1) },
        { userId: "b", costUsd: 5, sharedKey: true, createdAt: new Date(weekStart.getTime() + 1) },
      ],
      locks,
    };
    const { client } = fakePrisma(state);
    // Remaining: a=(50-10-15)=25, b=(50-5-0)=45 → 70 / 3. Mid-week c takes a
    // proportional cap; surplus goes back to continuing members.
    await addSharedKeyBudgetMember(client as never, "c", midweek);
    expect(locks.length).toBeGreaterThan(0);
    expect(locks.every((key) => key === "shared-key-budget:members")).toBe(true);
    const evenRemaining = 70 / 3;
    const proportional = (400 / 3 / 4) * 0.5;
    const cSlice = Math.min(evenRemaining, proportional);
    const surplusShare = (evenRemaining - cSlice) / 2;
    const a = state.allotments.find((row) => row.userId === "a");
    const c = state.allotments.find((row) => row.userId === "c");
    // Continuing a keeps spent+reserved committed, plus even remaining and surplus.
    expect(a?.allotmentUsd).toBeCloseTo(10 + 15 + evenRemaining + surplusShare, 5);
    expect(a?.reservedUsd).toBe(15);
    expect(c?.allotmentUsd).toBeCloseTo(cSlice, 5);
  });

  it("skips unknown user ids during reconcile instead of failing", async () => {
    const state = {
      monthly: 200,
      members: [{ userId: "old", joinedAt: weekStart }],
      allotments: [] as Allotment[],
      usage: [] as Usage[],
      knownUserIds: ["a"],
    };
    const { client } = fakePrisma(state);
    await reconcileSharedKeyBudgetMembers(client as never, ["a", "missing"], weekStart);
    expect(state.members.map((m) => m.userId)).toEqual(["a"]);
  });

  it("re-divides remaining budget when users are added or removed", async () => {
    const state = {
      monthly: 400,
      members: [
        { userId: "a", joinedAt: weekStart },
        { userId: "b", joinedAt: weekStart },
      ],
      allotments: [
        { weekStart, userId: "a", allotmentUsd: 50, reservedUsd: 0, updatedAt: midweek },
        { weekStart, userId: "b", allotmentUsd: 50, reservedUsd: 0, updatedAt: midweek },
      ] as Allotment[],
      usage: [
        { userId: "a", costUsd: 10, sharedKey: true, createdAt: new Date(weekStart.getTime() + 1) },
        { userId: "b", costUsd: 5, sharedKey: true, createdAt: new Date(weekStart.getTime() + 1) },
      ],
    };
    const { client } = fakePrisma(state);
    await addSharedKeyBudgetMember(client as never, "c", midweek);
    const c = state.allotments.find((row) => row.userId === "c");
    expect(c?.allotmentUsd).toBeLessThan(400 / 3 / 4);
    expect(c?.allotmentUsd).toBeGreaterThan(0);

    await removeSharedKeyBudgetMember(client as never, "c", midweek);
    expect(state.members.map((m) => m.userId).sort()).toEqual(["a", "b"]);
    expect(state.allotments.some((row) => row.userId === "c")).toBe(false);
  });

  it("reconciles the configurable member set from env-style ids", async () => {
    const state = {
      monthly: 200,
      members: [{ userId: "old", joinedAt: weekStart }],
      allotments: [] as Allotment[],
      usage: [] as Usage[],
      knownUserIds: ["a", "b"],
    };
    const { client } = fakePrisma(state);
    await reconcileSharedKeyBudgetMembers(client as never, ["a", "b"], weekStart);
    expect(state.members.map((m) => m.userId).sort()).toEqual(["a", "b"]);
    expect(state.allotments.every((row) => row.allotmentUsd === 25)).toBe(true);
  });

  it("reports weekly percent used for the current user", async () => {
    const state = {
      monthly: 400,
      members: [{ userId: "u1", joinedAt: weekStart }],
      allotments: [] as Allotment[],
      usage: [
        {
          userId: "u1",
          costUsd: 25,
          sharedKey: true,
          createdAt: new Date(weekStart.getTime() + 1_000),
        },
      ],
    };
    const { client } = fakePrisma(state);
    const status = await sharedKeyWeeklyBudgetStatus(client as never, "u1", midweek);
    expect(status.enabled).toBe(true);
    expect(status.member).toBe(true);
    expect(status.weeklyCapUsd).toBe(100);
    expect(status.spentUsd).toBe(25);
    expect(status.percentUsed).toBe(25);
    expect(status.timezone).toBe("America/New_York");
  });

  it("releases a soft hold after the call settles", async () => {
    const state = {
      monthly: 400,
      members: [{ userId: "u1", joinedAt: weekStart }],
      allotments: [] as Allotment[],
      usage: [] as Usage[],
    };
    const { client } = fakePrisma(state);
    await addSharedKeyBudgetMember(client as never, "u1", weekStart);
    await reserveSharedKeyBudget(client as never, "u1", 12, midweek);
    expect(state.allotments[0]?.reservedUsd).toBe(12);
    await releaseSharedKeyBudgetHold(client as never, "u1", 12, midweek);
    expect(state.allotments[0]?.reservedUsd).toBe(0);
  });

  it("prefers a DB monthly cap over the env fallback", async () => {
    const state = {
      monthly: 50,
      members: [] as Member[],
      allotments: [] as Allotment[],
      usage: [] as Usage[],
    };
    const { client } = fakePrisma(state);
    expect(await sharedKeyMonthlyBudgetUsd(client as never, 400)).toBe(50);
    state.monthly = null;
    expect(await sharedKeyMonthlyBudgetUsd(client as never, 400)).toBe(400);
    expect(await sharedKeyMonthlyBudgetUsd(client as never, null)).toBeNull();
  });

  it("persists an admin monthly cap and re-divides the week", async () => {
    const state = {
      monthly: 400 as number | null,
      members: [
        { userId: "a", joinedAt: weekStart },
        { userId: "b", joinedAt: weekStart },
      ],
      allotments: [] as Allotment[],
      usage: [] as Usage[],
    };
    const { client } = fakePrisma(state);
    await setSharedKeyMonthlyBudgetUsd(client as never, 200, midweek);
    expect(state.monthly).toBe(200);
    // 200 / 2 users / 4 weeks = 25 each.
    expect(state.allotments.map((row) => row.allotmentUsd).sort()).toEqual([25, 25]);
  });

  it("resolves usage limit percent and reset for shared-key members", async () => {
    const state = {
      monthly: 400,
      members: [{ userId: "u1", joinedAt: weekStart }],
      allotments: [] as Allotment[],
      usage: [
        {
          userId: "u1",
          costUsd: 50,
          sharedKey: true,
          createdAt: new Date(weekStart.getTime() + 1_000),
        },
      ],
    };
    const { client } = fakePrisma(state);
    const limit = await resolveUsageLimitView(client as never, "u1", midweek);
    expect(limit).toMatchObject({
      kind: "shared_weekly",
      percentUsed: 50,
      timezone: "America/New_York",
    });
    if (limit.kind === "shared_weekly") {
      expect(limit.resetsAt).toBe(sharedKeyWeekEnd(weekStart).toISOString());
    }
  });

  it("resolves personal-key usage when a Google credential exists", async () => {
    const state = {
      monthly: 400,
      members: [{ userId: "u1", joinedAt: weekStart }],
      allotments: [] as Allotment[],
      usage: [] as Usage[],
    };
    const { client } = fakePrisma(state);
    client.userModelCredential.findFirst = vi.fn(async () => ({ id: "cred" }));
    expect(await resolveUsageLimitView(client as never, "u1", midweek)).toEqual({
      kind: "personal_key",
    });
  });
});
