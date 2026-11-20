import { appendAuditEventTx, DEPLOYMENT_AUDIT_ORGANIZATION_ID } from "./audit-events.js";
import type { Prisma, PrismaClient } from "./client.js";
import type {
  AddSharedKeyBudgetMemberResult,
  SharedKeyBudgetEnrollmentPolicy,
} from "./shared-key-budget.js";
import {
  addSharedKeyBudgetMemberTx,
  lockSharedKeyBudget,
  removeSharedKeyBudgetMemberTx,
  SHARED_KEY_BUDGET_MEMBERS_LOCK,
} from "./shared-key-budget.js";
import { personalOrganizationIds } from "./spaces.js";

/** Soft-deleted accounts stay restorable for this long before purge may run. */
export const ACCOUNT_SOFT_DELETE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/** A purge claim older than this belongs to a worker that died; another may take it over. */
export const ACCOUNT_PURGE_CLAIM_TIMEOUT_MS = 5 * 60_000;

/** Max restore attempts (failed or refused) per user in the rate window. */
export const ACCOUNT_RESTORE_RATE_LIMIT = 10;
export const ACCOUNT_RESTORE_RATE_WINDOW_MS = 60 * 60 * 1000;

/** Max restore sign-in codes sent to one soft-deleted account in the window. */
export const ACCOUNT_RESTORE_OTP_LIMIT = 5;
export const ACCOUNT_RESTORE_OTP_WINDOW_MS = 15 * 60 * 1000;

type SoftDeletePrisma = Pick<PrismaClient, "$transaction">;

export type SoftDeletedUser = {
  id: string;
  email: string;
  emailVerified: boolean;
  deletionRequestedAt: Date;
  purgeAfter: Date;
  purgeClaimedAt: Date | null;
  priorSharedKeyBudgetMember: boolean;
  deactivatedAt: Date | null;
  deactivatedBeforeDeletion: Date | null;
};

export type AccountRestoreRefusal =
  | "not_pending"
  | "purge_claimed"
  | "purge_due"
  /** Deactivated before deletion: only an admin restores, and it stays deactivated. */
  | "admin_only"
  /** The directory turned the account off or deleted it. */
  | "directory";

export type AccountRestoreOutcome =
  | {
      restored: true;
      priorSharedKeyBudgetMember: boolean;
      /** Prior shared-key membership could not be re-added; an admin may retry. */
      budgetReenroll?: "restored_budget_reenroll_pending";
    }
  | { restored: false; reason: AccountRestoreRefusal };

export function normalizeAccountEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** A purge claim a live worker may still be acting on. */
export function purgeClaimHeld(claimedAt: Date | null | undefined, now = new Date()): boolean {
  return claimedAt != null && claimedAt.getTime() > now.getTime() - ACCOUNT_PURGE_CLAIM_TIMEOUT_MS;
}

export function accountRestorable(
  user: {
    deletionRequestedAt?: Date | null;
    purgeAfter?: Date | null;
    purgeClaimedAt?: Date | null;
  },
  now = new Date(),
): boolean {
  return (
    user.deletionRequestedAt != null &&
    user.purgeAfter != null &&
    user.purgeAfter.getTime() > now.getTime() &&
    !purgeClaimHeld(user.purgeClaimedAt, now)
  );
}

export function accountDueForPurge(
  user: {
    deletionRequestedAt?: Date | null;
    purgeAfter?: Date | null;
  },
  now = new Date(),
): boolean {
  return (
    user.deletionRequestedAt != null &&
    user.purgeAfter != null &&
    user.purgeAfter.getTime() < now.getTime()
  );
}

/**
 * Whether the directory keeps this account off: it has links, none active, or it deleted
 * the account (a tombstone). Turning it back on here would undo the directory.
 */
export async function directoryKeepsAccountOff(
  db: Pick<PrismaClient, "scimUser" | "scimIdentityTombstone">,
  userId: string,
): Promise<boolean> {
  const [links, deleted] = await Promise.all([
    db.scimUser.findMany({ where: { userId }, select: { active: true } }),
    db.scimIdentityTombstone.count({ where: { userId } }),
  ]);
  return !links.some((link) => link.active) && links.length + deleted > 0;
}

async function lockUser(tx: Pick<Prisma.TransactionClient, "$queryRaw">, userId: string) {
  await tx.$queryRaw`SELECT id FROM "user" WHERE id = ${userId} FOR UPDATE`;
}

/**
 * Soft-delete an account in one transaction under the shared-key members lock: deactivate,
 * schedule purge, revoke sessions, drop shared-key roster membership (recorded for restore),
 * and audit. Env-pinned shared-key members are refused — changing env is out of scope.
 * Asking again for an account already pending finishes any roster removal left behind and
 * returns the existing schedule.
 */
export async function requestAccountSoftDelete(
  prisma: SoftDeletePrisma,
  input: {
    userId: string;
    actorUserId: string;
    envPinnedUserIds?: readonly string[];
    now?: Date;
    retentionMs?: number;
  },
): Promise<{ purgeAfter: Date; priorSharedKeyBudgetMember: boolean; alreadyPending: boolean }> {
  const now = input.now ?? new Date();
  const retentionMs = input.retentionMs ?? ACCOUNT_SOFT_DELETE_RETENTION_MS;
  const pinned = new Set((input.envPinnedUserIds ?? []).map((id) => id.trim()).filter(Boolean));
  if (pinned.has(input.userId)) {
    throw new Error("Cannot delete an account pinned by SHARED_KEY_BUDGET_USER_IDS");
  }
  const rosterOptions = {
    envPinnedUserIds: input.envPinnedUserIds,
    actorUserId: input.actorUserId,
  };

  return prisma.$transaction(async (tx) => {
    // Members lock before the user row, the same order as restore.
    await lockSharedKeyBudget(tx, SHARED_KEY_BUDGET_MEMBERS_LOCK);
    await lockUser(tx, input.userId);
    const user = await tx.user.findUnique({
      where: { id: input.userId },
      select: {
        id: true,
        deletionRequestedAt: true,
        deactivatedAt: true,
        purgeAfter: true,
        priorSharedKeyBudgetMember: true,
      },
    });
    if (!user) throw new Error("User not found");
    const onRoster = Boolean(
      await tx.sharedKeyBudgetMember.findUnique({
        where: { userId: input.userId },
        select: { userId: true },
      }),
    );

    if (user.deletionRequestedAt != null && user.purgeAfter != null) {
      const priorSharedKeyBudgetMember = user.priorSharedKeyBudgetMember || onRoster;
      if (onRoster || user.deactivatedAt == null) {
        await tx.user.update({
          where: { id: input.userId },
          data: { deactivatedAt: user.deactivatedAt ?? now, priorSharedKeyBudgetMember },
        });
      }
      if (onRoster) await removeSharedKeyBudgetMemberTx(tx, input.userId, now, rosterOptions);
      await tx.session.deleteMany({ where: { userId: input.userId } });
      return { purgeAfter: user.purgeAfter, priorSharedKeyBudgetMember, alreadyPending: true };
    }

    const purgeAfter = new Date(now.getTime() + retentionMs);
    await tx.user.update({
      where: { id: input.userId },
      data: {
        deactivatedAt: user.deactivatedAt ?? now,
        deactivatedBeforeDeletion: user.deactivatedAt,
        deletionRequestedAt: now,
        purgeAfter,
        deletedByUserId: input.actorUserId,
        priorSharedKeyBudgetMember: onRoster,
        purgeClaimedAt: null,
      },
    });
    await tx.session.deleteMany({ where: { userId: input.userId } });
    // After deactivation, so the redivide already excludes this account.
    if (onRoster) await removeSharedKeyBudgetMemberTx(tx, input.userId, now, rosterOptions);
    await appendAuditEventTx(tx, {
      action: "account.soft_deleted",
      actor: { type: "user", id: input.actorUserId },
      target: { type: "user", id: input.userId },
      organizationId: DEPLOYMENT_AUDIT_ORGANIZATION_ID,
      metadata: {
        userId: input.userId,
        purgeAfter: purgeAfter.toISOString(),
        priorSharedKeyBudgetMember: onRoster,
      },
    });
    return { purgeAfter, priorSharedKeyBudgetMember: onRoster, alreadyPending: false };
  });
}

/**
 * Clear soft deletion and re-add prior shared-key membership in one transaction under the
 * members lock, with the normal eligibility bar. `deactivatedAt` goes back to what it was
 * before deletion. Verified-email (`otp`) restore is refused for an account that was already
 * deactivated or that the directory keeps off; an admin restore proceeds and leaves it off.
 */
export async function restoreAccountSoftDelete(
  prisma: SoftDeletePrisma,
  input: {
    userId: string;
    actorUserId: string;
    /** `otp` = verified-email sign-in; `admin` = ops restore. */
    via: "otp" | "admin";
    now?: Date;
    policy?: SharedKeyBudgetEnrollmentPolicy;
  },
): Promise<AccountRestoreOutcome> {
  const now = input.now ?? new Date();
  return prisma.$transaction(async (tx): Promise<AccountRestoreOutcome> => {
    await lockSharedKeyBudget(tx, SHARED_KEY_BUDGET_MEMBERS_LOCK);
    await lockUser(tx, input.userId);
    const user = await tx.user.findUnique({
      where: { id: input.userId },
      select: {
        id: true,
        deletionRequestedAt: true,
        purgeAfter: true,
        purgeClaimedAt: true,
        priorSharedKeyBudgetMember: true,
        deactivatedAt: true,
        deactivatedBeforeDeletion: true,
      },
    });
    if (!user || user.deletionRequestedAt == null) {
      return { restored: false, reason: "not_pending" };
    }
    if (purgeClaimHeld(user.purgeClaimedAt, now)) {
      return { restored: false, reason: "purge_claimed" };
    }
    if (!user.purgeAfter || user.purgeAfter.getTime() <= now.getTime()) {
      return { restored: false, reason: "purge_due" };
    }
    if (input.via === "otp" && user.deactivatedBeforeDeletion != null) {
      return { restored: false, reason: "admin_only" };
    }
    const directoryOff = await directoryKeepsAccountOff(tx, input.userId);
    if (input.via === "otp" && directoryOff) {
      return { restored: false, reason: "directory" };
    }
    const deactivatedAt =
      user.deactivatedBeforeDeletion ?? (directoryOff ? (user.deactivatedAt ?? now) : null);
    await tx.user.update({
      where: { id: input.userId },
      data: {
        deactivatedAt,
        deactivatedBeforeDeletion: null,
        deletionRequestedAt: null,
        purgeAfter: null,
        deletedByUserId: null,
        priorSharedKeyBudgetMember: false,
        purgeClaimedAt: null,
      },
    });

    let budgetReenroll: "restored_budget_reenroll_pending" | undefined;
    if (user.priorSharedKeyBudgetMember) {
      const result = await addSharedKeyBudgetMemberTx(tx, input.userId, now, {
        policy: input.policy,
      });
      if (!reenrolled(result)) {
        budgetReenroll = "restored_budget_reenroll_pending";
        await tx.user.update({
          where: { id: input.userId },
          data: { priorSharedKeyBudgetMember: true },
        });
      }
    }
    await appendAuditEventTx(tx, {
      action: "account.restored",
      actor: { type: "user", id: input.actorUserId },
      target: { type: "user", id: input.userId },
      organizationId: DEPLOYMENT_AUDIT_ORGANIZATION_ID,
      metadata: {
        userId: input.userId,
        via: input.via,
        priorSharedKeyBudgetMember: user.priorSharedKeyBudgetMember,
        stillDeactivated: deactivatedAt != null,
        ...(budgetReenroll ? { budgetReenroll } : {}),
      },
    });
    return {
      restored: true,
      priorSharedKeyBudgetMember: user.priorSharedKeyBudgetMember,
      ...(budgetReenroll ? { budgetReenroll } : {}),
    };
  });
}

function reenrolled(result: AddSharedKeyBudgetMemberResult): boolean {
  return result.enrolled || result.reason === "already_member";
}

/**
 * Admin retry for a restored account whose shared-key membership could not be re-added.
 * Uses the normal eligibility bar and clears the pending flag once the account is back on.
 */
export async function retryRestoredAccountBudgetReenroll(
  prisma: SoftDeletePrisma,
  input: {
    userId: string;
    actorUserId: string;
    now?: Date;
    policy?: SharedKeyBudgetEnrollmentPolicy;
  },
): Promise<AddSharedKeyBudgetMemberResult | { enrolled: false; reason: "not_pending" }> {
  const now = input.now ?? new Date();
  return prisma.$transaction(async (tx) => {
    await lockSharedKeyBudget(tx, SHARED_KEY_BUDGET_MEMBERS_LOCK);
    await lockUser(tx, input.userId);
    const user = await tx.user.findUnique({
      where: { id: input.userId },
      select: { deletionRequestedAt: true, priorSharedKeyBudgetMember: true },
    });
    if (!user || user.deletionRequestedAt != null || !user.priorSharedKeyBudgetMember) {
      return { enrolled: false as const, reason: "not_pending" as const };
    }
    const result = await addSharedKeyBudgetMemberTx(tx, input.userId, now, {
      policy: input.policy,
    });
    if (reenrolled(result)) {
      await tx.user.update({
        where: { id: input.userId },
        data: { priorSharedKeyBudgetMember: false },
      });
      await appendAuditEventTx(tx, {
        action: "account.restore.budget_reenrolled",
        actor: { type: "user", id: input.actorUserId },
        target: { type: "user", id: input.userId },
        organizationId: DEPLOYMENT_AUDIT_ORGANIZATION_ID,
        metadata: { userId: input.userId },
      });
    }
    return result;
  });
}

/**
 * Find a soft-deleted account by email, compared exactly after lower-casing both sides.
 * Raw SQL so the address is never a LIKE pattern (`_` and `%` match nothing extra).
 */
export async function findSoftDeletedUserByEmail(
  prisma: Pick<PrismaClient, "user" | "$queryRaw">,
  email: string,
): Promise<SoftDeletedUser | null> {
  const normalized = normalizeAccountEmail(email);
  if (!normalized) return null;
  const rows = await prisma.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM "user"
    WHERE lower(email) = ${normalized} AND "deletionRequestedAt" IS NOT NULL
    LIMIT 1
  `;
  const id = rows[0]?.id;
  if (!id) return null;
  const user = await prisma.user.findUnique({
    where: { id },
    select: {
      id: true,
      email: true,
      emailVerified: true,
      deletionRequestedAt: true,
      purgeAfter: true,
      purgeClaimedAt: true,
      priorSharedKeyBudgetMember: true,
      deactivatedAt: true,
      deactivatedBeforeDeletion: true,
    },
  });
  if (!user?.deletionRequestedAt || !user.purgeAfter) return null;
  return {
    ...user,
    deletionRequestedAt: user.deletionRequestedAt,
    purgeAfter: user.purgeAfter,
  };
}

/** Accounts the purge worker may claim: pending, past purgeAfter, unclaimed or claim stale. */
export async function listAccountsDueForPurge(
  prisma: Pick<PrismaClient, "user">,
  now = new Date(),
  limit = 50,
): Promise<Array<{ id: string; purgeAfter: Date }>> {
  const staleBefore = new Date(now.getTime() - ACCOUNT_PURGE_CLAIM_TIMEOUT_MS);
  const rows = await prisma.user.findMany({
    where: {
      deletionRequestedAt: { not: null },
      purgeAfter: { lt: now },
      OR: [{ purgeClaimedAt: null }, { purgeClaimedAt: { lt: staleBefore } }],
    },
    select: { id: true, purgeAfter: true },
    orderBy: { purgeAfter: "asc" },
    take: limit,
  });
  return rows.filter((row): row is { id: string; purgeAfter: Date } => row.purgeAfter != null);
}

/**
 * Claim one account for purge. Takes over a stale claim; refuses a fresh one, a restored
 * account, or one not yet due. Returns the claim instant, which later steps must still find.
 */
export async function claimAccountForPurge(
  prisma: SoftDeletePrisma,
  userId: string,
  now = new Date(),
): Promise<Date | null> {
  return prisma.$transaction(async (tx) => {
    await lockUser(tx, userId);
    const user = await tx.user.findUnique({
      where: { id: userId },
      select: {
        deletionRequestedAt: true,
        purgeAfter: true,
        purgeClaimedAt: true,
      },
    });
    if (!user || user.deletionRequestedAt == null) return null;
    if (purgeClaimHeld(user.purgeClaimedAt, now)) return null;
    if (!user.purgeAfter || user.purgeAfter.getTime() >= now.getTime()) return null;
    await tx.user.update({
      where: { id: userId },
      data: { purgeClaimedAt: now },
    });
    return now;
  });
}

/** Whether the account is still pending, past purgeAfter, and under this exact claim. */
export function stillClaimedForPurge(
  user: {
    deletionRequestedAt: Date | null;
    purgeAfter: Date | null;
    purgeClaimedAt: Date | null;
  } | null,
  claimedAt: Date,
  now = new Date(),
): boolean {
  return (
    user != null &&
    user.deletionRequestedAt != null &&
    user.purgeClaimedAt?.getTime() === claimedAt.getTime() &&
    user.purgeAfter != null &&
    user.purgeAfter.getTime() < now.getTime()
  );
}

/**
 * Delete auth leftovers, personal organizations, and the user row after content teardown,
 * in one transaction that re-checks the claim under the row lock. Returns false when a
 * restore or another worker's takeover won. Safe to run again.
 */
export async function finalizeAccountPurge(
  prisma: SoftDeletePrisma,
  userId: string,
  claimedAt: Date,
  now = new Date(),
): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    await lockUser(tx, userId);
    const user = await tx.user.findUnique({
      where: { id: userId },
      select: {
        deletionRequestedAt: true,
        purgeAfter: true,
        purgeClaimedAt: true,
      },
    });
    if (!stillClaimedForPurge(user, claimedAt, now)) return false;
    const organizationIds = await personalOrganizationIds(tx, userId);
    await appendAuditEventTx(tx, {
      action: "account.purged",
      actor: { type: "system", label: "account-purge" },
      target: { type: "user", id: userId },
      organizationId: DEPLOYMENT_AUDIT_ORGANIZATION_ID,
      metadata: { userId },
    });
    await tx.messagingIdentity.deleteMany({ where: { userId } });
    await tx.messagingLinkCode.deleteMany({ where: { userId } });
    await tx.passkey.deleteMany({ where: { userId } });
    await tx.session.deleteMany({ where: { userId } });
    await tx.organization.deleteMany({ where: { id: { in: organizationIds } } });
    await tx.user.deleteMany({ where: { id: userId } });
    return true;
  });
}

/** Recent restore attempts for rate limiting (ids only; no email in the query result path). */
export async function countRecentRestoreAttempts(
  prisma: Pick<PrismaClient, "securityEvent">,
  userId: string,
  now = new Date(),
): Promise<number> {
  return prisma.securityEvent.count({
    where: {
      userId,
      type: {
        in: [
          "auth.account.restore.attempted",
          "auth.account.restore.failed",
          "ops.account.restore.attempted",
          "ops.account.restore.failed",
        ],
      },
      createdAt: { gte: new Date(now.getTime() - ACCOUNT_RESTORE_RATE_WINDOW_MS) },
    },
  });
}

/** Restore sign-in codes sent to this account recently. */
export async function countRecentRestoreOtpRequests(
  prisma: Pick<PrismaClient, "securityEvent">,
  userId: string,
  now = new Date(),
): Promise<number> {
  return prisma.securityEvent.count({
    where: {
      userId,
      type: "auth.account.restore.otp_requested",
      createdAt: { gte: new Date(now.getTime() - ACCOUNT_RESTORE_OTP_WINDOW_MS) },
    },
  });
}
