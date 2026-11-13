import {
  effectiveSharedKeySpendUsd,
  fullWeekShareUsd,
  parseSharedKeyMonthlyBudgetInput,
  redivideWeeklyAllotments,
  SHARED_KEY_BUDGET_TIMEZONE,
  sharedKeyBudgetPercentUsed,
  sharedKeyWeekEnd,
  sharedKeyWeekStart,
} from "@rakazo/core";
import { getLogger } from "@rakazo/logging";
import { recordAuditEvent } from "./audit-events.js";
import type { PrismaClient } from "./client.js";
import { Prisma } from "./client.js";
import { isHiddenOpsEmail } from "./ops-email-filter.js";
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
 * Monday→now shared-key spend per user. Effective allotment spend subtracts each row's
 * preJoinSpendUsd separately — never window spend at joinedAt.
 */
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

type AllotmentBaseline = {
  userId: string;
  allotmentUsd: number;
  reservedUsd: number;
  joinedAt: Date;
  preJoinSpendUsd: number;
  updatedAt: Date;
};

async function previousBudgetRows(
  prisma: Pick<BudgetTx, "sharedKeyWeekAllotment">,
  weekStart: Date,
): Promise<AllotmentBaseline[]> {
  return prisma.sharedKeyWeekAllotment.findMany({
    where: { weekStart },
    select: {
      userId: true,
      allotmentUsd: true,
      reservedUsd: true,
      joinedAt: true,
      preJoinSpendUsd: true,
      updatedAt: true,
    },
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
  if (!(monthly != null && monthly > 0)) {
    return new Map();
  }
  if (members.length === 0) {
    // Empty roster: shrink leftover week rows to spent+reserved so unused returns to the
    // conceptual pool, but keep joinedAt / preJoinSpendUsd for same-week re-add.
    const priorRows = await previousBudgetRows(tx, weekStart);
    const spentByUser = await spentByMembers(
      tx,
      priorRows.map((row) => row.userId),
      weekStart,
      now,
    );
    for (const row of priorRows) {
      const effective = effectiveSharedKeySpendUsd(
        spentByUser.get(row.userId) ?? 0,
        row.preJoinSpendUsd,
      );
      const floor = effective + row.reservedUsd;
      if (row.allotmentUsd !== floor) {
        await tx.sharedKeyWeekAllotment.update({
          where: { weekStart_userId: { weekStart, userId: row.userId } },
          data: { allotmentUsd: floor },
        });
      }
    }
    return new Map();
  }

  const priorRows = await previousBudgetRows(tx, weekStart);
  const previousAllotments = new Map(priorRows.map((row) => [row.userId, row.allotmentUsd]));
  const reservedByUser = new Map(priorRows.map((row) => [row.userId, row.reservedUsd]));
  const preJoinSpendByUser = new Map(priorRows.map((row) => [row.userId, row.preJoinSpendUsd]));
  const priorJoinedAt = new Map(priorRows.map((row) => [row.userId, row.joinedAt]));

  // Members for redivide use allotment.joinedAt when the week row already exists so
  // remove/re-add keeps the original mid-week fraction and baseline.
  const redivideMembers = members.map((member) => ({
    userId: member.userId,
    joinedAt: priorJoinedAt.get(member.userId) ?? member.joinedAt,
  }));

  // Include removed prior allotment holders so their unspent remainder returns to the pool.
  const spendUserIds = [
    ...new Set([...redivideMembers.map((m) => m.userId), ...priorRows.map((row) => row.userId)]),
  ];
  const spentByUser = await spentByMembers(tx, spendUserIds, weekStart, now);

  // Fresh enrolls without a week row yet: baseline is Monday→joinedAt shared spend.
  for (const member of redivideMembers) {
    if (!preJoinSpendByUser.has(member.userId)) {
      const baseline =
        member.joinedAt.getTime() > weekStart.getTime()
          ? await spentSharedKeyUsd(tx, member.userId, weekStart, member.joinedAt)
          : 0;
      preJoinSpendByUser.set(member.userId, baseline);
    }
  }

  const allotments = redivideWeeklyAllotments({
    monthlyCapUsd: monthly,
    members: redivideMembers,
    weekStart,
    now,
    previousAllotments,
    spentByUser,
    reservedByUser,
    preJoinSpendByUser,
    rebaseOnMonthlyCap: options?.rebaseOnMonthlyCap === true,
  });

  const memberIds = new Set(allotments.keys());

  for (const [userId, allotmentUsd] of allotments) {
    const existing = priorRows.find((row) => row.userId === userId);
    const joinedAt = existing?.joinedAt ?? redivideMembers.find((m) => m.userId === userId)!.joinedAt;
    const preJoinSpendUsd = existing?.preJoinSpendUsd ?? preJoinSpendByUser.get(userId) ?? 0;
    await tx.sharedKeyWeekAllotment.upsert({
      where: { weekStart_userId: { weekStart, userId } },
      create: {
        weekStart,
        userId,
        allotmentUsd,
        reservedUsd: 0,
        joinedAt,
        preJoinSpendUsd,
      },
      // Keep live reservedUsd and join baseline; only the allotment ceiling is rewritten.
      update: { allotmentUsd },
    });
  }

  // Removed members: shrink allotment to spent+reserved so unused returns via the pool above,
  // but keep the row (joinedAt / preJoinSpendUsd) for same-week re-add.
  for (const row of priorRows) {
    if (memberIds.has(row.userId)) continue;
    const mondaySpend = spentByUser.get(row.userId) ?? 0;
    const effective = effectiveSharedKeySpendUsd(mondaySpend, row.preJoinSpendUsd);
    const floor = effective + row.reservedUsd;
    if (row.allotmentUsd !== floor) {
      await tx.sharedKeyWeekAllotment.update({
        where: { weekStart_userId: { weekStart, userId: row.userId } },
        data: { allotmentUsd: floor },
      });
    }
  }

  // Cap rebase / membership redivide must keep active mid-week transfers applied.
  // Pass effective spend so transfer floors match the allotment accounting.
  const effectiveSpent = new Map<string, number>();
  for (const userId of spendUserIds) {
    effectiveSpent.set(
      userId,
      effectiveSharedKeySpendUsd(spentByUser.get(userId) ?? 0, preJoinSpendByUser.get(userId) ?? 0),
    );
  }
  await reapplyActiveTransfersTx(tx, weekStart, effectiveSpent, reservedByUser);
  const refreshed = await previousBudgetRows(tx, weekStart);
  return new Map(
    refreshed.filter((row) => memberIds.has(row.userId)).map((row) => [row.userId, row.allotmentUsd]),
  );
}

async function userEligibleForSharedKeyBudget(
  tx: Pick<BudgetTx, "user">,
  userId: string,
): Promise<boolean> {
  const user = await tx.user.findUnique({
    where: { id: userId },
    select: { id: true, email: true, deactivatedAt: true },
  });
  if (!user || user.deactivatedAt != null) return false;
  if (isHiddenOpsEmail(user.email)) return false;
  return true;
}

/**
 * Enroll under the members lock (caller must hold it). Reuses this week's allotment
 * joinedAt / preJoinSpendUsd on remove→re-add. Skips deactivated and hidden accounts.
 * Returns true when a new roster row was created.
 */
async function enrollSharedKeyBudgetMemberTx(
  tx: BudgetTx,
  userId: string,
  now: Date,
  options?: { audit?: boolean },
): Promise<boolean> {
  const existing = await tx.sharedKeyBudgetMember.findUnique({
    where: { userId },
    select: { userId: true },
  });
  if (existing) return false;
  if (!(await userEligibleForSharedKeyBudget(tx, userId))) return false;

  const weekStart = sharedKeyWeekStart(now);
  const priorAllotment = await tx.sharedKeyWeekAllotment.findUnique({
    where: { weekStart_userId: { weekStart, userId } },
    select: { joinedAt: true, preJoinSpendUsd: true },
  });

  const joinedAt = priorAllotment?.joinedAt ?? now;
  const preJoinSpendUsd =
    priorAllotment?.preJoinSpendUsd ??
    (joinedAt.getTime() > weekStart.getTime()
      ? await spentSharedKeyUsd(tx, userId, weekStart, joinedAt)
      : 0);

  await tx.sharedKeyBudgetMember.create({ data: { userId, joinedAt } });
  await recomputeSharedKeyWeekAllotmentsTx(tx, now);
  if (options?.audit !== false) {
    await recordAuditEvent({
      action: "shared_key_budget.member.auto_enrolled",
      actor: { type: "system", label: "shared-key-budget" },
      target: { type: "user", id: userId },
      metadata: {
        userId,
        weekStartsAt: weekStart.toISOString(),
        preJoinSpendUsd,
      },
    });
  }
  return true;
}

/** Add a user to the shared-key budget set and re-divide the current week. */
export async function addSharedKeyBudgetMember(
  prisma: Pick<BudgetPrisma, "$transaction">,
  userId: string,
  joinedAt = new Date(),
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await lockSharedKeyBudget(tx, MEMBERS_LOCK);
    const existing = await tx.sharedKeyBudgetMember.findUnique({
      where: { userId },
      select: { userId: true },
    });
    if (existing) {
      await recomputeSharedKeyWeekAllotmentsTx(tx, joinedAt);
      return;
    }
    const weekStart = sharedKeyWeekStart(joinedAt);
    const priorAllotment = await tx.sharedKeyWeekAllotment.findUnique({
      where: { weekStart_userId: { weekStart, userId } },
      select: { joinedAt: true },
    });
    const effectiveJoinedAt = priorAllotment?.joinedAt ?? joinedAt;
    await tx.sharedKeyBudgetMember.create({
      data: { userId, joinedAt: effectiveJoinedAt },
    });
    await recomputeSharedKeyWeekAllotmentsTx(tx, joinedAt);
  });
}

/**
 * Enroll a shared-key user if they are not already on the roster.
 * Prefer {@link reserveSharedKeyBudget} on the hot path (enrolls under the budget lock).
 * Kept for explicit admin/env includes. No-op when already a member.
 */
export async function ensureSharedKeyBudgetMember(
  prisma: Pick<BudgetPrisma, "$transaction">,
  userId: string,
  joinedAt = new Date(),
): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    await lockSharedKeyBudget(tx, MEMBERS_LOCK);
    return enrollSharedKeyBudgetMemberTx(tx, userId, joinedAt, { audit: false });
  });
}

/**
 * Remove a user from the active roster and return unused allotment to the pool.
 * Keeps this week's allotment row (joinedAt / preJoinSpendUsd) so a same-week re-add
 * reuses the original baseline. The row is irrelevant after the next Monday weekStart.
 */
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
 * Add every known id from SHARED_KEY_BUDGET_USER_IDS. Never removes hot-path or
 * admin-added roster rows — only additive.
 */
export async function reconcileSharedKeyBudgetMembers(
  prisma: Pick<BudgetPrisma, "$transaction">,
  userIds: string[],
  now = new Date(),
): Promise<void> {
  await syncSharedKeyBudgetMembers(prisma, { explicitUserIds: userIds }, now);
}

/**
 * Additive roster sync for explicit SHARED_KEY_BUDGET_USER_IDS includes.
 * Does not remove anyone — auto-enrolled and admin-added members stay until
 * an explicit remove or the optional Monday prune.
 */
export async function syncSharedKeyBudgetMembers(
  prisma: Pick<BudgetPrisma, "$transaction">,
  input: { explicitUserIds: string[]; companyUserIds?: string[] },
  now = new Date(),
): Promise<void> {
  const wanted = [
    ...new Set(
      [...input.explicitUserIds, ...(input.companyUserIds ?? [])]
        .map((id) => id.trim())
        .filter(Boolean),
    ),
  ];
  if (wanted.length === 0) return;
  await prisma.$transaction(async (tx) => {
    await lockSharedKeyBudget(tx, MEMBERS_LOCK);
    const known = await tx.user.findMany({
      where: { id: { in: wanted }, deactivatedAt: null },
      select: { id: true, email: true },
    });
    const knownIds = new Set(
      known.filter((row) => !isHiddenOpsEmail(row.email)).map((row) => row.id),
    );
    for (const userId of wanted) {
      if (!knownIds.has(userId)) {
        getLogger().warn("shared-key budget: skipping unknown or ineligible user id", { userId });
      }
    }
    for (const userId of knownIds) {
      await enrollSharedKeyBudgetMemberTx(tx, userId, now, { audit: false });
    }
  });
}

/**
 * Drop roster members with no shared-key usage in the prior America/New_York week
 * who are not on the explicit env include list. Call on Monday (or lazily when the
 * week rolls) so dormant auto-enrolls do not keep splitting the pool forever.
 */
export async function pruneInactiveSharedKeyBudgetMembers(
  prisma: Pick<BudgetPrisma, "$transaction">,
  explicitUserIds: string[],
  now = new Date(),
): Promise<string[]> {
  const weekStart = sharedKeyWeekStart(now);
  const priorWeekEnd = weekStart;
  const priorWeekStart = sharedKeyWeekStart(new Date(weekStart.getTime() - 24 * 60 * 60 * 1000));
  const keep = new Set(explicitUserIds.map((id) => id.trim()).filter(Boolean));
  const removed: string[] = [];
  await prisma.$transaction(async (tx) => {
    await lockSharedKeyBudget(tx, MEMBERS_LOCK);
    const members = await listSharedKeyBudgetMembers(tx);
    if (members.length === 0) return;
    const usage = await tx.usageRecord.groupBy({
      by: ["userId"],
      where: {
        userId: { in: members.map((m) => m.userId) },
        sharedKey: true,
        createdAt: { gte: priorWeekStart, lt: priorWeekEnd },
      },
      _sum: { costUsd: true },
    });
    const active = new Set(
      usage.filter((row) => (row._sum.costUsd ?? 0) > 0).map((row) => row.userId),
    );
    for (const member of members) {
      if (keep.has(member.userId) || active.has(member.userId)) continue;
      await tx.sharedKeyBudgetMember.delete({ where: { userId: member.userId } });
      removed.push(member.userId);
    }
    if (removed.length > 0) {
      await recomputeSharedKeyWeekAllotmentsTx(tx, now);
    }
  });
  return removed;
}

async function ensureMemberAllotment(
  tx: BudgetTx,
  userId: string,
  weekStart: Date,
  now: Date,
): Promise<{
  allotmentUsd: number;
  reservedUsd: number;
  joinedAt: Date;
  preJoinSpendUsd: number;
} | null> {
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
  return row
    ? {
        allotmentUsd: row.allotmentUsd,
        reservedUsd: row.reservedUsd,
        joinedAt: row.joinedAt,
        preJoinSpendUsd: row.preJoinSpendUsd,
      }
    : null;
}

/**
 * Hard-stop gate for a shared-key model call. Personal keys never call this.
 * Auto-enrolls the user under the same members lock when a monthly cap is set
 * (skips deactivated / hidden). Reserves `maxCostUsd` against the weekly allotment
 * until `releaseSharedKeyBudgetHold`.
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
    await enrollSharedKeyBudgetMemberTx(tx, userId, now);
    const allotment = await ensureMemberAllotment(tx, userId, weekStart, now);
    // Feature on but user not eligible / not enrolled: no shared-key spend allowed.
    const cap = allotment?.allotmentUsd ?? 0;
    const reserved = allotment?.reservedUsd ?? 0;
    const mondaySpend = await spentSharedKeyUsd(tx, userId, weekStart, now);
    const spent = effectiveSharedKeySpendUsd(mondaySpend, allotment?.preJoinSpendUsd ?? 0);
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
  const mondaySpend = await prisma.$transaction((tx) =>
    spentSharedKeyUsd(tx, userId, weekStart, now),
  );
  const spentUsd = effectiveSharedKeySpendUsd(mondaySpend, row?.preJoinSpendUsd ?? 0);
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
