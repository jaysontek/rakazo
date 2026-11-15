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
  userId: string | null;
  deltaUsd: number;
  reason: string;
  createdById: string | null;
  createdAt: Date;
  previousTrackedUsd: number;
  newTrackedUsd: number;
  reversesId: string | null;
};

function fakePrisma(state: { usage: Usage[]; adjustments: Adj[]; locks?: string[] }) {
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
            userId?: string | null | { in: string[] };
            OR?: Array<{ userId: null } | { userId: { in: string[] } }>;
          };
        }) => {
          const sum = state.adjustments
            .filter((row) => {
              if (row.periodStart.getTime() !== where.periodStart.getTime()) return false;
              if (where.OR) {
                return where.OR.some((clause) => {
                  if (clause.userId === null) return row.userId == null;
                  if (clause.userId && typeof clause.userId === "object") {
                    return row.userId != null && clause.userId.in.includes(row.userId);
                  }
                  return false;
                });
              }
              if (where.userId === null) return row.userId == null;
              if (typeof where.userId === "string") return row.userId === where.userId;
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
  let state: { usage: Usage[]; adjustments: Adj[]; locks: string[] };

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
    expect(locks.some((key) => key.includes("shared-key-budget:members"))).toBe(true);
  });

  it("adjusts and reverses under the lock", async () => {
    const { client, locks } = fakePrisma(state);
    const adjusted = await adjustSharedKeyTrackedSpend(client as never, {
      deltaUsd: 4,
      reason: "Rounding",
      createdById: "admin",
      userId: "a",
      now,
    });
    expect(adjusted.newTrackedUsd).toBe(24);
    const reversed = await reverseSharedKeySpendAdjustment(client as never, {
      adjustmentId: adjusted.id,
      reason: "Undo rounding",
      createdById: "admin",
      now,
    });
    expect(reversed.deltaUsd).toBe(-4);
    expect(reversed.reversesId).toBe(adjusted.id);
    expect(reversed.newTrackedUsd).toBe(20);
    expect(locks.filter((key) => key.includes("shared-key-budget:members")).length).toBeGreaterThanOrEqual(
      2,
    );
  });
});
