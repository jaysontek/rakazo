import { removePiUserSessions } from "@rakazo/adapters";
import type { PrismaClient } from "@rakazo/db";
import {
  assertStillClaimedForPurge,
  claimAccountForPurge,
  listAccountsDueForPurge,
  personalOrganizationIds,
  recordAuditEvent,
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
 * Prisma model names that hold a user-owned row (direct user relation).
 * The enumeration guard test fails if schema gains a User relation not listed here
 * and not covered by cascade-on-user-delete or deleteAccountContent.
 */
export const ACCOUNT_PURGE_HANDLED_USER_RELATIONS = [
  "AccessGrant",
  "Account",
  "ActionApprovalRule",
  "ActionAutoReviewPreference",
  "AdminGrant",
  "AgentSecret",
  "AiDataConsent",
  "BotSecret",
  "BotSection",
  "CallPushDevice",
  "ComputerRun",
  "EmailSend",
  "FeedbackReport",
  "Invitation",
  "McpServer",
  "Member",
  "MessagingInstallSession",
  "MessagingInstallation",
  "Page",
  "Passkey",
  "Payment",
  "PaymentWallet",
  "PushToken",
  "ScimIdentityTombstone",
  "ScimProjectionGrant",
  "ScimSubject",
  "ScimUser",
  "Secret",
  "Session",
  "SharedKeyAllotmentTransfer",
  "SharedKeyBudgetEnrollmentRequest",
  "SharedKeyBudgetMember",
  "SharedKeyMemberOverride",
  "SharedKeySpendAdjustment",
  "SignupSurvey",
  "Space",
  "SpendingLimit",
  "Ticket",
  "TicketComment",
  "TrustedLinkSite",
  "User",
  "UserActionApprovalRule",
  "UserActionAutoReviewPreference",
  "UserDevice",
  "UserModelCredential",
  "UserModelPreference",
  "UserModelRoleChoice",
  "UserVoiceCredential",
  "UserVoicePreference",
  "VaultCredential",
  "WebPushSubscription",
] as const;

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
 */
export function accountPurgeSweep(
  deps: AccountPurgeDeps,
  options: { enabled: boolean },
): (signal: AbortSignal) => Promise<void> {
  return (signal) =>
    runAsSystem("purge soft-deleted accounts past retention", async () => {
      const due = await listAccountsDueForPurge(deps.prisma);
      const log = getLogger();
      for (const { id: userId } of due) {
        if (signal.aborted) return;
        const counts = await countUserOwnedRows(deps.prisma, userId);
        if (!options.enabled) {
          log.info("account.purge.dry_run", {
            "user.id": userId,
            "purge.enabled": false,
            "purge.tables": counts.tables,
            "purge.storage": counts.storage,
          });
          continue;
        }
        const claimed = await claimAccountForPurge(deps.prisma, userId);
        if (!claimed) {
          log.info("account.purge.skipped", {
            "user.id": userId,
            reason: "not_claimable",
          });
          continue;
        }
        try {
          await deleteAccountContent(deps, userId);
          if (!(await assertStillClaimedForPurge(deps.prisma, userId))) {
            log.info("account.purge.aborted", {
              "user.id": userId,
              reason: "no_longer_claimed",
            });
            continue;
          }
          await finalizeAccountPurge(deps, userId);
          await recordSecurityEvent({
            type: "ops.account.purged",
            userId,
            metadata: { procedure: "account.purge" },
          });
          await recordAuditEvent({
            action: "account.purged",
            actor: { type: "system", label: "account-purge" },
            target: { type: "user", id: userId },
            metadata: { userId },
          });
          log.info("account.purge.completed", { "user.id": userId });
        } catch (error) {
          log.error("account.purge.failed", error, { "user.id": userId });
        }
      }
    });
}

/** Delete auth leftovers and the user row after content teardown. Idempotent. */
async function finalizeAccountPurge(deps: AccountPurgeDeps, userId: string): Promise<void> {
  const organizationIds = await personalOrganizationIds(deps.prisma, userId);
  await deps.prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "user" WHERE id = ${userId} FOR UPDATE`;
    const user = await tx.user.findUnique({
      where: { id: userId },
      select: {
        deletionRequestedAt: true,
        purgeAfter: true,
        purgeClaimedAt: true,
      },
    });
    if (
      !user ||
      user.deletionRequestedAt == null ||
      user.purgeClaimedAt == null ||
      !user.purgeAfter ||
      user.purgeAfter.getTime() >= Date.now()
    ) {
      return;
    }
    await tx.messagingIdentity.deleteMany({ where: { userId } });
    await tx.passkey.deleteMany({ where: { userId } });
    await tx.session.deleteMany({ where: { userId } });
    await tx.organization.deleteMany({ where: { id: { in: organizationIds } } });
    await tx.user.deleteMany({ where: { id: userId } });
  });
  await removePiUserSessions(deps.dataDir, userId).catch((error) =>
    getLogger().error("account.purge.pi_sessions_failed", error, { "user.id": userId }),
  );
  await deps.pushTokens
    ?.remove(userId)
    .catch((error) =>
      getLogger().error("account.purge.push_token_failed", error, { "user.id": userId }),
    );
}
