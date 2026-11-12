import { sharedKeyWeekStart } from "@rakazo/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  addSharedKeyBudgetMember,
  reconcileSharedKeyBudgetMembers,
  releaseSharedKeyBudgetHold,
  removeSharedKeyBudgetMember,
  reserveSharedKeyBudget,
  SharedKeyWeeklyBudgetExceededError,
  sharedKeyWeeklyBudgetStatus,
} from "./shared-key-budget.js";

type Member = { userId: string; joinedAt: Date };
type Allotment = {
  weekStart: Date;
  userId: string;
  allotmentUsd: number;
  reservedUsd: number;
};
type Usage = { userId: string; costUsd: number; sharedKey: boolean; createdAt: Date };

function fakePrisma(state: {
  monthly: number | null;
  members: Member[];
  allotments: Allotment[];
  usage: Usage[];
}) {
  const weekStartOf = (now: Date) => sharedKeyWeekStart(now);
  const client = {
    deploymentSettings: {
      findUnique: vi.fn(async () =>
        state.monthly == null ? null : { sharedKeyMonthlyBudgetUsd: state.monthly },
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
          state.allotments.push({ ...create, reservedUsd: create.reservedUsd ?? 0 });
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
    $queryRaw: vi.fn(async () => [{ lock: "1" }]),
    $transaction: vi.fn(async (work: (tx: unknown) => Promise<unknown>) => work(client)),
  };
  return { client, weekStartOf };
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
    // Personal-key usage must not consume the weekly allotment.
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
    // One member: weekly cap = 400/1/4 = 100
    state.usage.push({
      userId: "u1",
      costUsd: 100,
      sharedKey: true,
      createdAt: new Date(weekStart.getTime() + 1_000),
    });
    await expect(reserveSharedKeyBudget(client as never, "u1", 0.01, midweek)).rejects.toBeInstanceOf(
      SharedKeyWeeklyBudgetExceededError,
    );

    // Same user, new thread/call still blocked this week.
    await expect(reserveSharedKeyBudget(client as never, "u1", 0, midweek)).rejects.toBeInstanceOf(
      SharedKeyWeeklyBudgetExceededError,
    );

    // After the America/New_York week boundary, a fresh allotment applies.
    const nextWeek = new Date("2026-11-09T05:00:00.000Z");
    await reserveSharedKeyBudget(client as never, "u1", 1, nextWeek);
    const nextAllotment = state.allotments.find(
      (row) => row.weekStart.getTime() === nextWeek.getTime() && row.userId === "u1",
    );
    expect(nextAllotment?.allotmentUsd).toBe(100);
  });

  it("re-divides remaining budget when users are added or removed", async () => {
    const state = {
      monthly: 400,
      members: [
        { userId: "a", joinedAt: weekStart },
        { userId: "b", joinedAt: weekStart },
      ],
      allotments: [
        { weekStart, userId: "a", allotmentUsd: 50, reservedUsd: 0 },
        { weekStart, userId: "b", allotmentUsd: 50, reservedUsd: 0 },
      ],
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
});
