import {
  fullWeekShareUsd,
  redivideWeeklyAllotments,
  SHARED_KEY_BUDGET_TIMEZONE,
  sharedKeyBudgetPercentUsed,
  sharedKeyWeekEnd,
  sharedKeyWeekStart,
} from "@rakazo/core";
import type { PrismaClient } from "./client.js";
import { Prisma } from "./client.js";

type BudgetPrisma = Pick<
  PrismaClient,
  | "deploymentSettings"
  | "sharedKeyBudgetMember"
  | "sharedKeyWeekAllotment"
  | "usageRecord"
  | "user"
  | "$transaction"
  | "$queryRaw"
>;

type BudgetTx = Pick<
  Prisma.TransactionClient,
  "sharedKeyBudgetMember" | "sharedKeyWeekAllotment" | "usageRecord" | "deploymentSettings" | "$queryRaw"
>;

export type SharedKeyWeeklyBudgetStatus = {
  enabled: boolean;
  member: boolean;
  weeklyCapUsd: number;
  spentUsd: number;
  reservedUsd: number;
  percentUsed: number;
  weekStartsAt: string;
  resetsAt: string;
  timezone: typeof SHARED_KEY_BUDGET_TIMEZONE;
};

async function lockSharedKeyBudget(tx: Pick<BudgetTx, "$queryRaw">, key: string) {
  await tx.$queryRaw(Prisma.sql`
    SELECT pg_advisory_xact_lock(hashtextextended(${`shared-key-budget:${key}`}, 0))::text AS "lock"
  `);
}

export async function sharedKeyMonthlyBudgetUsd(
  prisma: Pick<BudgetPrisma, "deploymentSettings">,
): Promise<number | null> {
  const settings = await prisma.deploymentSettings.findUnique({
    where: { id: "default" },
    select: { sharedKeyMonthlyBudgetUsd: true },
  });
  const value = settings?.sharedKeyMonthlyBudgetUsd;
  return value != null && value > 0 ? value : null;
}

export async function listSharedKeyBudgetMembers(
  prisma: Pick<BudgetPrisma, "sharedKeyBudgetMember"> | Pick<BudgetTx, "sharedKeyBudgetMember">,
): Promise<Array<{ userId: string; joinedAt: Date }>> {
  return prisma.sharedKeyBudgetMember.findMany({
    select: { userId: true, joinedAt: true },
    orderBy: { joinedAt: "asc" },
  });
}

async function spentSharedKeyUsd(
  prisma: Pick<BudgetTx, "usageRecord">,
  userId: string,
  weekStart: Date,
  now: Date,
): Promise<number> {
  const { _sum } = await prisma.usageRecord.aggregate({
    _sum: { costUsd: true },
    where: {
      userId,
      sharedKey: true,
      createdAt: { gte: weekStart, lt: now },
    },
  });
  return _sum.costUsd ?? 0;
}

async function spentByMembers(
  prisma: Pick<BudgetTx, "usageRecord">,
  userIds: string[],
  weekStart: Date,
  now: Date,
): Promise<Map<string, number>> {
  const spent = new Map<string, number>();
  if (userIds.length === 0) return spent;
  const groups = await prisma.usageRecord.groupBy({
    by: ["userId"],
    where: {
      userId: { in: userIds },
      sharedKey: true,
      createdAt: { gte: weekStart, lt: now },
    },
    _sum: { costUsd: true },
  });
  for (const group of groups) {
    spent.set(group.userId, group._sum.costUsd ?? 0);
  }
  return spent;
}

async function previousAllotments(
  prisma: Pick<BudgetTx, "sharedKeyWeekAllotment">,
  weekStart: Date,
): Promise<Map<string, number>> {
  const rows = await prisma.sharedKeyWeekAllotment.findMany({
    where: { weekStart },
    select: { userId: true, allotmentUsd: true },
  });
  return new Map(rows.map((row) => [row.userId, row.allotmentUsd]));
}

/**
 * Rewrite this week's allotments from the current member set and remaining pool.
 * Call after add/remove, and lazily when checking a user's budget.
 */
export async function recomputeSharedKeyWeekAllotments(
  prisma: Pick<BudgetPrisma, "$transaction">,
  now = new Date(),
): Promise<Map<string, number>> {
  return prisma.$transaction(async (tx) => {
    await lockSharedKeyBudget(tx, "members");
    return recomputeSharedKeyWeekAllotmentsTx(tx, now);
  });
}

async function recomputeSharedKeyWeekAllotmentsTx(
  tx: BudgetTx,
  now: Date,
): Promise<Map<string, number>> {
  const settings = await tx.deploymentSettings.findUnique({
    where: { id: "default" },
    select: { sharedKeyMonthlyBudgetUsd: true },
  });
  const monthly = settings?.sharedKeyMonthlyBudgetUsd;
  const weekStart = sharedKeyWeekStart(now);
  const members = await listSharedKeyBudgetMembers(tx);
  if (!(monthly != null && monthly > 0) || members.length === 0) {
    await tx.sharedKeyWeekAllotment.deleteMany({ where: { weekStart } });
    return new Map();
  }

  const memberIds = members.map((m) => m.userId);
  const priorIds = [
    ...new Set([
      ...memberIds,
      ...(await tx.sharedKeyWeekAllotment.findMany({ where: { weekStart }, select: { userId: true } }))
        .map((row) => row.userId),
    ]),
  ];
  const allotments = redivideWeeklyAllotments({
    monthlyCapUsd: monthly,
    members,
    weekStart,
    now,
    previousAllotments: await previousAllotments(tx, weekStart),
    spentByUser: await spentByMembers(tx, priorIds, weekStart, now),
  });

  await tx.sharedKeyWeekAllotment.deleteMany({
    where: { weekStart, userId: { notIn: [...allotments.keys()] } },
  });
  for (const [userId, allotmentUsd] of allotments) {
    await tx.sharedKeyWeekAllotment.upsert({
      where: { weekStart_userId: { weekStart, userId } },
      create: { weekStart, userId, allotmentUsd, reservedUsd: 0 },
      update: { allotmentUsd },
    });
  }
  return allotments;
}

/** Add a user to the shared-key budget set and re-divide the current week. */
export async function addSharedKeyBudgetMember(
  prisma: Pick<BudgetPrisma, "$transaction">,
  userId: string,
  joinedAt = new Date(),
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await lockSharedKeyBudget(tx, "members");
    await tx.sharedKeyBudgetMember.upsert({
      where: { userId },
      create: { userId, joinedAt },
      update: {},
    });
    await recomputeSharedKeyWeekAllotmentsTx(tx, joinedAt);
  });
}

/** Remove a user from the shared-key budget set and re-divide remaining budget. */
export async function removeSharedKeyBudgetMember(
  prisma: Pick<BudgetPrisma, "$transaction">,
  userId: string,
  now = new Date(),
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await lockSharedKeyBudget(tx, "members");
    await tx.sharedKeyBudgetMember.deleteMany({ where: { userId } });
    await recomputeSharedKeyWeekAllotmentsTx(tx, now);
  });
}

/**
 * Make the member set match `userIds` (order ignored). Adds missing users at `now`,
 * removes extras, then re-divides. Used when syncing SHARED_KEY_BUDGET_USER_IDS.
 */
export async function reconcileSharedKeyBudgetMembers(
  prisma: Pick<BudgetPrisma, "$transaction">,
  userIds: string[],
  now = new Date(),
): Promise<void> {
  const wanted = [...new Set(userIds.filter(Boolean))];
  await prisma.$transaction(async (tx) => {
    await lockSharedKeyBudget(tx, "members");
    const existing = await tx.sharedKeyBudgetMember.findMany({ select: { userId: true } });
    const have = new Set(existing.map((row) => row.userId));
    const want = new Set(wanted);
    for (const userId of want) {
      if (!have.has(userId)) {
        await tx.sharedKeyBudgetMember.create({ data: { userId, joinedAt: now } });
      }
    }
    for (const userId of have) {
      if (!want.has(userId)) {
        await tx.sharedKeyBudgetMember.delete({ where: { userId } });
      }
    }
    await recomputeSharedKeyWeekAllotmentsTx(tx, now);
  });
}

async function ensureMemberAllotment(
  tx: BudgetTx,
  userId: string,
  weekStart: Date,
  now: Date,
): Promise<{ allotmentUsd: number; reservedUsd: number } | null> {
  const member = await tx.sharedKeyBudgetMember.findUnique({ where: { userId } });
  if (!member) return null;
  let row = await tx.sharedKeyWeekAllotment.findUnique({
    where: { weekStart_userId: { weekStart, userId } },
  });
  if (!row || row.weekStart.getTime() !== weekStart.getTime()) {
    await recomputeSharedKeyWeekAllotmentsTx(tx, now);
    row = await tx.sharedKeyWeekAllotment.findUnique({
      where: { weekStart_userId: { weekStart, userId } },
    });
  }
  return row ? { allotmentUsd: row.allotmentUsd, reservedUsd: row.reservedUsd } : null;
}

/**
 * Hard-stop gate for a shared-key model call. Personal keys never call this.
 * Reserves `maxCostUsd` against the weekly allotment until `releaseSharedKeyBudgetHold`.
 */
export async function reserveSharedKeyBudget(
  prisma: Pick<BudgetPrisma, "$transaction">,
  userId: string,
  maxCostUsd: number,
  now = new Date(),
): Promise<void> {
  if (!Number.isFinite(maxCostUsd) || maxCostUsd < 0) {
    throw new Error("Invalid shared-key budget reservation");
  }
  await prisma.$transaction(async (tx) => {
    await lockSharedKeyBudget(tx, userId);
    const settings = await tx.deploymentSettings.findUnique({
      where: { id: "default" },
      select: { sharedKeyMonthlyBudgetUsd: true },
    });
    const monthly = settings?.sharedKeyMonthlyBudgetUsd;
    if (!(monthly != null && monthly > 0)) return;

    const weekStart = sharedKeyWeekStart(now);
    const allotment = await ensureMemberAllotment(tx, userId, weekStart, now);
    // Feature on but user not in the shared-key set: no shared-key spend allowed.
    const cap = allotment?.allotmentUsd ?? 0;
    const reserved = allotment?.reservedUsd ?? 0;
    const spent = await spentSharedKeyUsd(tx, userId, weekStart, now);
    // At or over the cap: refuse every further shared-key call (including zero-estimate probes).
    const over =
      spent + reserved >= cap || (maxCostUsd > 0 && spent + reserved + maxCostUsd > cap);
    if (!allotment || over) {
      throw new SharedKeyWeeklyBudgetExceededError();
    }
    await tx.sharedKeyWeekAllotment.update({
      where: { weekStart_userId: { weekStart, userId } },
      data: { reservedUsd: { increment: maxCostUsd } },
    });
  });
}

/** Drop the soft hold after the call settles (usage_records keep the spend). */
export async function releaseSharedKeyBudgetHold(
  prisma: Pick<BudgetPrisma, "$transaction">,
  userId: string,
  maxCostUsd: number,
  now = new Date(),
): Promise<void> {
  if (!Number.isFinite(maxCostUsd) || maxCostUsd <= 0) return;
  await prisma.$transaction(async (tx) => {
    await lockSharedKeyBudget(tx, userId);
    const weekStart = sharedKeyWeekStart(now);
    const row = await tx.sharedKeyWeekAllotment.findUnique({
      where: { weekStart_userId: { weekStart, userId } },
    });
    if (!row) return;
    await tx.sharedKeyWeekAllotment.update({
      where: { weekStart_userId: { weekStart, userId } },
      data: { reservedUsd: Math.max(0, row.reservedUsd - maxCostUsd) },
    });
  });
}

/**
 * Read-only status for API percent-used. Null-ish fields when the feature is off or
 * the user is not on the shared-key set.
 */
export async function sharedKeyWeeklyBudgetStatus(
  prisma: BudgetPrisma,
  userId: string,
  now = new Date(),
): Promise<SharedKeyWeeklyBudgetStatus> {
  const weekStart = sharedKeyWeekStart(now);
  const resetsAt = sharedKeyWeekEnd(weekStart);
  const monthly = await sharedKeyMonthlyBudgetUsd(prisma);
  const member = await prisma.sharedKeyBudgetMember.findUnique({ where: { userId } });
  if (!monthly || !member) {
    return {
      enabled: Boolean(monthly),
      member: Boolean(member),
      weeklyCapUsd: 0,
      spentUsd: 0,
      reservedUsd: 0,
      percentUsed: 0,
      weekStartsAt: weekStart.toISOString(),
      resetsAt: resetsAt.toISOString(),
      timezone: SHARED_KEY_BUDGET_TIMEZONE,
    };
  }

  await recomputeSharedKeyWeekAllotments(prisma, now);
  const row = await prisma.sharedKeyWeekAllotment.findUnique({
    where: { weekStart_userId: { weekStart, userId } },
  });
  const spentUsd = await prisma.$transaction((tx) => spentSharedKeyUsd(tx, userId, weekStart, now));
  const weeklyCapUsd = row?.allotmentUsd ?? fullWeekShareUsd(monthly, 1);
  const reservedUsd = row?.reservedUsd ?? 0;
  return {
    enabled: true,
    member: true,
    weeklyCapUsd,
    spentUsd,
    reservedUsd,
    percentUsed: sharedKeyBudgetPercentUsed(spentUsd, weeklyCapUsd),
    weekStartsAt: weekStart.toISOString(),
    resetsAt: resetsAt.toISOString(),
    timezone: SHARED_KEY_BUDGET_TIMEZONE,
  };
}

export class SharedKeyWeeklyBudgetExceededError extends Error {
  constructor(message = "shared key weekly budget exceeded") {
    super(message);
    this.name = "SharedKeyWeeklyBudgetExceededError";
  }
}

