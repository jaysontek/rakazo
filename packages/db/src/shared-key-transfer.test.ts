import { beforeEach, describe, expect, it, vi } from "vitest";
import { setSharedKeyMonthlyBudgetUsd } from "./shared-key-budget.js";
import {
  listSharedKeyAllotmentTransfers,
  reverseSharedKeyAllotmentTransfer,
  transferSharedKeyAllotment,
} from "./shared-key-transfer.js";

type Member = { userId: string; joinedAt: Date };
type Allotment = {
  weekStart: Date;
  userId: string;
  allotmentUsd: number;
  reservedUsd: number;
  updatedAt: Date;
};
type Usage = { userId: string; costUsd: number; sharedKey: boolean; createdAt: Date };
type Transfer = {
  id: string;
  weekStart: Date;
  fromUserId: string;
  toUserId: string;
  amountUsd: number;
  createdById: string;
  createdAt: Date;
  reversedAt: Date | null;
  reverseNote: string | null;
};

function fakePrisma(state: {
  monthly: number;
  members: Member[];
  allotments: Allotment[];
  usage: Usage[];
  transfers?: Transfer[];
  locks?: string[];
}) {
  const transfers = state.transfers ?? [];
  state.transfers = transfers;
  const locks = state.locks ?? [];
  let nextId = transfers.length + 1;
  const allotment = (weekStart: Date, userId: string) =>
    state.allotments.find(
      (row) => row.weekStart.getTime() === weekStart.getTime() && row.userId === userId,
    );
  const client = {
    deploymentSettings: {
      findUnique: vi.fn(async () => ({ sharedKeyMonthlyBudgetUsd: state.monthly })),
      upsert: vi.fn(async ({ update }: { update: { sharedKeyMonthlyBudgetUsd: number } }) => {
        state.monthly = update.sharedKeyMonthlyBudgetUsd;
        return { sharedKeyMonthlyBudgetUsd: state.monthly };
      }),
    },
    user: {
      findMany: vi.fn(async () => state.members.map(({ userId: id }) => ({ id }))),
    },
    sharedKeyBudgetMember: {
      findUnique: vi.fn(async ({ where }: { where: { userId: string } }) =>
        state.members.find((row) => row.userId === where.userId),
      ),
      findMany: vi.fn(async () =>
        [...state.members].sort((a, b) => a.joinedAt.getTime() - b.joinedAt.getTime()),
      ),
    },
    sharedKeyWeekAllotment: {
      findUnique: vi.fn(
        async ({ where }: { where: { weekStart_userId: { weekStart: Date; userId: string } } }) =>
          allotment(where.weekStart_userId.weekStart, where.weekStart_userId.userId) ?? null,
      ),
      findMany: vi.fn(async ({ where }: { where: { weekStart: Date } }) =>
        state.allotments.filter((row) => row.weekStart.getTime() === where.weekStart.getTime()),
      ),
      update: vi.fn(
        async ({
          where,
          data,
        }: {
          where: { weekStart_userId: { weekStart: Date; userId: string } };
          data: { allotmentUsd: number };
        }) => {
          const row = allotment(where.weekStart_userId.weekStart, where.weekStart_userId.userId);
          if (!row) throw new Error("missing allotment");
          row.allotmentUsd = data.allotmentUsd;
          row.updatedAt = new Date();
          return row;
        },
      ),
      create: vi.fn(async ({ data }: { data: Omit<Allotment, "updatedAt"> }) => {
        const row = { ...data, updatedAt: new Date() };
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
          create: Omit<Allotment, "updatedAt">;
          update: { allotmentUsd: number };
        }) => {
          const row = allotment(where.weekStart_userId.weekStart, where.weekStart_userId.userId);
          if (row) {
            row.allotmentUsd = update.allotmentUsd;
            return row;
          }
          const created = { ...create, updatedAt: new Date() };
          state.allotments.push(created);
          return created;
        },
      ),
      updateMany: vi.fn(async () => ({ count: 0 })),
      deleteMany: vi.fn(async () => ({ count: 0 })),
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
        }) => ({
          _sum: {
            costUsd: state.usage
              .filter(
                (row) =>
                  row.userId === where.userId &&
                  row.sharedKey === where.sharedKey &&
                  row.createdAt >= where.createdAt.gte &&
                  row.createdAt < where.createdAt.lt,
              )
              .reduce((sum, row) => sum + row.costUsd, 0),
          },
        }),
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
          const totals = new Map<string, number>();
          for (const row of state.usage) {
            if (
              where.userId.in.includes(row.userId) &&
              row.sharedKey === where.sharedKey &&
              row.createdAt >= where.createdAt.gte &&
              row.createdAt < where.createdAt.lt
            ) {
              totals.set(row.userId, (totals.get(row.userId) ?? 0) + row.costUsd);
            }
          }
          return [...totals].map(([userId, costUsd]) => ({
            userId,
            _sum: { costUsd },
          }));
        },
      ),
    },
    sharedKeyAllotmentTransfer: {
      create: vi.fn(
        async ({
          data,
        }: {
          data: Omit<Transfer, "id" | "createdAt" | "reversedAt" | "reverseNote">;
        }) => {
          const row: Transfer = {
            ...data,
            id: `transfer-${nextId++}`,
            createdAt: new Date(),
            reversedAt: null,
            reverseNote: null,
          };
          transfers.push(row);
          return row;
        },
      ),
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
        return transfers.find((row) => row.id === where.id) ?? null;
      }),
      update: vi.fn(
        async ({
          where,
          data,
        }: {
          where: { id: string };
          data: { reversedAt: Date; reverseNote: string | null };
        }) => {
          const row = transfers.find((entry) => entry.id === where.id);
          if (!row) throw new Error("missing transfer");
          Object.assign(row, data);
          return row;
        },
      ),
      findMany: vi.fn(
        async ({
          where,
          orderBy,
        }: {
          where: { weekStart: Date; reversedAt?: null };
          orderBy: { createdAt: "asc" | "desc" };
        }) =>
          transfers
            .filter(
              (row) =>
                row.weekStart.getTime() === where.weekStart.getTime() &&
                (where.reversedAt === undefined || row.reversedAt === where.reversedAt),
            )
            .sort((a, b) =>
              orderBy.createdAt === "asc"
                ? a.createdAt.getTime() - b.createdAt.getTime()
                : b.createdAt.getTime() - a.createdAt.getTime(),
            ),
      ),
    },
    $queryRaw: vi.fn(async (query: { values?: unknown[] }) => {
      const key = String(query.values?.[0] ?? "");
      if (key) locks.push(key);
      return [{ lock: "1" }];
    }),
    $transaction: vi.fn(async (work: (tx: unknown) => Promise<unknown>) => work(client)),
  };
  return { client, transfers, locks };
}

describe("shared-key allotment transfers", () => {
  const weekStart = new Date("2026-11-02T05:00:00.000Z");
  const now = new Date("2026-11-05T17:00:00.000Z");
  const members = [
    { userId: "from", joinedAt: weekStart },
    { userId: "to", joinedAt: weekStart },
  ];
  const row = (userId: string, allotmentUsd = 50, reservedUsd = 0): Allotment => ({
    weekStart,
    userId,
    allotmentUsd,
    reservedUsd,
    updatedAt: now,
  });

  beforeEach(() => vi.useRealTimers());

  it("moves all unspent and unreserved source allotment under the members lock", async () => {
    const state = {
      monthly: 400,
      members,
      allotments: [row("from", 50, 5), row("to")],
      usage: [
        {
          userId: "from",
          costUsd: 10,
          sharedKey: true,
          createdAt: new Date(weekStart.getTime() + 1),
        },
      ],
      locks: [] as string[],
    };
    const { client, locks } = fakePrisma(state);
    const transfer = await transferSharedKeyAllotment(client as never, {
      fromUserId: "from",
      toUserId: "to",
      createdById: "admin",
      now,
    });
    expect(transfer).toMatchObject({
      fromUserId: "from",
      toUserId: "to",
      amountUsd: 35,
      reversedAt: null,
    });
    expect(state.allotments.map(({ userId, allotmentUsd }) => [userId, allotmentUsd])).toEqual([
      ["from", 15],
      ["to", 85],
    ]);
    expect(locks).toEqual(["shared-key-budget:members"]);
  });

  it("rejects non-members, self-transfers, and exhausted sources", async () => {
    const base = {
      monthly: 400,
      members,
      allotments: [row("from", 10), row("to")],
      usage: [
        {
          userId: "from",
          costUsd: 10,
          sharedKey: true,
          createdAt: new Date(weekStart.getTime() + 1),
        },
      ],
    };
    const { client } = fakePrisma(base);
    await expect(
      transferSharedKeyAllotment(client as never, {
        fromUserId: "from",
        toUserId: "from",
        createdById: "admin",
        now,
      }),
    ).rejects.toThrow("same user");
    await expect(
      transferSharedKeyAllotment(client as never, {
        fromUserId: "from",
        toUserId: "missing",
        createdById: "admin",
        now,
      }),
    ).rejects.toThrow("roster");
    await expect(
      transferSharedKeyAllotment(client as never, {
        fromUserId: "from",
        toUserId: "to",
        createdById: "admin",
        now,
      }),
    ).rejects.toThrow("no unused allotment");
  });

  it("fully reverses a current-week transfer", async () => {
    const state = {
      monthly: 400,
      members,
      allotments: [row("from"), row("to")],
      usage: [] as Usage[],
    };
    const { client } = fakePrisma(state);
    const transfer = await transferSharedKeyAllotment(client as never, {
      fromUserId: "from",
      toUserId: "to",
      createdById: "admin",
      now,
    });
    const reversed = await reverseSharedKeyAllotmentTransfer(client as never, {
      transferId: transfer.id,
      now,
    });
    expect(reversed.clamped).toBe(false);
    expect(reversed.transfer.reversedAt).toBe(now.toISOString());
    expect(state.allotments.map(({ userId, allotmentUsd }) => [userId, allotmentUsd])).toEqual([
      ["from", 50],
      ["to", 50],
    ]);
  });

  it("restores the source fully while clamping a receiver that already spent the transfer", async () => {
    const state = {
      monthly: 400,
      members,
      allotments: [row("from"), row("to")],
      usage: [] as Usage[],
    };
    const { client } = fakePrisma(state);
    const transfer = await transferSharedKeyAllotment(client as never, {
      fromUserId: "from",
      toUserId: "to",
      createdById: "admin",
      now,
    });
    state.usage.push({
      userId: "to",
      costUsd: 80,
      sharedKey: true,
      createdAt: new Date(weekStart.getTime() + 1),
    });
    const reversed = await reverseSharedKeyAllotmentTransfer(client as never, {
      transferId: transfer.id,
      now,
    });
    expect(reversed.clamped).toBe(true);
    expect(reversed.transfer.reverseNote).toContain("restored $20.00 of $50.00");
    expect(state.allotments.map(({ userId, allotmentUsd }) => [userId, allotmentUsd])).toEqual([
      ["from", 50],
      ["to", 80],
    ]);
  });

  it("rejects repeated and prior-week reversals", async () => {
    const transfer: Transfer = {
      id: "old",
      weekStart,
      fromUserId: "from",
      toUserId: "to",
      amountUsd: 10,
      createdById: "admin",
      createdAt: now,
      reversedAt: null,
      reverseNote: null,
    };
    const { client } = fakePrisma({
      monthly: 400,
      members,
      allotments: [row("from"), row("to")],
      usage: [],
      transfers: [transfer],
    });
    await expect(
      reverseSharedKeyAllotmentTransfer(client as never, {
        transferId: "old",
        now: new Date("2026-11-12T17:00:00.000Z"),
      }),
    ).rejects.toThrow("prior week");
    transfer.reversedAt = now;
    await expect(
      reverseSharedKeyAllotmentTransfer(client as never, { transferId: "old", now }),
    ).rejects.toThrow("already reversed");
  });

  it("lists one week newest first, including reversed transfers", async () => {
    const older = new Date(now.getTime() - 1_000);
    const transfer = (id: string, createdAt: Date, reversedAt: Date | null): Transfer => ({
      id,
      weekStart,
      fromUserId: "from",
      toUserId: "to",
      amountUsd: 10,
      createdById: "admin",
      createdAt,
      reversedAt,
      reverseNote: null,
    });
    const { client } = fakePrisma({
      monthly: 400,
      members,
      allotments: [],
      usage: [],
      transfers: [transfer("older", older, now), transfer("newer", now, null)],
    });
    const rows = await listSharedKeyAllotmentTransfers(client as never, weekStart);
    expect(rows.map((entry) => entry.id)).toEqual(["newer", "older"]);
    expect(rows[1]?.reversedAt).toBe(now.toISOString());
  });

  it("reapplies an active transfer after raising and rebasing the cap", async () => {
    const state = {
      monthly: 400,
      members,
      allotments: [row("from"), row("to")],
      usage: [] as Usage[],
    };
    const { client } = fakePrisma(state);
    await transferSharedKeyAllotment(client as never, {
      fromUserId: "from",
      toUserId: "to",
      createdById: "admin",
      now,
    });
    await setSharedKeyMonthlyBudgetUsd(client as never, 800, now);
    expect(state.allotments.map(({ userId, allotmentUsd }) => [userId, allotmentUsd])).toEqual([
      ["from", 50],
      ["to", 150],
    ]);
  });
});
