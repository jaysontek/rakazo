import {
  effectiveSharedKeySpendUsd,
  fullWeekShareUsd,
  isGatedSharedKeyDeployment,
  parseSharedKeyMonthlyBudgetInput,
  redivideWeeklyAllotments,
  SHARED_KEY_BUDGET_TIMEZONE,
  sharedKeyBudgetPercentUsed,
  sharedKeyWeekEnd,
  sharedKeyWeekStart,
} from "@rakazo/core";
import { getLogger } from "@rakazo/logging";
import { appendAuditEventTx } from "./audit-events.js";
import type { PrismaClient } from "./client.js";
import { Prisma } from "./client.js";
import { isHiddenOpsEmail } from "./ops-email-filter.js";
import { reapplyActiveTransfersTx } from "./shared-key-transfer.js";

type BudgetPrisma = Pick<
  PrismaClient,
  | "deploymentSettings"
  | "sharedKeyBudgetMember"
  | "sharedKeyBudgetEnrollmentRequest"
  | "sharedKeyWeekAllotment"
  | "sharedKeyAllotmentTransfer"
  | "usageRecord"
  | "user"
  | "member"
  | "adminGrant"
  | "auditEvent"
  | "space"
  | "$transaction"
  | "$queryRaw"
>;

type BudgetTx = Pick<
  Prisma.TransactionClient,
  | "sharedKeyBudgetMember"
  | "sharedKeyBudgetEnrollmentRequest"
  | "sharedKeyWeekAllotment"
  | "sharedKeyAllotmentTransfer"
  | "usageRecord"
  | "deploymentSettings"
  | "user"
  | "member"
  | "adminGrant"
  | "auditEvent"
  | "space"
  | "$queryRaw"
>;

/**
 * Auto-enroll policy from the deployment's signup posture.
 * Gated deployments (signups off, allowlist, singleAccount, directory): verified + any membership.
 * Open signups: only users who share a non-personal (multi-member) org with an ops admin.
 * Always pass this explicitly — never fail open with a gated default in workers.
 */
export type SharedKeyBudgetEnrollmentPolicy = {
  gatedDeployment: boolean;
  /** Lowercased RAKAZO_ADMIN_EMAILS. */
  adminEmails: string[];
  /** SHARED_KEY_BUDGET_USER_IDS — bypass eligibility on the hot path too. */
  explicitUserIds: string[];
};

/**
 * Strict open-signup policy: no auto-enroll unless env list / admin-share / admin add.
 * Use when a call site has no deployment posture yet (tests / missing deps).
 */
export const STRICT_SHARED_KEY_ENROLLMENT_POLICY: SharedKeyBudgetEnrollmentPolicy = {
  gatedDeployment: false,
  adminEmails: [],
  explicitUserIds: [],
};

/** Gated unit-test policy: verified email + any membership is enough. */
export const GATED_SHARED_KEY_ENROLLMENT_POLICY: SharedKeyBudgetEnrollmentPolicy = {
  gatedDeployment: true,
  adminEmails: [],
  explicitUserIds: [],
};

export type AddSharedKeyBudgetMemberResult =
  | { enrolled: true }
  | { enrolled: false; reason: "already_member" | "ineligible" | "zero_slice" };

type EnrollOutcome = "enrolled" | "already_member" | "ineligible" | "zero_slice";

/**
 * Shared builder for API and worker so both processes use the same open vs gated bar.
 */
export function sharedKeyBudgetEnrollmentPolicyFromEnv(input: {
  signupsEnabled: string | undefined;
  signupAllowlist: string | undefined;
  singleAccount?: boolean;
  directoryProvisioning?: boolean;
  adminEmails: readonly string[];
  explicitUserIds?: readonly string[];
}): SharedKeyBudgetEnrollmentPolicy {
  return {
    gatedDeployment: isGatedSharedKeyDeployment({
      signupsEnabled: input.signupsEnabled,
      signupAllowlist: input.signupAllowlist,
      singleAccount: input.singleAccount,
      directoryProvisioning: input.directoryProvisioning,
    }),
    adminEmails: input.adminEmails.map((email) => email.trim().toLowerCase()).filter(Boolean),
    explicitUserIds: [...(input.explicitUserIds ?? [])]
      .map((id) => id.trim())
      .filter(Boolean),
  };
}

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

/**
 * Auto-enroll bar. Always rejects deactivated / hidden accounts.
 * SHARED_KEY_BUDGET_USER_IDS and explicit admin adds bypass via `bypassEligibilityBar`
 * (or `policy.explicitUserIds` on the hot path).
 * Gated deployments: verified email + any organization membership.
 * Open signups: verified email + membership in a non-personal (multi-member) org
 * that also includes an ops admin (active verified AdminGrant or env admin email).
 */
export async function userEligibleForSharedKeyBudget(
  tx: Pick<BudgetTx, "user" | "member" | "adminGrant">,
  userId: string,
  options: {
    policy: SharedKeyBudgetEnrollmentPolicy;
    bypassEligibilityBar?: boolean;
  },
): Promise<boolean> {
  const user = await tx.user.findUnique({
    where: { id: userId },
    select: { id: true, email: true, deactivatedAt: true, emailVerified: true },
  });
  if (!user || user.deactivatedAt != null) return false;
  if (isHiddenOpsEmail(user.email)) return false;
  if (options.bypassEligibilityBar) return true;
  if (options.policy.explicitUserIds.includes(userId)) return true;
  if (!user.emailVerified) return false;
  const memberships = await tx.member.findMany({
    where: { userId },
    select: { organizationId: true },
  });
  if (memberships.length === 0) return false;
  if (options.policy.gatedDeployment) return true;
  return sharesNonPersonalOrgWithOpsAdmin(tx, userId, memberships, options.policy.adminEmails);
}

/** Orgs with only one member are personal bootstraps; multi-member orgs are team orgs. */
async function sharesNonPersonalOrgWithOpsAdmin(
  tx: Pick<BudgetTx, "user" | "member" | "adminGrant">,
  userId: string,
  memberships: Array<{ organizationId: string }>,
  adminEmails: string[],
): Promise<boolean> {
  const orgIds = memberships.map((row) => row.organizationId);
  const peers = await tx.member.findMany({
    where: { organizationId: { in: orgIds } },
    select: { organizationId: true, userId: true },
  });
  const byOrg = new Map<string, string[]>();
  for (const peer of peers) {
    const list = byOrg.get(peer.organizationId) ?? [];
    list.push(peer.userId);
    byOrg.set(peer.organizationId, list);
  }
  const candidateAdminIds = new Set<string>();
  for (const userIds of byOrg.values()) {
    if (userIds.length < 2) continue;
    for (const id of userIds) {
      if (id !== userId) candidateAdminIds.add(id);
    }
  }
  if (candidateAdminIds.size === 0) return false;

  // AdminGrant holders must be active + verified, same as isActiveVerified in admin-grants.
  const grantHolders = await tx.adminGrant.findMany({
    where: { userId: { in: [...candidateAdminIds] } },
    select: { userId: true },
  });
  if (grantHolders.length > 0) {
    const activeVerified = await tx.user.findFirst({
      where: {
        id: { in: grantHolders.map((row) => row.userId) },
        emailVerified: true,
        deactivatedAt: null,
      },
      select: { id: true },
    });
    if (activeVerified) return true;
  }

  const adminEmailSet = new Set(
    adminEmails.map((email) => email.trim().toLowerCase()).filter(Boolean),
  );
  if (adminEmailSet.size === 0) return false;
  const candidates = await tx.user.findMany({
    where: {
      id: { in: [...candidateAdminIds] },
      emailVerified: true,
      deactivatedAt: null,
    },
    select: { email: true },
  });
  return candidates.some((row) => adminEmailSet.has(row.email.toLowerCase()));
}

/**
 * Enroll under the members lock (caller must hold it). Reuses this week's allotment
 * joinedAt / preJoinSpendUsd on remove→re-add. Skips deactivated, hidden, and
 * (unless bypassed) users who fail the enrollment policy. Skips when the computed
 * slice would be $0 so throwaway enrolls cannot churn the lock or leave audit
 * rows after a rolled-back reserve. Returns true when a new roster row was created.
 */
async function enrollSharedKeyBudgetMemberTx(
  tx: BudgetTx,
  userId: string,
  now: Date,
  options: {
    policy: SharedKeyBudgetEnrollmentPolicy;
    audit?: boolean;
    bypassEligibilityBar?: boolean;
    /** When set, write an admin-add audit instead of auto-enroll. */
    adminActorUserId?: string;
  },
): Promise<EnrollOutcome> {
  const existing = await tx.sharedKeyBudgetMember.findUnique({
    where: { userId },
    select: { userId: true },
  });
  if (existing) return "already_member";
  if (
    !(await userEligibleForSharedKeyBudget(tx, userId, {
      bypassEligibilityBar: options.bypassEligibilityBar === true,
      policy: options.policy,
    }))
  ) {
    return "ineligible";
  }

  const weekStart = sharedKeyWeekStart(now);
  const priorAllotment = await tx.sharedKeyWeekAllotment.findUnique({
    where: { weekStart_userId: { weekStart, userId } },
    select: { joinedAt: true },
  });

  const joinedAt = priorAllotment?.joinedAt ?? now;
  await tx.sharedKeyBudgetMember.create({ data: { userId, joinedAt } });
  const allotments = await recomputeSharedKeyWeekAllotmentsTx(tx, now);
  const slice = allotments.get(userId) ?? 0;
  if (!(slice > 0)) {
    // No budget left for this joiner: undo the roster row. Continuing members
    // are unchanged (redivide never raises them when the joiner take is 0).
    await tx.sharedKeyBudgetMember.delete({ where: { userId } });
    if (priorAllotment) {
      // Re-add that landed at 0: shrink the kept baseline row back to floor.
      await recomputeSharedKeyWeekAllotmentsTx(tx, now);
    } else {
      // Fresh zero allotment row from this enroll — drop it.
      await tx.sharedKeyWeekAllotment.deleteMany({ where: { weekStart, userId } });
    }
    return "zero_slice";
  }
  await tx.sharedKeyBudgetEnrollmentRequest.deleteMany({
    where: { weekStart, userId },
  });
  if (options.audit !== false) {
    if (options.adminActorUserId) {
      await appendAuditEventTx(tx, {
        action: "shared_key_budget.member.added",
        actor: { type: "user", id: options.adminActorUserId },
        target: { type: "user", id: userId },
        metadata: {
          userId,
          weekStartsAt: weekStart.toISOString(),
        },
      });
    } else {
      await appendAuditEventTx(tx, {
        action: "shared_key_budget.member.auto_enrolled",
        actor: { type: "system", label: "shared-key-budget" },
        target: { type: "user", id: userId },
        metadata: {
          userId,
          weekStartsAt: weekStart.toISOString(),
        },
      });
    }
  }
  return "enrolled";
}

/**
 * Add a user to the shared-key budget set and re-divide the current week.
 * Applies the same eligibility bar as auto-enroll unless `admin` bypasses it.
 * Admin adds write an audit event in the same transaction.
 */
export async function addSharedKeyBudgetMember(
  prisma: Pick<BudgetPrisma, "$transaction">,
  userId: string,
  joinedAt = new Date(),
  options?: {
    admin?: boolean;
    actorUserId?: string;
    policy?: SharedKeyBudgetEnrollmentPolicy;
  },
): Promise<AddSharedKeyBudgetMemberResult> {
  return prisma.$transaction(async (tx) => {
    await lockSharedKeyBudget(tx, MEMBERS_LOCK);
    const existing = await tx.sharedKeyBudgetMember.findUnique({
      where: { userId },
      select: { userId: true },
    });
    if (existing) {
      await recomputeSharedKeyWeekAllotmentsTx(tx, joinedAt);
      return { enrolled: false, reason: "already_member" };
    }
    const outcome = await enrollSharedKeyBudgetMemberTx(tx, userId, joinedAt, {
      bypassEligibilityBar: options?.admin === true,
      policy: options?.policy ?? STRICT_SHARED_KEY_ENROLLMENT_POLICY,
      adminActorUserId: options?.admin ? options.actorUserId : undefined,
      audit: options?.admin === true ? true : false,
    });
    if (outcome === "enrolled") return { enrolled: true };
    return { enrolled: false, reason: outcome };
  });
}

/**
 * Remove a user from the active roster. Unused headroom on their week row stays
 * unallocated until a later joiner is funded from it or an admin re-saves the cap;
 * the row (joinedAt / preJoinSpendUsd) is kept so a same-week re-add reuses the
 * original baseline. The row is irrelevant after the next Monday weekStart.
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
      // SHARED_KEY_BUDGET_USER_IDS bypasses the enrollment policy bar.
      await enrollSharedKeyBudgetMemberTx(tx, userId, now, {
        audit: false,
        bypassEligibilityBar: true,
        policy: STRICT_SHARED_KEY_ENROLLMENT_POLICY,
      });
    }
  });
}

/** Skip lastHitAt churn when hits arrive faster than this. */
export const SHARED_KEY_BUDGET_NOT_ENROLLED_HIT_MIN_INTERVAL_MS = 60_000;

/** Persist a not-enrolled hit outside the rolled-back reserve transaction. */
export async function recordSharedKeyBudgetNotEnrolledHit(
  prisma: Pick<BudgetPrisma, "sharedKeyBudgetEnrollmentRequest">,
  userId: string,
  now = new Date(),
): Promise<void> {
  const weekStart = sharedKeyWeekStart(now);
  const existing = await prisma.sharedKeyBudgetEnrollmentRequest.findUnique({
    where: { weekStart_userId: { weekStart, userId } },
    select: { lastHitAt: true },
  });
  if (existing) {
    if (
      now.getTime() - existing.lastHitAt.getTime() <
      SHARED_KEY_BUDGET_NOT_ENROLLED_HIT_MIN_INTERVAL_MS
    ) {
      return;
    }
    await prisma.sharedKeyBudgetEnrollmentRequest.update({
      where: { weekStart_userId: { weekStart, userId } },
      data: { lastHitAt: now },
    });
    return;
  }
  await prisma.sharedKeyBudgetEnrollmentRequest.create({
    data: { weekStart, userId, firstHitAt: now, lastHitAt: now },
  });
}

/** User ids that hit SharedKeyBudgetNotEnrolledError in the given week. */
export async function listSharedKeyBudgetNotEnrolledHits(
  prisma: Pick<BudgetPrisma, "sharedKeyBudgetEnrollmentRequest">,
  weekStart: Date,
): Promise<string[]> {
  const rows = await prisma.sharedKeyBudgetEnrollmentRequest.findMany({
    where: { weekStart },
    select: { userId: true },
  });
  return rows.map((row) => row.userId);
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
 * and the enrollment policy allows it. Reserves `maxCostUsd` against the weekly
 * allotment until `releaseSharedKeyBudgetHold`.
 * `policy` is required — callers must build it with
 * {@link sharedKeyBudgetEnrollmentPolicyFromEnv} (never a gated default).
 */
export async function reserveSharedKeyBudget(
  prisma: Pick<BudgetPrisma, "$transaction" | "sharedKeyBudgetEnrollmentRequest">,
  userId: string,
  maxCostUsd: number,
  now = new Date(),
  policy: SharedKeyBudgetEnrollmentPolicy = STRICT_SHARED_KEY_ENROLLMENT_POLICY,
): Promise<void> {
  if (!Number.isFinite(maxCostUsd) || maxCostUsd < 0) {
    throw new Error("Invalid shared-key budget reservation");
  }
  try {
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
      const alreadyMember = await tx.sharedKeyBudgetMember.findUnique({
        where: { userId },
        select: { userId: true },
      });
      if (!alreadyMember) {
        if (!(await userEligibleForSharedKeyBudget(tx, userId, { policy }))) {
          throw new SharedKeyBudgetNotEnrolledError();
        }
        await enrollSharedKeyBudgetMemberTx(tx, userId, now, { policy });
      }
      const allotment = await ensureMemberAllotment(tx, userId, weekStart, now);
      // Feature on but user not enrolled (e.g. $0 slice): no shared-key spend allowed.
      const cap = allotment?.allotmentUsd ?? 0;
      const reserved = allotment?.reservedUsd ?? 0;
      const mondaySpend = await spentSharedKeyUsd(tx, userId, weekStart, now);
      const spent = effectiveSharedKeySpendUsd(mondaySpend, allotment?.preJoinSpendUsd ?? 0);
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
  } catch (error) {
    // Hit row must commit outside the rolled-back reserve transaction.
    // Never let a hit-write failure replace the enrollment error.
    if (error instanceof SharedKeyBudgetNotEnrolledError) {
      try {
        await recordSharedKeyBudgetNotEnrolledHit(prisma, userId, now);
      } catch (hitError) {
        getLogger().warn("shared-key budget: failed to record not-enrolled hit", {
          userId,
          error: hitError,
        });
      }
    }
    throw error;
  }
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

/** User failed the shared-key enrollment policy (ask an admin / not yet on the roster). */
export class SharedKeyBudgetNotEnrolledError extends Error {
  constructor(message = "shared key budget not enrolled") {
    super(message);
    this.name = "SharedKeyBudgetNotEnrolledError";
  }
}
