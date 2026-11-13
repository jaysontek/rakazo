import {
  fullWeekShareUsd,
  parseSharedKeyMonthlyBudgetInput,
  redivideWeeklyAllotments,
  SHARED_KEY_BUDGET_TIMEZONE,
  sharedKeyBudgetPercentUsed,
  sharedKeySpendWindowStart,
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
  since: Date,
  now: Date,
): Promise<number> {
  const { _sum } = await prisma.usageRecord.aggregate({
    _sum: { costUsd: true },
    where: {
      userId,
      sharedKey: true,
      createdAt: { gte: since, lt: now },
    },
  });
  return _sum.costUsd ?? 0;
}

/**
 * Per-member shared-key spend inside each member's allotment window (week start, or join
 * time when they enrolled mid-week). Pre-join spend is ignored so a mid-week enroll cannot
 * be hard-stopped by earlier unmetered company-key usage.
 */
async function spentByMembers(
  prisma: Pick<BudgetTx, "usageRecord">,
  members: Array<{ userId: string; joinedAt: Date }>,
  weekStart: Date,
  now: Date,
): Promise<Map<string, number>> {
  const spent = new Map<string, number>();
  if (members.length === 0) return spent;
  const userIds = members.map((member) => member.userId);
  const joinedById = new Map(members.map((member) => [member.userId, member.joinedAt]));
  const groups = await prisma.usageRecord.groupBy({
    by: ["userId"],
    where: {
      userId: { in: userIds },
      sharedKey: true,
      createdAt: { gte: weekStart, lt: now },
    },
    _sum: { costUsd: true },
  });
  const midWeekIds = members
    .filter((member) => member.joinedAt.getTime() > weekStart.getTime())
    .map((member) => member.userId);
  if (midWeekIds.length === 0) {
    for (const group of groups) {
      spent.set(group.userId, group._sum.costUsd ?? 0);
    }
    return spent;
  }
  // Full-week members can use the groupBy totals; mid-week joiners need a join-bounded sum.
  for (const group of groups) {
    if (!midWeekIds.includes(group.userId)) {
      spent.set(group.userId, group._sum.costUsd ?? 0);
    }
  }
  for (const userId of midWeekIds) {
    const joinedAt = joinedById.get(userId) ?? weekStart;
    spent.set(
      userId,
      await spentSharedKeyUsd(prisma, userId, sharedKeySpendWindowStart(weekStart, joinedAt), now),
    );
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

  const priorRows = await previousBudgetRows(tx, weekStart);
  const previousAllotments = new Map(priorRows.map((row) => [row.userId, row.allotmentUsd]));
  const reservedByUser = new Map(priorRows.map((row) => [row.userId, row.reservedUsd]));
  // Include removed prior allotment holders so their unspent remainder returns to the pool.
  const spendMembers = [
    ...members,
    ...priorRows
      .filter((row) => !members.some((member) => member.userId === row.userId))
      .map((row) => ({ userId: row.userId, joinedAt: weekStart })),
  ];
  const spentByUser = await spentByMembers(tx, spendMembers, weekStart, now);
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

/**
 * Enroll a company-key user if they are not already on the roster.
 * No-op when already a member so hot paths (shared-key model calls) stay cheap.
 */
export async function ensureSharedKeyBudgetMember(
  prisma: Pick<BudgetPrisma, "$transaction" | "sharedKeyBudgetMember">,
  userId: string,
  joinedAt = new Date(),
): Promise<boolean> {
  const existing = await prisma.sharedKeyBudgetMember.findUnique({
    where: { userId },
    select: { userId: true },
  });
  if (existing) return false;
  await addSharedKeyBudgetMember(prisma, userId, joinedAt);
  return true;
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
 * removes extras, then re-divides. Used when syncing SHARED_KEY_BUDGET_USER_IDS alone.
 * Unknown ids (no matching user row) are skipped and logged so API startup cannot crash.
 */
export async function reconcileSharedKeyBudgetMembers(
  prisma: Pick<BudgetPrisma, "$transaction">,
  userIds: string[],
  now = new Date(),
): Promise<void> {
  await syncSharedKeyBudgetMembers(prisma, { explicitUserIds: userIds, companyUserIds: [] }, now);
}

/**
 * Roster = company-key users ∪ explicit SHARED_KEY_BUDGET_USER_IDS includes.
 * Adds missing members at `now`, removes anyone not in the union, then re-divides.
 * Personal-key users are kept only when listed in `explicitUserIds`.
 */
export async function syncSharedKeyBudgetMembers(
  prisma: Pick<BudgetPrisma, "$transaction">,
  input: { explicitUserIds: string[]; companyUserIds: string[] },
  now = new Date(),
): Promise<void> {
  const wanted = [
    ...new Set(
      [...input.explicitUserIds, ...input.companyUserIds].map((id) => id.trim()).filter(Boolean),
    ),
  ];
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
    const member = await tx.sharedKeyBudgetMember.findUnique({ where: { userId } });
    const allotment = await ensureMemberAllotment(tx, userId, weekStart, now);
    // Feature on but user not in the shared-key set: no shared-key spend allowed.
    const cap = allotment?.allotmentUsd ?? 0;
    const reserved = allotment?.reservedUsd ?? 0;
    const spendSince = sharedKeySpendWindowStart(weekStart, member?.joinedAt ?? weekStart);
    const spent = await spentSharedKeyUsd(tx, userId, spendSince, now);
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
  const spendSince = sharedKeySpendWindowStart(weekStart, member.joinedAt);
  const spentUsd = await prisma.$transaction((tx) =>
    spentSharedKeyUsd(tx, userId, spendSince, now),
  );
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
