import { removePiUserSessions } from "@rakazo/adapters";
import type { PrismaClient } from "@rakazo/db";
import {
  claimAccountForPurge,
  finalizeAccountPurge,
  listAccountsDueForPurge,
  recordSecurityEvent,
  runAsSystem,
} from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { deleteAccountContent } from "./account-deletion.js";
import type { SpaceDeletionDeps } from "./space-deletion.js";

/** Kill switch: deletes for real only when exactly `"true"`. Unset/false → dry-run only. */
export function accountPurgeEnabled(value: string | undefined): boolean {
  return value === "true";
}

export type AccountPurgeDeps = SpaceDeletionDeps & {
  billing?: Parameters<typeof deleteAccountContent>[0]["billing"];
  /** Push token store cleanup (best-effort). */
  pushTokens?: { remove: (userId: string) => Promise<void> };
  dataDir: string;
};

export type AccountPurgeCounts = {
  userId: string;
  tables: Record<string, number>;
  storage: { artifacts: number; homes: number };
};

/**
 * Prisma models with a `userId` column and/or a User relation that purge deletes
 * (directly, via cascade from deleted spaces/bots/user, or in finalize).
 * The enumeration guard fails when the schema gains one not listed here or in RETAINED.
 */
export const ACCOUNT_PURGE_HANDLED_USER_MODELS = [
  "AccessGrant",
  "Account",
  "ActionApprovalRule",
  "ActionAutoReviewPreference",
  "AdminGrant",
  "AgentHome",
  "AgentImport",
  "AgentSecret",
  "AgentSkill",
  "AgentSkillSpace",
  "AiDataConsent",
  "Artifact",
  "Bot",
  "BotMcpServer",
  "BotSecret",
  "BotSection",
  "BrowserProfile",
  "CallPushDevice",
  "CapabilityInstall",
  "CapabilityInstallSpace",
  "ChatGroup",
  "CloudAgent",
  "Computer",
  "ComputerRun",
  "Connection",
  "EmailSend",
  "FeedbackReport",
  "Invitation",
  "McpOAuthSession",
  "McpServer",
  "McpServerSpace",
  "Member",
  "MemoryDocument",
  "MessagingIdentity",
  "MessagingInstallSession",
  "MessagingInstallation",
  "MessagingLinkCode",
  "ModelOAuthSession",
  "NotificationPreference",
  "Page",
  "Passkey",
  "Payment",
  "PaymentWallet",
  "Purchase",
  "PushToken",
  "Routine",
  "Run",
  "ScimIdentityTombstone",
  "ScimProjectionGrant",
  "ScimSubject",
  "ScimUser",
  "ScratchpadItem",
  "Secret",
  "Session",
  "SharedKeyAllotmentTransfer",
  "SharedKeyBudgetEnrollmentRequest",
  "SharedKeyBudgetMember",
  "SharedKeyMemberOverride",
  "SharedKeySpendAdjustment",
  "SharedKeyWeekAllotment",
  "SignupSurvey",
  "Space",
  "SpaceMember",
  "SpaceMemoryConfig",
  "SpaceModelPreference",
  "SpaceModelRoleChoice",
  "SpaceSettingOverride",
  "SpaceVoicePreference",
  "SpendingLimit",
  "SteeringMessage",
  "Task",
  "TaughtSkill",
  "Thread",
  "Ticket",
  "TicketComment",
  "TrustedLinkSite",
  "User",
  "UserActionApprovalRule",
  "UserActionAutoReviewPreference",
  "UserDevice",
  "UserDeviceConnection",
  "UserModelCredential",
  "UserModelPreference",
  "UserModelRoleChoice",
  "UserVoiceCredential",
  "UserVoicePreference",
  "VaultCredential",
  "WebPushSubscription",
] as const;

/** Models with userId / User relation that purge intentionally retains (with reason). */
export const ACCOUNT_PURGE_RETAINED_USER_MODELS = {
  BillingAuditEvent: "billing audit trail",
  ModelCreditEntry: "billing credits ledger",
  SecurityEvent: "security audit trail",
  UsageRecord: "usage metering history",
} as const;

/** @deprecated Prefer ACCOUNT_PURGE_HANDLED_USER_MODELS */
export const ACCOUNT_PURGE_HANDLED_USER_RELATIONS = ACCOUNT_PURGE_HANDLED_USER_MODELS;

export async function countUserOwnedRows(
  prisma: PrismaClient,
  userId: string,
): Promise<AccountPurgeCounts> {
  const tables: Record<string, number> = {};
  const count = async (name: string, fn: () => Promise<number>) => {
    tables[name] = await fn();
  };
  await Promise.all([
    count("session", () => prisma.session.count({ where: { userId } })),
    count("account", () => prisma.account.count({ where: { userId } })),
    count("passkey", () => prisma.passkey.count({ where: { userId } })),
    count("member", () => prisma.member.count({ where: { userId } })),
    count("bot", () => prisma.bot.count({ where: { userId } })),
    count("spaceMember", () => prisma.spaceMember.count({ where: { userId } })),
    count("secret", () => prisma.secret.count({ where: { userId } })),
    count("usageRecord", () => prisma.usageRecord.count({ where: { userId } })),
    count("sharedKeyBudgetMember", () => prisma.sharedKeyBudgetMember.count({ where: { userId } })),
    count("pushToken", () => prisma.pushToken.count({ where: { userId } })),
    count("webPushSubscription", () => prisma.webPushSubscription.count({ where: { userId } })),
    count("userDevice", () => prisma.userDevice.count({ where: { userId } })),
    count("messagingIdentity", () => prisma.messagingIdentity.count({ where: { userId } })),
  ]);
  const artifacts = await prisma.artifact.count({
    where: { space: { createdByUserId: userId } },
  });
  const homes = await prisma.computer.count({
    where: { OR: [{ space: { createdByUserId: userId } }, { bots: { some: { userId } } }] },
  });
  return { userId, tables, storage: { artifacts, homes } };
}

/**
 * Dry-run or live purge of soft-deleted accounts past purgeAfter.
 * When enabled is false, only logs counts (ids, no PII) and deletes nothing.
 * One account failing is logged and the sweep moves on; a claim left by a crash goes
 * stale and a later sweep takes it over.
 */
export function accountPurgeSweep(
  deps: AccountPurgeDeps,
  options: { enabled: boolean },
): (signal: AbortSignal) => Promise<void> {
  return (signal) =>
    runAsSystem("purge soft-deleted accounts past retention", async () => {
      const due = await listAccountsDueForPurge(deps.prisma);
      for (const { id: userId } of due) {
        if (signal.aborted) return;
        try {
          await purgeAccount(deps, userId, options.enabled);
        } catch (error) {
          getLogger().error("account.purge.failed", error, { "user.id": userId });
        }
      }
    });
}

/**
 * Worker reconciler entry: starts a sweep at most once per interval and never holds up the
 * reconciliation pass while accounts are torn down.
 */
export function accountPurgeReconciler(
  deps: AccountPurgeDeps,
  options: { enabled: boolean; signal: AbortSignal; intervalMs?: number; now?: () => number },
): () => Promise<void> {
  const sweep = accountPurgeSweep(deps, options);
  const intervalMs = options.intervalMs ?? 60 * 60 * 1000;
  const now = options.now ?? Date.now;
  let lastRun: number | undefined;
  let running: Promise<void> | undefined;
  return async () => {
    const at = now();
    if (running || (lastRun !== undefined && at - lastRun < intervalMs)) return;
    lastRun = at;
    running = sweep(options.signal)
      .catch((error) => getLogger().error("account purge failed", error))
      .finally(() => {
        running = undefined;
      });
  };
}

async function purgeAccount(deps: AccountPurgeDeps, userId: string, enabled: boolean) {
  const log = getLogger();
  if (!enabled) {
    const counts = await countUserOwnedRows(deps.prisma, userId);
    log.info("account.purge.dry_run", {
      "user.id": userId,
      "purge.enabled": false,
      "purge.tables": counts.tables,
      "purge.storage": counts.storage,
    });
    return;
  }
  const claimedAt = await claimAccountForPurge(deps.prisma, userId);
  if (!claimedAt) {
    log.info("account.purge.skipped", { "user.id": userId, reason: "not_claimable" });
    return;
  }
  await deleteAccountContent(deps, userId);
  if (!(await finalizeAccountPurge(deps.prisma, userId, claimedAt))) {
    log.info("account.purge.aborted", { "user.id": userId, reason: "no_longer_claimed" });
    return;
  }
  await removePiUserSessions(deps.dataDir, userId).catch((error) =>
    log.error("account.purge.pi_sessions_failed", error, { "user.id": userId }),
  );
  await deps.pushTokens
    ?.remove(userId)
    .catch((error) => log.error("account.purge.push_token_failed", error, { "user.id": userId }));
  await recordSecurityEvent({
    type: "ops.account.purged",
    userId,
    metadata: { procedure: "account.purge", by: "account-purge" },
  });
  log.info("account.purge.completed", { "user.id": userId });
}
