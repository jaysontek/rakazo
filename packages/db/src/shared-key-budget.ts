import {
  fullWeekShareUsd,
  parseSharedKeyMonthlyBudgetInput,
  redivideWeeklyAllotments,
  SHARED_KEY_BUDGET_TIMEZONE,
  sharedKeyBudgetPercentUsed,
  sharedKeyWeekEnd,
  sharedKeyWeekStart,
} from "@rakazo/core";
import { getLogger } from "@rakazo/logging";
import type { PrismaClient } from "./client.js";
import { Prisma } from "./client.js";
import { reapplyActiveTransfersTx } from "./shared-key-transfer.js";

type BudgetPrisma = Pick<
  PrismaClient,
  | "deploymentSettings"
  | "sharedKeyBudgetMember"
  | "sharedKeyWeekAllotment"
  | "sharedKeyAllotmentTransfer"
  | "usageRecord"
  | "user"
  | "$transaction"
  | "$queryRaw"
>;

type BudgetTx = Pick<
  Prisma.TransactionClient,
  | "sharedKeyBudgetMember"
  | "sharedKeyWeekAllotment"
  | "sharedKeyAllotmentTransfer"
  | "usageRecord"
  | "deploymentSettings"
  | "user"
  | "$queryRaw"
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

/** Soft holds older than this are treated as abandoned (worker crash / deploy kill). */
export const SHARED_KEY_BUDGET_HOLD_STALE_MS = 30 * 60 * 1000;

const MEMBERS_LOCK = "members";

async function lockSharedKeyBudget(tx: Pick<BudgetTx, "$queryRaw">, key: string) {
  await tx.$queryRaw(Prisma.sql`
    SELECT pg_advisory_xact_lock(hashtextextended(${`shared-key-budget:${key}`}, 0))::text AS "lock"
  `);
}

/**
 * Effective monthly shared-key cap: a positive DB value wins; otherwise `envFallback`
 * (from SHARED_KEY_MONTHLY_BUDGET_USD). Null/non-positive disables the hard-stop.
 */
export async function sharedKeyMonthlyBudgetUsd(
  prisma: Pick<BudgetPrisma, "deploymentSettings">,
  envFallback: number | null = null,
): Promise<number | null> {
  const settings = await prisma.deploymentSettings.findUnique({
    where: { id: "default" },
    select: { sharedKeyMonthlyBudgetUsd: true },
  });
  const db = settings?.sharedKeyMonthlyBudgetUsd;
  if (db != null && db > 0) return db;
  return envFallback != null && envFallback > 0 ? envFallback : null;
}

/**
 * Persist an admin override for the monthly shared-key cap and re-base this week's
 * allotments on the new cap (monthly/4/n), not the leftover old-pool redistrib.
 * Rejects non-positive or over-cap values. Returns the saved cap and the previous DB value.
 */
export async function setSharedKeyMonthlyBudgetUsd(
  prisma: Pick<BudgetPrisma, "$transaction" | "deploymentSettings">,
  monthlyCapUsd: number,
  now = new Date(),
): Promise<{ monthlyCapUsd: number; previousMonthlyCapUsd: number | null }> {
  const parsed = parseSharedKeyMonthlyBudgetInput(monthlyCapUsd);
  if (parsed == null) throw new Error("Invalid shared-key monthly budget");
  let previousMonthlyCapUsd: number | null = null;
  await prisma.$transaction(async (tx) => {
    await lockSharedKeyBudget(tx, MEMBERS_LOCK);
    const existing = await tx.deploymentSettings.findUnique({
      where: { id: "default" },
      select: { sharedKeyMonthlyBudgetUsd: true },
    });
    previousMonthlyCapUsd = existing?.sharedKeyMonthlyBudgetUsd ?? null;
    await tx.deploymentSettings.upsert({
      where: { id: "default" },
      create: { id: "default", sharedKeyMonthlyBudgetUsd: parsed },
      update: { sharedKeyMonthlyBudgetUsd: parsed },
    });
    await recomputeSharedKeyWeekAllotmentsTx(tx, now, { rebaseOnMonthlyCap: true });
  });
  return { monthlyCapUsd: parsed, previousMonthlyCapUsd };
}

export type UsageLimitView =
  | {
      kind: "shared_weekly";
      percentUsed: number;
      resetsAt: string;
      timezone: typeof SHARED_KEY_BUDGET_TIMEZONE;
    }
  | { kind: "personal_key" }
  | { kind: "none" };

/**
 * Account-menu usage meter: personal-key when the API has classified the effective key,
 * otherwise shared weekly % when on the roster with a cap.
 */
export async function resolveUsageLimitView(
  prisma: BudgetPrisma,
  userId: string,
  now = new Date(),
  envFallback: number | null = null,
  options?: { personalKey?: boolean },
): Promise<UsageLimitView> {
  if (options?.personalKey) return { kind: "personal_key" };
  const status = await sharedKeyWeeklyBudgetStatus(prisma, userId, now, envFallback);
  if (status.enabled && status.member) {
    return {
      kind: "shared_weekly",
      percentUsed: status.percentUsed,
      resetsAt: status.resetsAt,
      timezone: status.timezone,
    };
  }
  return { kind: "none" };
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

async function previousBudgetRows(
  prisma: Pick<BudgetTx, "sharedKeyWeekAllotment">,
  weekStart: Date,
): Promise<Array<{ userId: string; allotmentUsd: number; reservedUsd: number; updatedAt: Date }>> {
  return prisma.sharedKeyWeekAllotment.findMany({
    where: { weekStart },
    select: { userId: true, allotmentUsd: true, reservedUsd: true, updatedAt: true },
  });
}

/**
 * Clear reservedUsd on allotment rows whose last update is older than the in-flight timeout.
 * A crashed worker or mid-call deploy otherwise leaves a hold that hard-stops the rest of the week.
 */
export async function clearStaleSharedKeyBudgetHolds(
  tx: Pick<BudgetTx, "sharedKeyWeekAllotment">,
  weekStart: Date,
  now: Date,
  staleMs = SHARED_KEY_BUDGET_HOLD_STALE_MS,
): Promise<number> {
  const cutoff = new Date(now.getTime() - staleMs);
  const result = await tx.sharedKeyWeekAllotment.updateMany({
    where: {
      weekStart,
      reservedUsd: { gt: 0 },
      updatedAt: { lt: cutoff },
    },
    data: { reservedUsd: 0 },
  });
  return result.count;
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
    await lockSharedKeyBudget(tx, MEMBERS_LOCK);
    return recomputeSharedKeyWeekAllotmentsTx(tx, now);
  });
}

async function recomputeSharedKeyWeekAllotmentsTx(
  tx: BudgetTx,
  now: Date,
  options?: { rebaseOnMonthlyCap?: boolean },
): Promise<Map<string, number>> {
  const settings = await tx.deploymentSettings.findUnique({
    where: { id: "default" },
    select: { sharedKeyMonthlyBudgetUsd: true },
  });
  const monthly = settings?.sharedKeyMonthlyBudgetUsd;
  const weekStart = sharedKeyWeekStart(now);
  await clearStaleSharedKeyBudgetHolds(tx, weekStart, now);
  const members = await listSharedKeyBudgetMembers(tx);
  if (!(monthly != null && monthly > 0) || members.length === 0) {
    await tx.sharedKeyWeekAllotment.deleteMany({ where: { weekStart } });
    return new Map();
  }

  const memberIds = members.map((m) => m.userId);
  const priorRows = await previousBudgetRows(tx, weekStart);
  const priorIds = [...new Set([...memberIds, ...priorRows.map((row) => row.userId)])];
  const previousAllotments = new Map(priorRows.map((row) => [row.userId, row.allotmentUsd]));
  const reservedByUser = new Map(priorRows.map((row) => [row.userId, row.reservedUsd]));
  const spentByUser = await spentByMembers(tx, priorIds, weekStart, now);
  const allotments = redivideWeeklyAllotments({
    monthlyCapUsd: monthly,
    members,
    weekStart,
    now,
    previousAllotments,
    spentByUser,
    reservedByUser,
    rebaseOnMonthlyCap: options?.rebaseOnMonthlyCap === true,
  });

  await tx.sharedKeyWeekAllotment.deleteMany({
    where: { weekStart, userId: { notIn: [...allotments.keys()] } },
  });
  for (const [userId, allotmentUsd] of allotments) {
    await tx.sharedKeyWeekAllotment.upsert({
      where: { weekStart_userId: { weekStart, userId } },
      create: { weekStart, userId, allotmentUsd, reservedUsd: 0 },
      // Keep live reservedUsd; only the allotment ceiling is rewritten.
      update: { allotmentUsd },
    });
  }
  // Cap rebase / membership redivide must keep active mid-week transfers applied.
  await reapplyActiveTransfersTx(tx, weekStart, spentByUser, reservedByUser);
  const refreshed = await previousBudgetRows(tx, weekStart);
  return new Map(refreshed.map((row) => [row.userId, row.allotmentUsd]));
}

/** Add a user to the shared-key budget set and re-divide the current week. */
export async function addSharedKeyBudgetMember(
  prisma: Pick<BudgetPrisma, "$transaction">,
  userId: string,
  joinedAt = new Date(),
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await lockSharedKeyBudget(tx, MEMBERS_LOCK);
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
    await lockSharedKeyBudget(tx, MEMBERS_LOCK);
    await tx.sharedKeyBudgetMember.deleteMany({ where: { userId } });
    await recomputeSharedKeyWeekAllotmentsTx(tx, now);
  });
}

/**
 * Make the member set match `userIds` (order ignored). Adds missing users at `now`,
 * removes extras, then re-divides. Used when syncing SHARED_KEY_BUDGET_USER_IDS.
 * Unknown ids (no matching user row) are skipped and logged so API startup cannot crash.
 */
export async function reconcileSharedKeyBudgetMembers(
  prisma: Pick<BudgetPrisma, "$transaction">,
  userIds: string[],
  now = new Date(),
): Promise<void> {
  const wanted = [...new Set(userIds.filter(Boolean))];
  await prisma.$transaction(async (tx) => {
    await lockSharedKeyBudget(tx, MEMBERS_LOCK);
    const known = wanted.length
      ? await tx.user.findMany({
          where: { id: { in: wanted } },
          select: { id: true },
        })
      : [];
    const knownIds = new Set(known.map((row) => row.id));
    for (const userId of wanted) {
      if (!knownIds.has(userId)) {
        getLogger().warn("shared-key budget: skipping unknown user id", { userId });
      }
    }
    const existing = await tx.sharedKeyBudgetMember.findMany({ select: { userId: true } });
    const have = new Set(existing.map((row) => row.userId));
    for (const userId of knownIds) {
      if (!have.has(userId)) {
        await tx.sharedKeyBudgetMember.create({ data: { userId, joinedAt: now } });
      }
    }
    for (const userId of have) {
      if (!knownIds.has(userId)) {
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
    // Caller already holds the members lock.
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
 * Takes the same members lock as re-divide so the two cannot interleave.
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
    await lockSharedKeyBudget(tx, MEMBERS_LOCK);
    const settings = await tx.deploymentSettings.findUnique({
      where: { id: "default" },
      select: { sharedKeyMonthlyBudgetUsd: true },
    });
    const monthly = settings?.sharedKeyMonthlyBudgetUsd;
    if (!(monthly != null && monthly > 0)) return;

    const weekStart = sharedKeyWeekStart(now);
    await clearStaleSharedKeyBudgetHolds(tx, weekStart, now);
    const allotment = await ensureMemberAllotment(tx, userId, weekStart, now);
    // Feature on but user not in the shared-key set: no shared-key spend allowed.
    const cap = allotment?.allotmentUsd ?? 0;
    const reserved = allotment?.reservedUsd ?? 0;
    const spent = await spentSharedKeyUsd(tx, userId, weekStart, now);
    // At or over the cap: refuse every further shared-key call (including zero-estimate probes).
    const over = spent + reserved >= cap || (maxCostUsd > 0 && spent + reserved + maxCostUsd > cap);
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
    await lockSharedKeyBudget(tx, MEMBERS_LOCK);
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
  envFallback: number | null = null,
): Promise<SharedKeyWeeklyBudgetStatus> {
  const weekStart = sharedKeyWeekStart(now);
  const resetsAt = sharedKeyWeekEnd(weekStart);
  const monthly = await sharedKeyMonthlyBudgetUsd(prisma, envFallback);
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
