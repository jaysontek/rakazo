import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  adjustSharedKeyTrackedSpend,
  reverseSharedKeySpendAdjustment,
  setSharedKeyTrackedSpend,
} from "./shared-key-spend-adjustments.js";

type Usage = { userId: string; costUsd: number; sharedKey: boolean; createdAt: Date };
type Adj = {
  id: string;
  periodStart: Date;
  periodEnd: Date | null;
  scope: string;
  userId: string | null;
  userIdSnapshot: string | null;
  deltaUsd: number;
  reason: string;
  createdById: string | null;
  createdByIdSnapshot: string | null;
  createdByEmailSnapshot: string | null;
  createdAt: Date;
  previousTrackedUsd: number;
  newTrackedUsd: number;
  reversesId: string | null;
};

function fakePrisma(
  state: {
    usage: Usage[];
    adjustments: Adj[];
    locks?: string[];
    settings?: Record<string, unknown>;
  },
) {
  const locks = state.locks ?? [];
  let nextId = 1;
  const client = {
    deploymentSettings: {
      findUnique: vi.fn(async () => ({
        sharedKeyPeriod: null,
        sharedKeyResetDow: null,
        sharedKeyResetDom: null,
        sharedKeyResetMinutes: null,
        sharedKeyTimezone: null,
        sharedKeyActivePeriodStart: null,
        ...state.settings,
      })),
    },
    user: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) =>
        where.id
          ? { id: where.id, email: `${where.id}@example.com`, name: where.id }
          : null,
      ),
    },
    sharedKeyWeekAllotment: {
      findUnique: vi.fn(async () => null),
    },
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
              if (where.createdAt?.gte && row.createdAt < where.createdAt.gte) return false;
              if (where.createdAt?.lt && !(row.createdAt < where.createdAt.lt)) return false;
              return true;
            })
            .reduce((acc, row) => acc + row.costUsd, 0);
          return { _sum: { costUsd: sum } };
        },
      ),
      groupBy: vi.fn(async () => []),
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
          const sum = state.adjustments
            .filter((row) => {
              if (row.periodStart.getTime() !== where.periodStart.getTime()) return false;
              if (where.scope && row.scope !== where.scope) return false;
              if (where.createdAt?.lt && !(row.createdAt < where.createdAt.lt)) return false;
              if (where.createdAt?.gte && row.createdAt < where.createdAt.gte) return false;
              if (where.OR) {
                return where.OR.some((clause) => {
                  if (clause.scope === "team") return row.scope === "team";
                  if (clause.userIdSnapshot && typeof clause.userIdSnapshot === "object") {
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
                  if (typeof clause.userId === "string") return row.userId === clause.userId;
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
              return true;
            })
            .reduce((acc, row) => acc + row.deltaUsd, 0);
          return { _sum: { deltaUsd: sum } };
        },
      ),
      groupBy: vi.fn(async () => []),
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) =>
        state.adjustments.find((row) => row.id === where.id) ?? null,
      ),
      findFirst: vi.fn(
        async ({ where }: { where: { reversesId: string } }) =>
          state.adjustments.find((row) => row.reversesId === where.reversesId) ?? null,
      ),
      create: vi.fn(async ({ data }: { data: Omit<Adj, "id" | "createdAt"> & { createdAt?: Date } }) => {
        if (
          data.reversesId &&
          state.adjustments.some((row) => row.reversesId === data.reversesId)
        ) {
          const err = new Error("Unique constraint failed") as Error & { code: string };
          err.code = "P2002";
          // Mimic Prisma unique violation on reversesId.
          Object.setPrototypeOf(err, Object.getPrototypeOf({ code: "P2002" }));
          throw Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
        }
        const row: Adj = {
          id: `adj_${nextId++}`,
          createdAt: new Date(),
          ...data,
        };
        state.adjustments.push(row);
        return row;
      }),
    },
    $queryRaw: vi.fn(async (query: { values?: unknown[] }) => {
      const key = Array.isArray(query?.values) ? String(query.values[0] ?? "") : "";
      if (key) locks.push(key);
      return [{ lock: "1" }];
    }),
    $transaction: vi.fn(async (work: (tx: unknown) => Promise<unknown>) => work(client)),
  };
  return { client, locks };
}

describe("shared-key spend adjustments", () => {
  const periodStart = new Date("2026-11-02T05:00:00.000Z");
  const now = new Date("2026-11-05T12:00:00.000Z");
  let state: {
    usage: Usage[];
    adjustments: Adj[];
    locks: string[];
    settings?: Record<string, unknown>;
  };

  beforeEach(() => {
    state = {
      usage: [
        {
          userId: "a",
          costUsd: 20,
          sharedKey: true,
          createdAt: new Date(periodStart.getTime() + 1_000),
        },
        {
          userId: "a",
          costUsd: 50,
          sharedKey: false,
          createdAt: new Date(periodStart.getTime() + 2_000),
        },
      ],
      adjustments: [],
      locks: [],
    };
  });

  it("sets tracked spend as a delta and ignores personal-key usage", async () => {
    const { client, locks } = fakePrisma(state);
    const row = await setSharedKeyTrackedSpend(client as never, {
      targetUsd: 30,
      reason: "Match Google bill",
      createdById: "admin",
      userId: "a",
      now,
    });
    expect(row.previousTrackedUsd).toBe(20);
    expect(row.newTrackedUsd).toBe(30);
    expect(row.deltaUsd).toBe(10);
    expect(row.scope).toBe("user");
    expect(row.userIdSnapshot).toBe("a");
    expect(row.createdByIdSnapshot).toBe("admin");
    expect(locks.some((key) => key.includes("shared-key-budget:members"))).toBe(true);
  });

  it("rejects a negative targetUsd", async () => {
    const { client } = fakePrisma(state);
    await expect(
      setSharedKeyTrackedSpend(client as never, {
        targetUsd: -1,
        reason: "bad",
        createdById: "admin",
        userId: "a",
        now,
      }),
    ).rejects.toThrow(/non-negative/);
  });

  it("rejects a delta that would drive tracked spend below zero", async () => {
    const { client } = fakePrisma(state);
    await expect(
      adjustSharedKeyTrackedSpend(client as never, {
        deltaUsd: -25,
        reason: "too negative",
        createdById: "admin",
        userId: "a",
        now,
      }),
    ).rejects.toThrow(/below zero/);
  });

  it("counts adjustments toward tracked spend so a member can exceed their allotment ceiling", async () => {
    // Allotment hard-stop uses tracked spend (usage + adjustments). A +15 adjustment
    // on $20 usage leaves tracked at $35 — above a $25 weekly allotment — so ops
    // cannot hide over-cap reality by leaving adjustments out of the ceiling math.
    const { client } = fakePrisma(state);
    vi.mocked(client.sharedKeyWeekAllotment.findUnique).mockResolvedValue({
      preJoinSpendUsd: 0,
      allotmentUsd: 25,
    } as never);
    const row = await adjustSharedKeyTrackedSpend(client as never, {
      deltaUsd: 15,
      reason: "Bill catch-up",
      createdById: "admin",
      userId: "a",
      now,
    });
    expect(row.newTrackedUsd).toBe(35);
    expect(row.newTrackedUsd).toBeGreaterThan(25);
  });

  it("rounds target and delta to cents", async () => {
    const { client } = fakePrisma(state);
    const row = await setSharedKeyTrackedSpend(client as never, {
      targetUsd: 20.126,
      reason: "cents",
      createdById: "admin",
      userId: "a",
      now,
    });
    expect(row.newTrackedUsd).toBe(20.13);
    expect(row.deltaUsd).toBe(0.13);
  });

  it("adjusts and reverses under the lock on the original period", async () => {
    const { client, locks } = fakePrisma(state);
    const adjusted = await adjustSharedKeyTrackedSpend(client as never, {
      deltaUsd: 4,
      reason: "Rounding",
      createdById: "admin",
      userId: "a",
      now,
    });
    expect(adjusted.newTrackedUsd).toBe(24);
    expect(adjusted.periodStart).toBe(periodStart.toISOString());

    // Simulate a later period by changing deployment settings return... but reverse
    // must still land on the original periodStart.
    const later = new Date("2026-11-12T12:00:00.000Z");
    const reversed = await reverseSharedKeySpendAdjustment(client as never, {
      adjustmentId: adjusted.id,
      reason: "Undo rounding",
      createdById: "admin",
      now: later,
    });
    expect(reversed.deltaUsd).toBe(-4);
    expect(reversed.reversesId).toBe(adjusted.id);
    expect(reversed.periodStart).toBe(adjusted.periodStart);
    expect(reversed.newTrackedUsd).toBe(20);
    expect(locks.filter((key) => key.includes("shared-key-budget:members")).length).toBeGreaterThanOrEqual(
      2,
    );

    await expect(
      reverseSharedKeySpendAdjustment(client as never, {
        adjustmentId: adjusted.id,
        reason: "again",
        createdById: "admin",
        now: later,
      }),
    ).rejects.toThrow(/already reversed/);
  });

  it("computes reverse tracked totals at the original period end, not now", async () => {
    const { client } = fakePrisma(state);
    const adjusted = await adjustSharedKeyTrackedSpend(client as never, {
      deltaUsd: 5,
      reason: "prior",
      createdById: "admin",
      userId: "a",
      now,
    });
    expect(adjusted.previousTrackedUsd).toBe(20);
    expect(adjusted.newTrackedUsd).toBe(25);

    // Usage after the original Monday week ends must not inflate reverse tracked figures.
    const periodEnd = new Date("2026-11-09T05:00:00.000Z");
    state.usage.push({
      userId: "a",
      costUsd: 100,
      sharedKey: true,
      createdAt: new Date(periodEnd.getTime() + 60_000),
    });
    const later = new Date("2026-11-12T12:00:00.000Z");
    const reversed = await reverseSharedKeySpendAdjustment(client as never, {
      adjustmentId: adjusted.id,
      reason: "undo prior",
      createdById: "admin",
      now: later,
    });
    expect(reversed.periodStart).toBe(periodStart.toISOString());
    // until = period end → usage still 20 (+ adj 5) before reverse, not 120.
    expect(reversed.previousTrackedUsd).toBe(25);
    expect(reversed.newTrackedUsd).toBe(20);
  });

  it("stores periodEnd at write and ignores a later schedule change on reverse", async () => {
    const { client } = fakePrisma(state);
    const adjusted = await adjustSharedKeyTrackedSpend(client as never, {
      deltaUsd: 5,
      reason: "prior",
      createdById: "admin",
      userId: "a",
      now,
    });
    // Default week schedule: Mon 05:00Z → next Mon 05:00Z.
    const storedEnd = new Date("2026-11-09T05:00:00.000Z");
    expect(adjusted.periodEnd).toBe(storedEnd.toISOString());
    expect(state.adjustments[0]!.periodEnd?.toISOString()).toBe(storedEnd.toISOString());

    // Change deployment schedule to monthly — must not move the stored window.
    state.settings = {
      sharedKeyPeriod: "month",
      sharedKeyResetDow: null,
      sharedKeyResetDom: 1,
      sharedKeyResetMinutes: null,
      sharedKeyTimezone: null,
      sharedKeyActivePeriodStart: null,
    };
    // Usage after the original week end but inside a monthly window.
    state.usage.push({
      userId: "a",
      costUsd: 100,
      sharedKey: true,
      createdAt: new Date(storedEnd.getTime() + 60_000),
    });
    const later = new Date("2026-11-20T12:00:00.000Z");
    const reversed = await reverseSharedKeySpendAdjustment(client as never, {
      adjustmentId: adjusted.id,
      reason: "undo prior",
      createdById: "admin",
      now: later,
    });
    expect(reversed.periodEnd).toBe(storedEnd.toISOString());
    // until = stored week end → post-week usage excluded.
    expect(reversed.previousTrackedUsd).toBe(25);
    expect(reversed.newTrackedUsd).toBe(20);
  });

  it("blocks reversing a reversal row", async () => {
    const { client } = fakePrisma(state);
    const adjusted = await adjustSharedKeyTrackedSpend(client as never, {
      deltaUsd: 3,
      reason: "bump",
      createdById: "admin",
      userId: "a",
      now,
    });
    const reversed = await reverseSharedKeySpendAdjustment(client as never, {
      adjustmentId: adjusted.id,
      reason: "undo bump",
      createdById: "admin",
      now,
    });
    await expect(
      reverseSharedKeySpendAdjustment(client as never, {
        adjustmentId: reversed.id,
        reason: "undo the undo",
        createdById: "admin",
        now,
      }),
    ).rejects.toThrow(/Cannot reverse a reversal/);
  });

  it("toRow rejects an unknown scope", async () => {
    const { client } = fakePrisma(state);
    const row = await adjustSharedKeyTrackedSpend(client as never, {
      deltaUsd: 1,
      reason: "ok",
      createdById: "admin",
      userId: "a",
      now,
    });
    expect(row.scope).toBe("user");
    // Corrupt the stored row and ensure list/toRow would throw via reverse path scope check.
    state.adjustments[0]!.scope = "weird";
    await expect(
      reverseSharedKeySpendAdjustment(client as never, {
        adjustmentId: row.id,
        reason: "nope",
        createdById: "admin",
        now,
      }),
    ).rejects.toThrow(/Invalid spend-adjustment scope/);
  });
});
