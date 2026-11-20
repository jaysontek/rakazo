import { getLogger } from "@rakazo/logging";
import { appendAuditEventTx, DEPLOYMENT_AUDIT_ORGANIZATION_ID } from "./audit-events.js";
import type { Prisma, PrismaClient } from "./client.js";
import { addSharedKeyBudgetMember, removeSharedKeyBudgetMember } from "./shared-key-budget.js";

/** Soft-deleted accounts stay restorable for this long before purge may run. */
export const ACCOUNT_SOFT_DELETE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/** Max restore attempts (failed or refused) per user in the rate window. */
export const ACCOUNT_RESTORE_RATE_LIMIT = 10;
export const ACCOUNT_RESTORE_RATE_WINDOW_MS = 60 * 60 * 1000;

type SoftDeletePrisma = Pick<
  PrismaClient,
  "user" | "session" | "sharedKeyBudgetMember" | "securityEvent" | "$transaction" | "$queryRaw"
>;

export type SoftDeletedUser = {
  id: string;
  email: string;
  emailVerified: boolean;
  deletionRequestedAt: Date;
  purgeAfter: Date;
  purgeClaimedAt: Date | null;
  priorSharedKeyBudgetMember: boolean;
  deactivatedAt: Date | null;
};

export function normalizeAccountEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function accountPendingDeletion(user: { deletionRequestedAt?: Date | null }): boolean {
  return user.deletionRequestedAt != null;
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
    user.purgeClaimedAt == null
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
 * Soft-delete an account: deactivate, schedule purge, drop shared-key roster membership
 * (recording prior membership for restore), and revoke sessions. Env-pinned shared-key
 * members are refused — changing env is out of scope.
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
): Promise<{ purgeAfter: Date; priorSharedKeyBudgetMember: boolean }> {
  const now = input.now ?? new Date();
  const retentionMs = input.retentionMs ?? ACCOUNT_SOFT_DELETE_RETENTION_MS;
  const purgeAfter = new Date(now.getTime() + retentionMs);
  const pinned = new Set((input.envPinnedUserIds ?? []).map((id) => id.trim()).filter(Boolean));
  if (pinned.has(input.userId)) {
    throw new Error("Cannot delete an account pinned by SHARED_KEY_BUDGET_USER_IDS");
  }

  const priorMember = await prisma.sharedKeyBudgetMember.findUnique({
    where: { userId: input.userId },
    select: { userId: true },
  });
  const priorSharedKeyBudgetMember = Boolean(priorMember);

  await prisma.$transaction(async (tx) => {
    const user = await tx.user.findUnique({
      where: { id: input.userId },
      select: {
        id: true,
        deletionRequestedAt: true,
        deactivatedAt: true,
      },
    });
    if (!user) throw new Error("User not found");
    if (user.deletionRequestedAt != null) {
      throw new Error("Account is already pending deletion");
    }
    await tx.user.update({
      where: { id: input.userId },
      data: {
        deactivatedAt: user.deactivatedAt ?? now,
        deletionRequestedAt: now,
        purgeAfter,
        deletedByUserId: input.actorUserId,
        priorSharedKeyBudgetMember,
        purgeClaimedAt: null,
      },
    });
    await tx.session.deleteMany({ where: { userId: input.userId } });
    await appendAuditEventTx(tx, {
      action: "account.soft_deleted",
      actor: { type: "user", id: input.actorUserId },
      target: { type: "user", id: input.userId },
      organizationId: DEPLOYMENT_AUDIT_ORGANIZATION_ID,
      metadata: {
        userId: input.userId,
        purgeAfter: purgeAfter.toISOString(),
        priorSharedKeyBudgetMember,
      },
    });
  });

  // After deactivation so allotment math already excludes them if remove lags.
  if (priorSharedKeyBudgetMember) {
    await removeSharedKeyBudgetMember(prisma, input.userId, now, {
      envPinnedUserIds: input.envPinnedUserIds,
      actorUserId: input.actorUserId,
    });
  }

  return { purgeAfter, priorSharedKeyBudgetMember };
}

/**
 * Clear soft-deletion fields and re-enroll prior shared-key membership through the normal add path.
 * Refuses when past purgeAfter, purge-claimed, or not pending.
 */
export async function restoreAccountSoftDelete(
  prisma: SoftDeletePrisma,
  input: {
    userId: string;
    actorUserId: string;
    /** `otp` = verified-email sign-in/sign-up; `admin` = ops restore. */
    via: "otp" | "admin";
    now?: Date;
    policy?: Parameters<typeof addSharedKeyBudgetMember>[3];
  },
): Promise<
  { restored: true; priorSharedKeyBudgetMember: boolean } | { restored: false; reason: string }
> {
  const now = input.now ?? new Date();
  const outcome = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "user" WHERE id = ${input.userId} FOR UPDATE`;
    const user = await tx.user.findUnique({
      where: { id: input.userId },
      select: {
        id: true,
        deletionRequestedAt: true,
        purgeAfter: true,
        purgeClaimedAt: true,
        priorSharedKeyBudgetMember: true,
      },
    });
    if (!user || user.deletionRequestedAt == null) {
      return { restored: false as const, reason: "not_pending" };
    }
    if (user.purgeClaimedAt != null) {
      return { restored: false as const, reason: "purge_claimed" };
    }
    if (!user.purgeAfter || user.purgeAfter.getTime() <= now.getTime()) {
      return { restored: false as const, reason: "purge_due" };
    }
    const priorSharedKeyBudgetMember = user.priorSharedKeyBudgetMember;
    await tx.user.update({
      where: { id: input.userId },
      data: {
        deactivatedAt: null,
        deletionRequestedAt: null,
        purgeAfter: null,
        deletedByUserId: null,
        priorSharedKeyBudgetMember: false,
        purgeClaimedAt: null,
      },
    });
    await appendAuditEventTx(tx, {
      action: "account.restored",
      actor: { type: "user", id: input.actorUserId },
      target: { type: "user", id: input.userId },
      organizationId: DEPLOYMENT_AUDIT_ORGANIZATION_ID,
      metadata: {
        userId: input.userId,
        via: input.via,
        priorSharedKeyBudgetMember,
      },
    });
    return { restored: true as const, priorSharedKeyBudgetMember };
  });

  if (!outcome.restored) return outcome;

  if (outcome.priorSharedKeyBudgetMember) {
    try {
      await addSharedKeyBudgetMember(prisma, input.userId, now, {
        admin: true,
        actorUserId: input.actorUserId,
        ...input.policy,
      });
    } catch (error) {
      getLogger().error("account.restore.shared_key_reenroll_failed", error, {
        "user.id": input.userId,
      });
    }
  }
  return outcome;
}

/** Find a soft-deleted account by normalized verified email for OTP restore. */
export async function findSoftDeletedUserByEmail(
  prisma: Pick<PrismaClient, "user">,
  email: string,
): Promise<SoftDeletedUser | null> {
  const normalized = normalizeAccountEmail(email);
  const user = await prisma.user.findFirst({
    where: {
      email: { equals: normalized, mode: "insensitive" },
      deletionRequestedAt: { not: null },
    },
    select: {
      id: true,
      email: true,
      emailVerified: true,
      deletionRequestedAt: true,
      purgeAfter: true,
      purgeClaimedAt: true,
      priorSharedKeyBudgetMember: true,
      deactivatedAt: true,
    },
  });
  if (!user || !user.deletionRequestedAt || !user.purgeAfter) return null;
  return {
    id: user.id,
    email: user.email,
    emailVerified: user.emailVerified,
    deletionRequestedAt: user.deletionRequestedAt,
    purgeAfter: user.purgeAfter,
    purgeClaimedAt: user.purgeClaimedAt,
    priorSharedKeyBudgetMember: user.priorSharedKeyBudgetMember,
    deactivatedAt: user.deactivatedAt,
  };
}

/** Accounts the purge worker may claim: pending, past purgeAfter, not yet claimed. */
export async function listAccountsDueForPurge(
  prisma: Pick<PrismaClient, "user">,
  now = new Date(),
  limit = 50,
): Promise<Array<{ id: string; purgeAfter: Date }>> {
  const rows = await prisma.user.findMany({
    where: {
      deletionRequestedAt: { not: null },
      purgeAfter: { lt: now },
      purgeClaimedAt: null,
    },
    select: { id: true, purgeAfter: true },
    orderBy: { purgeAfter: "asc" },
    take: limit,
  });
  return rows.filter((row): row is { id: string; purgeAfter: Date } => row.purgeAfter != null);
}

/**
 * Claim one account for purge inside a transaction. Returns false if a restore won
 * or the account is no longer due.
 */
export async function claimAccountForPurge(
  prisma: SoftDeletePrisma,
  userId: string,
  now = new Date(),
): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "user" WHERE id = ${userId} FOR UPDATE`;
    const user = await tx.user.findUnique({
      where: { id: userId },
      select: {
        deletionRequestedAt: true,
        purgeAfter: true,
        purgeClaimedAt: true,
      },
    });
    if (!user || user.deletionRequestedAt == null || user.purgeClaimedAt != null) return false;
    if (!user.purgeAfter || user.purgeAfter.getTime() >= now.getTime()) return false;
    await tx.user.update({
      where: { id: userId },
      data: { purgeClaimedAt: now },
    });
    return true;
  });
}

/** Re-check pending+claimed+past before the irreversible user-row delete. */
export async function assertStillClaimedForPurge(
  prisma: SoftDeletePrisma,
  userId: string,
  now = new Date(),
): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "user" WHERE id = ${userId} FOR UPDATE`;
    const user = await tx.user.findUnique({
      where: { id: userId },
      select: {
        deletionRequestedAt: true,
        purgeAfter: true,
        purgeClaimedAt: true,
      },
    });
    if (!user || user.deletionRequestedAt == null || user.purgeClaimedAt == null) return false;
    if (!user.purgeAfter || user.purgeAfter.getTime() >= now.getTime()) return false;
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
          "ops.account.restore.failed",
        ],
      },
      createdAt: { gte: new Date(now.getTime() - ACCOUNT_RESTORE_RATE_WINDOW_MS) },
    },
  });
}

/** Directory reactivation must not clear soft-deleted accounts. */
export function directoryMayReactivate(user: { deletionRequestedAt?: Date | null }): boolean {
  return user.deletionRequestedAt == null;
}

export type SoftDeleteClear = {
  deactivatedAt: null;
  deletionRequestedAt: null;
  purgeAfter: null;
  deletedByUserId: null;
  priorSharedKeyBudgetMember: false;
  purgeClaimedAt: null;
};

export const SOFT_DELETE_CLEAR: SoftDeleteClear = {
  deactivatedAt: null,
  deletionRequestedAt: null,
  purgeAfter: null,
  deletedByUserId: null,
  priorSharedKeyBudgetMember: false,
  purgeClaimedAt: null,
};

export type SoftDeleteUserSelect = Prisma.UserSelect;
