import { fullWeekShareUsd, sharedKeyWeekEnd } from "@rakazo/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  addSharedKeyBudgetMember,
  reconcileSharedKeyBudgetMembers,
  releaseSharedKeyBudgetHold,
  removeSharedKeyBudgetMember,
  reserveSharedKeyBudget,
  resolveUsageLimitView,
  SHARED_KEY_BUDGET_HOLD_STALE_MS,
  SharedKeyBudgetNotEnrolledError,
  SharedKeyWeeklyBudgetExceededError,
  setSharedKeyMonthlyBudgetUsd,
  sharedKeyMonthlyBudgetUsd,
  sharedKeyWeeklyBudgetStatus,
  syncSharedKeyBudgetMembers,
  type SharedKeyBudgetEnrollmentPolicy,
} from "./shared-key-budget.js";

vi.mock("@rakazo/logging", () => ({
  getLogger: () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  redactBindings: (value: unknown) => value,
}));

type Member = { userId: string; joinedAt: Date };
type Allotment = {
  weekStart: Date;
  userId: string;
  allotmentUsd: number;
  reservedUsd: number;
  joinedAt: Date;
  preJoinSpendUsd: number;
  updatedAt: Date;
};
type Usage = { userId: string; costUsd: number; sharedKey: boolean; createdAt: Date };
type Transfer = {
  weekStart: Date;
  fromUserId: string;
  toUserId: string;
  amountUsd: number;
  createdAt: Date;
  reversedAt: Date | null;
};

function allotment(
  partial: Omit<Allotment, "joinedAt" | "preJoinSpendUsd" | "updatedAt"> &
    Partial<Pick<Allotment, "joinedAt" | "preJoinSpendUsd" | "updatedAt">>,
): Allotment {
  return {
    ...partial,
    joinedAt: partial.joinedAt ?? partial.weekStart,
    preJoinSpendUsd: partial.preJoinSpendUsd ?? 0,
    updatedAt: partial.updatedAt ?? partial.weekStart,
  };
}

function fakePrisma(state: {
  monthly: number | null;
  members: Member[];
  allotments: Allotment[];
  usage: Usage[];
  transfers?: Transfer[];
  knownUserIds?: string[];
  /** Users that fail the verified-email + org-membership bar. */
  ineligibleUserIds?: string[];
  /** Users with emailVerified=false (still known). */
  unverifiedUserIds?: string[];
  /** Users with no organization membership. */
  noMembershipUserIds?: string[];
  /** Multi-member org memberships: userId -> peer user ids in the same org. */
  orgPeers?: Record<string, string[]>;
  /** User ids that hold an AdminGrant. */
  adminGrantUserIds?: string[];
  auditEvents?: Array<Record<string, unknown>>;
  locks?: string[];
}) {
  const locks = state.locks ?? [];
  const auditEvents = state.auditEvents ?? [];
  const ineligible = new Set(state.ineligibleUserIds ?? []);
  const unverified = new Set(state.unverifiedUserIds ?? []);
  const noMembership = new Set(state.noMembershipUserIds ?? []);
  const adminGrants = new Set(state.adminGrantUserIds ?? []);
  const orgPeers = state.orgPeers ?? {};
  const knownIds = () =>
    state.knownUserIds ?? [
      ...state.members.map((m) => m.userId),
      ...state.allotments.map((a) => a.userId),
    ];
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
      findFirst: vi.fn(async (): Promise<{ id: string } | null> => null),
    },
    space: {
      findUnique: vi.fn(async () => null),
    },
    adminGrant: {
      findFirst: vi.fn(
        async ({ where }: { where: { userId: { in: string[] } } }) => {
          const hit = where.userId.in.find((id) => adminGrants.has(id));
          return hit ? { userId: hit } : null;
        },
      ),
      findMany: vi.fn(
        async ({ where }: { where: { userId: { in: string[] } } }) =>
          where.userId.in.filter((id) => adminGrants.has(id)).map((userId) => ({ userId })),
      ),
    },
    member: {
      findFirst: vi.fn(async ({ where }: { where: { userId: string } }) => {
        if (noMembership.has(where.userId) || ineligible.has(where.userId)) return null;
        return { organizationId: `org-${where.userId}` };
      }),
      findMany: vi.fn(
        async ({
          where,
        }: {
          where: { userId?: string; organizationId?: { in: string[] } };
        }) => {
          if (where.userId) {
            if (noMembership.has(where.userId) || ineligible.has(where.userId)) return [];
            return [{ organizationId: `org-${where.userId}` }];
          }
          if (where.organizationId?.in) {
            const rows: Array<{ organizationId: string; userId: string }> = [];
            for (const orgId of where.organizationId.in) {
              const ownerId = orgId.replace(/^org-/, "");
              const peers = orgPeers[ownerId] ?? [];
              rows.push({ organizationId: orgId, userId: ownerId });
              for (const peer of peers) {
                rows.push({ organizationId: orgId, userId: peer });
              }
            }
            return rows;
          }
          return [];
        },
      ),
    },
    auditEvent: {
      createMany: vi.fn(async ({ data }: { data: Array<Record<string, unknown>> }) => {
        auditEvents.push(...data);
        return { count: data.length };
      }),
    },
    user: {
      findMany: vi.fn(
        async ({
          where,
        }: {
          where: {
            id: { in: string[] };
            deactivatedAt?: null;
            emailVerified?: boolean;
          };
        }) =>
          knownIds()
            .filter((id) => where.id.in.includes(id))
            .filter((id) => !ineligible.has(id))
            .filter((id) => (where.emailVerified === true ? !unverified.has(id) : true))
            .filter((id) => (where.deactivatedAt === null ? true : true))
            .map((id) => ({
              id,
              email: `${id}@example.com`,
              deactivatedAt: null,
              emailVerified: !unverified.has(id),
            })),
      ),
      findUnique: vi.fn(
        async ({ where }: { where: { id: string } }) => {
          const ids = knownIds();
          if (!ids.includes(where.id) && state.knownUserIds != null) return null;
          if (ineligible.has(where.id)) {
            return {
              id: where.id,
              email: `${where.id}@example.com`,
              deactivatedAt: new Date("2026-01-01T00:00:00.000Z"),
              emailVerified: false,
            };
          }
          // Default: verified, active — eligibility also needs a membership row.
          return {
            id: where.id,
            email: `${where.id}@example.com`,
            deactivatedAt: null,
            emailVerified: !unverified.has(where.id),
          };
        },
      ),
    },
    sharedKeyBudgetMember: {
      findMany: vi.fn(async () =>
        [...state.members].sort((a, b) => a.joinedAt.getTime() - b.joinedAt.getTime()),
      ),
      findUnique: vi.fn(
        async ({ where }: { where: { userId: string } }) =>
          state.members.find((m) => m.userId === where.userId) ?? null,
      ),
      upsert: vi.fn(async ({ where, create }: { where: { userId: string }; create: Member }) => {
        if (!state.members.some((m) => m.userId === where.userId)) {
          state.members.push({ userId: create.userId, joinedAt: create.joinedAt });
        }
      }),
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
    sharedKeyAllotmentTransfer: {
      findMany: vi.fn(
        async ({ where }: { where: { weekStart: Date; reversedAt: null } }): Promise<Transfer[]> =>
          (state.transfers ?? [])
            .filter(
              (row) =>
                row.weekStart.getTime() === where.weekStart.getTime() &&
                row.reversedAt === where.reversedAt,
            )
            .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime()),
      ),
    },
    sharedKeyWeekAllotment: {
      findMany: vi.fn(async ({ where }: { where: { weekStart: Date } }) =>
        state.allotments
          .filter((row) => row.weekStart.getTime() === where.weekStart.getTime())
          .map((row) => allotment(row)),
      ),
      findUnique: vi.fn(
        async ({ where }: { where: { weekStart_userId: { weekStart: Date; userId: string } } }) => {
          const found = state.allotments.find(
            (row) =>
              row.weekStart.getTime() === where.weekStart_userId.weekStart.getTime() &&
              row.userId === where.weekStart_userId.userId,
          );
          return found ? allotment(found) : null;
        },
      ),
      deleteMany: vi.fn(
        async ({
          where,
        }: {
          where: { weekStart: Date; userId?: string | { notIn: string[] } };
        }) => {
          const before = state.allotments.length;
          state.allotments = state.allotments.filter((row) => {
            if (row.weekStart.getTime() !== where.weekStart.getTime()) return true;
            if (typeof where.userId === "string") return row.userId !== where.userId;
            if (where.userId && typeof where.userId === "object" && "notIn" in where.userId) {
              return where.userId.notIn.includes(row.userId);
            }
            return false;
          });
          return { count: before - state.allotments.length };
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
      create: vi.fn(async ({ data }: { data: Allotment }) => {
        const row = allotment(data);
        state.allotments.push(row);
        return row;
      }),
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
          const row = allotment({
            ...create,
            reservedUsd: create.reservedUsd ?? 0,
            updatedAt: create.updatedAt ?? new Date(),
          });
          state.allotments.push(row);
          return row;
        },
      ),
      update: vi.fn(
        async ({
          where,
          data,
        }: {
          where: { weekStart_userId: { weekStart: Date; userId: string } };
          data: {
            reservedUsd?: number | { increment: number };
            allotmentUsd?: number;
          };
        }) => {
          const row = state.allotments.find(
            (entry) =>
              entry.weekStart.getTime() === where.weekStart_userId.weekStart.getTime() &&
              entry.userId === where.weekStart_userId.userId,
          );
          if (!row) throw new Error("missing allotment");
          if (data.allotmentUsd != null) row.allotmentUsd = data.allotmentUsd;
          if (data.reservedUsd != null) {
            if (typeof data.reservedUsd === "number") row.reservedUsd = data.reservedUsd;
            else row.reservedUsd += data.reservedUsd.increment;
          }
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
    $queryRaw: vi.fn(async (query: { values?: unknown[]; strings?: readonly string[] }) => {
      const sql = Array.isArray(query?.strings) ? query.strings.join("?") : "";
      if (sql.includes("app.rls_bypass")) {
        return [{ bypass: "off", key: "", login: "test" }];
      }
      const key = query && Array.isArray(query.values) ? String(query.values[0] ?? "") : "";
      if (key) locks.push(key);
      return [{ lock: "1" }];
    }),
    $transaction: vi.fn(async (work: (tx: unknown) => Promise<unknown>) => work(client)),
  };
  return { client, locks, auditEvents };
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
        allotment({
          weekStart,
          userId: "a",
          allotmentUsd: 50,
          reservedUsd: 15,
          updatedAt: midweek,
        }),
        allotment({
          weekStart,
          userId: "b",
          allotmentUsd: 50,
          reservedUsd: 0,
          updatedAt: midweek,
        }),
      ],
      usage: [
        { userId: "a", costUsd: 10, sharedKey: true, createdAt: new Date(weekStart.getTime() + 1) },
        { userId: "b", costUsd: 5, sharedKey: true, createdAt: new Date(weekStart.getTime() + 1) },
      ],
      locks,
    };
    const { client } = fakePrisma(state);
    // Headroom: a=25, b=45 → 70. Joiner slice = min(fullShare×frac, 70/3).
    await addSharedKeyBudgetMember(client as never, "c", midweek);
    expect(locks.length).toBeGreaterThan(0);
    expect(locks.every((key) => key === "shared-key-budget:members")).toBe(true);
    const totalHead = 70;
    const proportional = (400 / 3 / 4) * 0.5;
    const cSlice = Math.min(totalHead / 3, proportional);
    const a = state.allotments.find((row) => row.userId === "a");
    const c = state.allotments.find((row) => row.userId === "c");
    // Continuing a is never raised; headroom is taken proportionally for the joiner.
    expect(a?.allotmentUsd).toBeLessThanOrEqual(50);
    expect(a?.allotmentUsd).toBeCloseTo(50 - (cSlice * 25) / totalHead, 5);
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
    // Additive: existing "old" stays; unknown "missing" is skipped.
    expect(state.members.map((m) => m.userId).sort()).toEqual(["a", "old"]);
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
    // Week allotment row is kept (shrunk to spent) so same-week re-add reuses baselines.
    const kept = state.allotments.find((row) => row.userId === "c");
    expect(kept).toBeDefined();
    expect(kept!.allotmentUsd).toBe(0);
  });

  it("reconciles the configurable member set from env-style ids", async () => {
    const state = {
      monthly: 200,
      members: [{ userId: "old", joinedAt: weekStart }],
      allotments: [] as Allotment[],
      usage: [] as Usage[],
      knownUserIds: ["a", "b", "old"],
    };
    const { client } = fakePrisma(state);
    await reconcileSharedKeyBudgetMembers(client as never, ["a", "b"], weekStart);
    expect(state.members.map((m) => m.userId).sort()).toEqual(["a", "b", "old"]);
    expect(
      state.allotments.filter((row) => row.userId === "a" || row.userId === "b").every(
        (row) => row.allotmentUsd > 0,
      ),
    ).toBe(true);
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
    const state: {
      monthly: number | null;
      members: Member[];
      allotments: Allotment[];
      usage: Usage[];
    } = {
      monthly: 50,
      members: [],
      allotments: [],
      usage: [],
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
    const saved = await setSharedKeyMonthlyBudgetUsd(client as never, 200, midweek);
    expect(saved).toEqual({ monthlyCapUsd: 200, previousMonthlyCapUsd: 400 });
    expect(state.monthly).toBe(200);
    // 200 / 2 users / 4 weeks = 25 each.
    expect(state.allotments.map((row) => row.allotmentUsd).sort()).toEqual([25, 25]);
  });

  it("raises the monthly cap mid-week and re-bases existing allotment rows", async () => {
    const state = {
      monthly: 50 as number | null,
      members: [{ userId: "u1", joinedAt: weekStart }],
      allotments: [
        allotment({
          weekStart,
          userId: "u1",
          allotmentUsd: 12.5,
          reservedUsd: 3,
          updatedAt: midweek,
        }),
      ],
      usage: [
        {
          userId: "u1",
          costUsd: 12.5,
          sharedKey: true,
          createdAt: new Date(weekStart.getTime() + 1_000),
        },
      ],
    };
    const { client } = fakePrisma(state);
    // At the old $12.50 allotment the member is hard-stopped; raising the monthly cap to
    // $200 frees pool−committed into the allotment and preserves the in-flight hold.
    await expect(
      reserveSharedKeyBudget(client as never, "u1", 0.01, midweek),
    ).rejects.toBeInstanceOf(SharedKeyWeeklyBudgetExceededError);
    const saved = await setSharedKeyMonthlyBudgetUsd(client as never, 200, midweek);
    expect(saved).toEqual({ monthlyCapUsd: 200, previousMonthlyCapUsd: 50 });
    // free = 50 − (12.5+3) = 34.5 → allotment = 12.5+3+34.5 = 50.
    expect(state.allotments).toEqual([
      expect.objectContaining({ userId: "u1", allotmentUsd: 50, reservedUsd: 3 }),
    ]);
    await expect(
      reserveSharedKeyBudget(client as never, "u1", 1, midweek),
    ).resolves.toBeUndefined();
    expect(state.allotments[0]?.reservedUsd).toBe(4);
  });

  it("lowers the monthly cap mid-week without inventing free budget above the pool", async () => {
    const state = {
      monthly: 200 as number | null,
      members: [
        { userId: "a", joinedAt: weekStart },
        { userId: "b", joinedAt: weekStart },
      ],
      allotments: [
        allotment({
          weekStart,
          userId: "a",
          allotmentUsd: 25,
          reservedUsd: 0,
          updatedAt: midweek,
        }),
        allotment({
          weekStart,
          userId: "b",
          allotmentUsd: 25,
          reservedUsd: 2,
          updatedAt: midweek,
        }),
      ],
      usage: [
        {
          userId: "a",
          costUsd: 20,
          sharedKey: true,
          createdAt: new Date(weekStart.getTime() + 1_000),
        },
      ],
    };
    const { client } = fakePrisma(state);
    // New pool $10; committed = 20+2 = 22 → free 0. Each member keeps eff+res only.
    await setSharedKeyMonthlyBudgetUsd(client as never, 40, midweek);
    expect(
      state.allotments.map((row) => [row.userId, row.allotmentUsd, row.reservedUsd]).sort(),
    ).toEqual([
      ["a", 20, 0],
      ["b", 2, 2],
    ]);
    await expect(
      reserveSharedKeyBudget(client as never, "a", 0.01, midweek),
    ).rejects.toBeInstanceOf(SharedKeyWeeklyBudgetExceededError);
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

  it("resolves personal-key usage only when the caller classified a personal key", async () => {
    const state = {
      monthly: 400,
      members: [{ userId: "u1", joinedAt: weekStart }],
      allotments: [] as Allotment[],
      usage: [] as Usage[],
    };
    const { client } = fakePrisma(state);
    expect(
      await resolveUsageLimitView(client as never, "u1", midweek, null, { personalKey: true }),
    ).toEqual({ kind: "personal_key" });
  });

  it("ignores pre-join shared-key spend for a mid-week joiner", async () => {
    const state = {
      monthly: 400,
      members: [{ userId: "a", joinedAt: weekStart }],
      allotments: [
        { weekStart, userId: "a", allotmentUsd: 50, reservedUsd: 0, updatedAt: midweek },
      ] as Allotment[],
      usage: [
        // Spent before joining — must not count against the pro-rated slice.
        {
          userId: "c",
          costUsd: 40,
          sharedKey: true,
          createdAt: new Date(weekStart.getTime() + 1_000),
        },
      ],
      knownUserIds: ["a", "c"],
    };
    const { client } = fakePrisma(state);
    await addSharedKeyBudgetMember(client as never, "c", midweek);
    const status = await sharedKeyWeeklyBudgetStatus(client as never, "c", midweek);
    expect(status.member).toBe(true);
    expect(status.spentUsd).toBe(0);
    expect(status.weeklyCapUsd).toBeGreaterThan(0);
    expect(status.percentUsed).toBe(0);
    await expect(
      reserveSharedKeyBudget(client as never, "c", 1, midweek),
    ).resolves.toBeUndefined();
  });

  it("keeps a mid-week joiner's join-time want-share across later cap re-bases", async () => {
    const lateWeek = new Date("2026-11-08T05:00:00.000Z");
    const state = {
      monthly: 400 as number | null,
      members: [
        { userId: "a", joinedAt: weekStart },
        { userId: "c", joinedAt: midweek },
      ],
      allotments: [
        allotment({ weekStart, userId: "a", allotmentUsd: 50, reservedUsd: 0, updatedAt: midweek }),
        allotment({
          weekStart,
          userId: "c",
          allotmentUsd: 25,
          reservedUsd: 0,
          joinedAt: midweek,
          updatedAt: midweek,
        }),
      ],
      usage: [] as Usage[],
    };
    const { client } = fakePrisma(state);
    await setSharedKeyMonthlyBudgetUsd(client as never, 400, lateWeek);
    const a = state.allotments.find((row) => row.userId === "a");
    const c = state.allotments.find((row) => row.userId === "c");
    // Free pool $100 split by join-time wants (full vs half), not lateWeek's remainder.
    expect(c?.allotmentUsd).toBeCloseTo(100 * 25 / 75, 5);
    expect(a?.allotmentUsd).toBeCloseTo(100 * 50 / 75, 5);
    expect(c!.allotmentUsd).toBeGreaterThan(10);
  });

  it("adds explicit env includes without removing existing roster members", async () => {
    const state = {
      monthly: 200,
      members: [{ userId: "personal-old", joinedAt: weekStart }],
      allotments: [] as Allotment[],
      usage: [] as Usage[],
      knownUserIds: ["company-a", "personal-old", "explicit-b"],
    };
    const { client } = fakePrisma(state);
    await syncSharedKeyBudgetMembers(
      client as never,
      { companyUserIds: ["company-a"], explicitUserIds: ["explicit-b"] },
      weekStart,
    );
    expect(state.members.map((m) => m.userId).sort()).toEqual([
      "company-a",
      "explicit-b",
      "personal-old",
    ]);
  });

  it("remove/re-add within a week keeps join baseline and spend", async () => {
    const state = {
      monthly: 100, // week pool $25
      members: [{ userId: "u1", joinedAt: weekStart }],
      allotments: [
        allotment({ weekStart, userId: "u1", allotmentUsd: 25, reservedUsd: 0 }),
      ],
      usage: [
        {
          userId: "u1",
          costUsd: 20,
          sharedKey: true,
          createdAt: new Date(weekStart.getTime() + 60_000),
        },
      ] as Usage[],
      knownUserIds: ["u1"],
    };
    const { client } = fakePrisma(state);
    await removeSharedKeyBudgetMember(client as never, "u1", midweek);
    expect(state.members).toHaveLength(0);
    const kept = state.allotments.find((row) => row.userId === "u1");
    expect(kept).toBeDefined();
    expect(kept!.allotmentUsd).toBeCloseTo(20, 5);
    expect(kept!.preJoinSpendUsd).toBe(0);

    await addSharedKeyBudgetMember(client as never, "u1", midweek);
    expect(state.members[0]?.joinedAt).toEqual(weekStart);
    const status = await sharedKeyWeeklyBudgetStatus(client as never, "u1", midweek);
    expect(status.spentUsd).toBe(20);
    await expect(
      reserveSharedKeyBudget(client as never, "u1", 0.01, midweek),
    ).rejects.toBeInstanceOf(SharedKeyWeeklyBudgetExceededError);
  });

  it("reserve auto-enrolls under the lock and ignores pre-join company spend", async () => {
    const state = {
      monthly: 400,
      members: [] as Member[],
      allotments: [] as Allotment[],
      usage: [
        {
          userId: "newbie",
          costUsd: 40,
          sharedKey: true,
          createdAt: new Date(weekStart.getTime() + 1_000),
        },
      ] as Usage[],
      knownUserIds: ["newbie"],
    };
    const { client } = fakePrisma(state);
    await expect(
      reserveSharedKeyBudget(client as never, "newbie", 1, midweek),
    ).resolves.toBeUndefined();
    expect(state.members.map((m) => m.userId)).toEqual(["newbie"]);
    const row = state.allotments.find((a) => a.userId === "newbie");
    expect(row?.preJoinSpendUsd).toBe(40);
    const status = await sharedKeyWeeklyBudgetStatus(client as never, "newbie", midweek);
    expect(status.spentUsd).toBe(0);
    expect(status.percentUsed).toBe(0);
  });

  it("conserves the week pool across remove, re-add, and mid-week join", async () => {
    const state = {
      monthly: 400, // week pool $100
      members: [
        { userId: "a", joinedAt: weekStart },
        { userId: "b", joinedAt: weekStart },
      ],
      allotments: [
        allotment({ weekStart, userId: "a", allotmentUsd: 50, reservedUsd: 0 }),
        allotment({ weekStart, userId: "b", allotmentUsd: 50, reservedUsd: 0 }),
      ],
      usage: [
        {
          userId: "a",
          costUsd: 30,
          sharedKey: true,
          createdAt: new Date(weekStart.getTime() + 1_000),
        },
      ] as Usage[],
      knownUserIds: ["a", "b", "c"],
    };
    const { client } = fakePrisma(state);
    await removeSharedKeyBudgetMember(client as never, "b", midweek);
    // Continuing a is never raised; b's unused headroom is freed for later joiners.
    const aAfterRemove = state.allotments.find((row) => row.userId === "a")!;
    expect(aAfterRemove.allotmentUsd).toBeCloseTo(50, 5);
    const bKept = state.allotments.find((row) => row.userId === "b")!;
    expect(bKept.allotmentUsd).toBe(0);

    await addSharedKeyBudgetMember(client as never, "c", midweek);
    const c = state.allotments.find((row) => row.userId === "c")!;
    expect(c.preJoinSpendUsd).toBe(0);
    expect(c.allotmentUsd).toBeGreaterThan(0);
    expect(c.allotmentUsd).toBeLessThanOrEqual(fullWeekShareUsd(400, 2));
    expect(aAfterRemove.allotmentUsd).toBeLessThanOrEqual(50);

    const active = state.members.map((m) => m.userId);
    const activeAllotmentSum = state.allotments
      .filter((row) => active.includes(row.userId))
      .reduce((sum, row) => sum + row.allotmentUsd, 0);
    expect(activeAllotmentSum).toBeLessThanOrEqual(100 + 1e-6);
  });

  it("never raises a drained member when throwaway accounts auto-enroll", async () => {
    const state = {
      monthly: 100, // week pool $25
      members: [
        { userId: "a", joinedAt: weekStart },
        { userId: "b", joinedAt: weekStart },
      ],
      allotments: [
        allotment({ weekStart, userId: "a", allotmentUsd: 12.5, reservedUsd: 0 }),
        allotment({ weekStart, userId: "b", allotmentUsd: 12.5, reservedUsd: 0 }),
      ],
      usage: [
        {
          userId: "a",
          costUsd: 12.5,
          sharedKey: true,
          createdAt: new Date(weekStart.getTime() + 1_000),
        },
      ] as Usage[],
      knownUserIds: ["a", "b", "t0", "t1", "t2", "t3", "t4"],
      auditEvents: [] as Array<Record<string, unknown>>,
    };
    const { client, auditEvents } = fakePrisma(state);
    for (let i = 0; i < 5; i += 1) {
      const id = `t${i}`;
      try {
        await reserveSharedKeyBudget(client as never, id, 0.01, midweek);
      } catch {
        // Zero-slice enrolls skip; others may hard-stop after a tiny slice.
      }
    }
    const a = state.allotments.find((row) => row.userId === "a")!;
    expect(a.allotmentUsd).toBeLessThanOrEqual(12.5 + 1e-9);
    const activeSum = state.allotments
      .filter((row) => state.members.some((m) => m.userId === row.userId))
      .reduce((sum, row) => sum + row.allotmentUsd, 0);
    expect(activeSum).toBeLessThanOrEqual(25 + 1e-6);
    // No audit row for enrolls that landed at a $0 slice.
    expect(
      auditEvents.every((row) => row.action === "shared_key_budget.member.auto_enrolled"),
    ).toBe(true);
  });

  it("rebase never commits allotments above the week pool once free is clamped", async () => {
    const state = {
      monthly: 100 as number | null, // pool $25
      members: [
        { userId: "a", joinedAt: weekStart },
        { userId: "b", joinedAt: weekStart },
      ],
      allotments: [
        allotment({ weekStart, userId: "a", allotmentUsd: 20, reservedUsd: 0 }),
        allotment({ weekStart, userId: "b", allotmentUsd: 20, reservedUsd: 0 }),
        allotment({ weekStart, userId: "gone", allotmentUsd: 5, reservedUsd: 0 }),
      ],
      usage: [
        {
          userId: "a",
          costUsd: 18,
          sharedKey: true,
          createdAt: new Date(weekStart.getTime() + 1_000),
        },
        {
          userId: "b",
          costUsd: 8,
          sharedKey: true,
          createdAt: new Date(weekStart.getTime() + 1_000),
        },
        {
          userId: "gone",
          costUsd: 5,
          sharedKey: true,
          createdAt: new Date(weekStart.getTime() + 1_000),
        },
      ] as Usage[],
    };
    const { client } = fakePrisma(state);
    // committed = 18+8+5 = 31 > pool 25 → free 0.
    await setSharedKeyMonthlyBudgetUsd(client as never, 100, midweek);
    const active = state.allotments.filter((row) =>
      state.members.some((m) => m.userId === row.userId),
    );
    expect(active.find((row) => row.userId === "a")?.allotmentUsd).toBeCloseTo(18, 5);
    expect(active.find((row) => row.userId === "b")?.allotmentUsd).toBeCloseTo(8, 5);
    const committed = active.reduce((sum, row) => sum + row.allotmentUsd, 0);
    // Allotments equal eff+res; may exceed the new pool when spend already did, but
    // free invents nothing on top — sum equals prior committed of members only (26).
    expect(committed).toBeCloseTo(26, 5);
  });

  it("writes enroll audit inside the transaction and skips $0-slice enrolls", async () => {
    const state = {
      monthly: 100,
      members: [{ userId: "a", joinedAt: weekStart }],
      allotments: [
        allotment({ weekStart, userId: "a", allotmentUsd: 25, reservedUsd: 0 }),
      ],
      usage: [
        {
          userId: "a",
          costUsd: 25,
          sharedKey: true,
          createdAt: new Date(weekStart.getTime() + 1_000),
        },
      ] as Usage[],
      knownUserIds: ["a", "broke"],
      auditEvents: [] as Array<Record<string, unknown>>,
    };
    const { client, auditEvents } = fakePrisma(state);
    // Pool fully drained → joiner slice is 0 → no member, no audit.
    await expect(
      reserveSharedKeyBudget(client as never, "broke", 0.01, midweek),
    ).rejects.toBeInstanceOf(SharedKeyWeeklyBudgetExceededError);
    expect(state.members.map((m) => m.userId)).toEqual(["a"]);
    expect(auditEvents).toHaveLength(0);

    // With headroom, enroll writes audit without dollar metadata.
    state.monthly = 400;
    state.allotments[0]!.allotmentUsd = 100;
    await expect(
      reserveSharedKeyBudget(client as never, "broke", 0.01, midweek),
    ).resolves.toBeUndefined();
    expect(state.members.map((m) => m.userId).sort()).toEqual(["a", "broke"]);
    expect(auditEvents).toHaveLength(1);
    expect(auditEvents[0]).toMatchObject({
      action: "shared_key_budget.member.auto_enrolled",
    });
    const metadata = auditEvents[0]?.metadata as Record<string, unknown>;
    expect(metadata).not.toHaveProperty("preJoinSpendUsd");
    expect(JSON.stringify(metadata)).not.toMatch(/\$/);
  });

  it("does not auto-enroll an ineligible user", async () => {
    const state = {
      monthly: 400,
      members: [] as Member[],
      allotments: [] as Allotment[],
      usage: [] as Usage[],
      knownUserIds: ["stranger"],
      unverifiedUserIds: ["stranger"],
      noMembershipUserIds: ["stranger"],
      auditEvents: [] as Array<Record<string, unknown>>,
    };
    const { client, auditEvents } = fakePrisma(state);
    await expect(
      reserveSharedKeyBudget(client as never, "stranger", 1, midweek),
    ).rejects.toBeInstanceOf(SharedKeyBudgetNotEnrolledError);
    expect(state.members).toHaveLength(0);
    expect(auditEvents).toHaveLength(0);

    // Explicit admin add still applies the bar unless admin bypass is set.
    await addSharedKeyBudgetMember(client as never, "stranger", midweek);
    expect(state.members).toHaveLength(0);
    await addSharedKeyBudgetMember(client as never, "stranger", midweek, {
      admin: true,
      actorUserId: "ops-admin",
    });
    expect(state.members.map((m) => m.userId)).toEqual(["stranger"]);
    expect(auditEvents).toHaveLength(1);
    expect(auditEvents[0]).toMatchObject({ action: "shared_key_budget.member.added" });
  });

  it("under open signups, a verified Personal-org-only user is not auto-enrolled", async () => {
    const open: SharedKeyBudgetEnrollmentPolicy = {
      gatedDeployment: false,
      adminEmails: ["admin@example.com"],
    };
    const state = {
      monthly: 400,
      members: [] as Member[],
      allotments: [] as Allotment[],
      usage: [] as Usage[],
      knownUserIds: ["solo"],
      // Default org-solo is sole-member (personal).
      auditEvents: [] as Array<Record<string, unknown>>,
    };
    const { client, auditEvents } = fakePrisma(state);
    await expect(
      reserveSharedKeyBudget(client as never, "solo", 1, midweek, open),
    ).rejects.toBeInstanceOf(SharedKeyBudgetNotEnrolledError);
    expect(state.members).toHaveLength(0);
    expect(auditEvents).toHaveLength(0);
  });

  it("under open signups, a user sharing a non-personal org with an admin is enrolled", async () => {
    const open: SharedKeyBudgetEnrollmentPolicy = {
      gatedDeployment: false,
      adminEmails: [],
    };
    const state = {
      monthly: 400,
      members: [] as Member[],
      allotments: [] as Allotment[],
      usage: [] as Usage[],
      knownUserIds: ["teammate", "boss"],
      orgPeers: { teammate: ["boss"] },
      adminGrantUserIds: ["boss"],
      auditEvents: [] as Array<Record<string, unknown>>,
    };
    const { client, auditEvents } = fakePrisma(state);
    await expect(
      reserveSharedKeyBudget(client as never, "teammate", 1, midweek, open),
    ).resolves.toBeUndefined();
    expect(state.members.map((m) => m.userId)).toEqual(["teammate"]);
    expect(auditEvents.some((row) => row.action === "shared_key_budget.member.auto_enrolled")).toBe(
      true,
    );
  });

  it("under a gated deployment, a verified member is enrolled", async () => {
    const gated: SharedKeyBudgetEnrollmentPolicy = {
      gatedDeployment: true,
      adminEmails: [],
    };
    const state = {
      monthly: 400,
      members: [] as Member[],
      allotments: [] as Allotment[],
      usage: [] as Usage[],
      knownUserIds: ["solo"],
      auditEvents: [] as Array<Record<string, unknown>>,
    };
    const { client } = fakePrisma(state);
    await expect(
      reserveSharedKeyBudget(client as never, "solo", 1, midweek, gated),
    ).resolves.toBeUndefined();
    expect(state.members.map((m) => m.userId)).toEqual(["solo"]);
  });

  it("admin add enrolls and audits; rebase never raises an overspent member", async () => {
    const state = {
      monthly: 100 as number | null,
      members: [
        { userId: "a", joinedAt: weekStart },
        { userId: "b", joinedAt: weekStart },
      ],
      allotments: [
        allotment({ weekStart, userId: "a", allotmentUsd: 12.5, reservedUsd: 0 }),
        allotment({ weekStart, userId: "b", allotmentUsd: 12.5, reservedUsd: 0 }),
      ],
      usage: [
        {
          userId: "a",
          costUsd: 12.5,
          sharedKey: true,
          createdAt: new Date(weekStart.getTime() + 1_000),
        },
        {
          userId: "b",
          costUsd: 2,
          sharedKey: true,
          createdAt: new Date(weekStart.getTime() + 1_000),
        },
      ] as Usage[],
      knownUserIds: ["a", "b", "pending"],
      auditEvents: [] as Array<Record<string, unknown>>,
    };
    const { client, auditEvents } = fakePrisma(state);
    await setSharedKeyMonthlyBudgetUsd(client as never, 100, midweek);
    expect(state.allotments.find((row) => row.userId === "a")?.allotmentUsd).toBeCloseTo(12.5, 5);
    expect(state.allotments.find((row) => row.userId === "a")!.allotmentUsd).toBeLessThanOrEqual(
      12.5 + 1e-9,
    );
    expect(state.allotments.find((row) => row.userId === "b")?.allotmentUsd).toBeGreaterThan(2);

    const enrolled = await addSharedKeyBudgetMember(client as never, "pending", midweek, {
      admin: true,
      actorUserId: "a",
    });
    expect(enrolled).toBe(true);
    expect(state.members.some((m) => m.userId === "pending")).toBe(true);
    expect(auditEvents.some((row) => row.action === "shared_key_budget.member.added")).toBe(true);
  });
});
