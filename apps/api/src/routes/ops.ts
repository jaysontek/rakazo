import { ORPCError } from "@orpc/server";
import { parseSharedKeyMonthlyBudgetInput } from "@rakazo/core";
import {
  ACCOUNT_RESTORE_RATE_LIMIT,
  addAdminGrant,
  addSharedKeyBudgetMember,
  adjustSharedKeyTrackedSpend,
  cancelDeactivatedAccountRuns,
  countRecentRestoreAttempts,
  listAdminGrants,
  listSharedKeySpendAdjustments,
  loadSharedKeyBudgetSettingsView,
  normalizeAccountEmail,
  recordSecurityEvent,
  removeAdminGrant,
  removeSharedKeyBudgetMember,
  requestAccountSoftDelete,
  requireMembership,
  restoreAccountSoftDelete,
  reverseSharedKeyAllotmentTransfer,
  reverseSharedKeySpendAdjustment,
  runAsSystemInTransaction,
  setSharedKeyMemberOverride,
  setSharedKeyMonthlyBudgetUsd,
  setSharedKeyTrackedSpend,
  transferSharedKeyAllotment,
  updateSharedKeyBudgetSettings,
} from "@rakazo/db";
import { endDeactivatedAccess } from "../account-status.js";
import {
  requireNotImpersonating,
  startImpersonation,
  stopImpersonation,
  switchImpersonation,
} from "../impersonation.js";
import { requireOpsDashboardAccess } from "../ops-access.js";
import {
  listOpsAgents,
  listOpsOrganizations,
  listOpsRequestLog,
  loadOpsChatLog,
  loadOpsOverview,
  loadOpsTeam,
} from "../ops-dashboard.js";
import type { RouterContext } from "./context.js";
import { meDto } from "./shared.js";

function badRequest(error: unknown): never {
  const message = error instanceof Error ? error.message : "Request failed";
  throw new ORPCError("BAD_REQUEST", { message });
}

export function opsRoutes(ctx: RouterContext) {
  const { deps, authed } = ctx;

  async function gate(context: {
    actor: { userId: string };
    clientIp?: string;
    sessionId?: string;
  }) {
    // Ops UI is unreachable while impersonating (actor is the target). Keep the
    // explicit check so mutations fail closed even if that invariant changes.
    await requireNotImpersonating(deps, context.sessionId);
    await requireOpsDashboardAccess(deps, context.actor.userId, context.clientIp);
  }

  function deploymentModelKey(): string | null {
    // Any deployment provider's shared key — not Google-only. Used only to
    // classify company vs personal via constant-time compare; never returned.
    return deps.env?.deploymentModelKey ?? null;
  }

  function envBootstrapAdmins(): string[] {
    return deps.env?.adminEmails ?? [];
  }

  function envPinnedSharedKeyUserIds(): string[] {
    return deps.env?.sharedKeyBudgetUserIds ?? [];
  }

  return {
    ops: {
      overview: authed.ops.overview.handler(async ({ context }) => {
        await gate(context);
        // Read-only overview: roster is maintained on the shared-key reserve path
        // and by explicit SHARED_KEY_BUDGET_USER_IDS. Key labels decrypt stored
        // credentials only to classify company vs personal — never return key values.
        const secretsDegraded = deps.secrets?.describe().capabilities.degraded === true;
        return loadOpsOverview(
          deps.prisma,
          {
            degraded: secretsDegraded,
            revision: deps.env?.gitSha ?? null,
            runtime: deps.env?.agentRuntime,
            sandbox: deps.env?.sandboxProvider,
          },
          undefined,
          deps.env?.sharedKeyMonthlyBudgetUsd ?? null,
          {
            secrets: deps.secrets,
            deploymentModelKey: deploymentModelKey(),
            envBootstrapAdmins: envBootstrapAdmins(),
            sharedKeyBudgetUserIds: envPinnedSharedKeyUserIds(),
          },
        );
      }),
      agents: authed.ops.agents.handler(async ({ context }) => {
        await gate(context);
        // Key labels decrypt stored credentials only to classify company vs personal —
        // never return key values. One bad credential must not fail the page.
        return listOpsAgents(deps.prisma, {
          secrets: deps.secrets,
          deploymentModelKey: deploymentModelKey(),
        });
      }),
      requestLog: authed.ops.requestLog.handler(async ({ context, input }) => {
        await gate(context);
        return listOpsRequestLog(deps.prisma, input ?? {});
      }),
      chatLog: authed.ops.chatLog.handler(async ({ context, input }) => {
        await gate(context);
        try {
          return await loadOpsChatLog(deps.prisma, input);
        } catch (error) {
          const message = error instanceof Error ? error.message : "Chat log unavailable";
          if (message === "Run not found" || message === "Thread not found") {
            throw new ORPCError("NOT_FOUND", { message });
          }
          if (message === "runId or threadId required") {
            throw new ORPCError("BAD_REQUEST", { message });
          }
          throw error;
        }
      }),
      setSharedKeyMonthlyBudget: authed.ops.setSharedKeyMonthlyBudget.handler(
        async ({ context, input }) => {
          await gate(context);
          const monthlyCapUsd = parseSharedKeyMonthlyBudgetInput(input.monthlyCapUsd);
          if (monthlyCapUsd == null) {
            throw new ORPCError("BAD_REQUEST", {
              message: "monthlyCapUsd must be a positive number within the allowed range",
            });
          }
          const saved = await setSharedKeyMonthlyBudgetUsd(deps.prisma, monthlyCapUsd);
          await recordSecurityEvent({
            type: "deployment.settings.changed",
            userId: context.actor.userId,
            spaceId: context.actor.spaceId,
            metadata: {
              procedure: "ops.setSharedKeyMonthlyBudget",
              kind: "shared_key_monthly_budget",
              monthlyCapUsd: saved.monthlyCapUsd,
              previousMonthlyCapUsd: saved.previousMonthlyCapUsd,
            },
          });
          return { monthlyCapUsd: saved.monthlyCapUsd };
        },
      ),
      listAdminGrants: authed.ops.listAdminGrants.handler(async ({ context }) => {
        await gate(context);
        return listAdminGrants(deps.prisma, envBootstrapAdmins());
      }),
      addAdminGrant: authed.ops.addAdminGrant.handler(async ({ context, input }) => {
        await gate(context);
        let grant;
        try {
          grant = await deps.prisma.$transaction(async (tx) => {
            const created = await addAdminGrant(
              tx as typeof deps.prisma,
              { userId: input.userId, grantedById: context.actor.userId },
              envBootstrapAdmins(),
            );
            await runAsSystemInTransaction(tx, "append a security event", () =>
              (tx as typeof deps.prisma).securityEvent.create({
                data: {
                  type: "ops.admin_grant.added",
                  userId: context.actor.userId,
                  spaceId: context.actor.spaceId,
                  metadata: {
                    procedure: "ops.addAdminGrant",
                    targetUserId: created.userId,
                  },
                },
              }),
            );
            return created;
          });
        } catch (error) {
          badRequest(error);
        }
        return grant;
      }),
      removeAdminGrant: authed.ops.removeAdminGrant.handler(async ({ context, input }) => {
        await gate(context);
        try {
          await deps.prisma.$transaction(async (tx) => {
            await removeAdminGrant(
              tx as typeof deps.prisma,
              input.userId,
              envBootstrapAdmins(),
              context.actor.userId,
            );
            await runAsSystemInTransaction(tx, "append a security event", () =>
              (tx as typeof deps.prisma).securityEvent.create({
                data: {
                  type: "ops.admin_grant.removed",
                  userId: context.actor.userId,
                  spaceId: context.actor.spaceId,
                  metadata: {
                    procedure: "ops.removeAdminGrant",
                    targetUserId: input.userId,
                  },
                },
              }),
            );
          });
        } catch (error) {
          badRequest(error);
        }
        return { ok: true as const };
      }),
      startImpersonation: authed.ops.startImpersonation.handler(async ({ context, input }) => {
        await gate(context);
        if (!context.sessionId) throw new ORPCError("UNAUTHORIZED");
        await startImpersonation(deps, {
          sessionId: context.sessionId,
          adminUserId: context.actor.userId,
          targetUserId: input.userId,
          organizationId: input.organizationId,
          spaceId: context.actor.spaceId,
          ip: context.clientIp,
        });
        // View-only: omit sessionId so requireMembership does not re-pin activeOrganizationId.
        const targetActor = await requireMembership(deps.prisma, input.userId, null, undefined);
        return meDto(deps, targetActor, context.sessionId);
      }),
      stopImpersonation: authed.ops.stopImpersonation.handler(async ({ context }) => {
        // While impersonating, actor.userId is the target — do not use the ops gate.
        // Always allow exit; do not re-check that the impersonator is still an admin.
        if (!context.sessionId) throw new ORPCError("UNAUTHORIZED");
        const session = await deps.prisma.session.findUnique({
          where: { id: context.sessionId },
          select: { impersonatedBy: true, userId: true },
        });
        if (!session?.impersonatedBy) {
          throw new ORPCError("BAD_REQUEST", { message: "Not impersonating" });
        }
        const { adminUserId, endedSession } = await stopImpersonation(deps, {
          sessionId: context.sessionId,
          expectedAdminUserId: session.impersonatedBy,
          spaceId: context.actor.spaceId,
          ip: context.clientIp,
          reason: "manual",
        });
        if (endedSession) {
          throw new ORPCError("UNAUTHORIZED", { message: "Session ended" });
        }
        const adminActor = await requireMembership(
          deps.prisma,
          adminUserId,
          null,
          context.sessionId,
        );
        return meDto(deps, adminActor, context.sessionId);
      }),
      switchImpersonation: authed.ops.switchImpersonation.handler(async ({ context, input }) => {
        // While impersonating, actor is the target — do not use the normal ops gate
        // (requireNotImpersonating). Verify the impersonator is still an admin.
        if (!context.sessionId) throw new ORPCError("UNAUTHORIZED");
        const session = await deps.prisma.session.findUnique({
          where: { id: context.sessionId },
          select: { impersonatedBy: true, userId: true },
        });
        if (!session?.impersonatedBy) {
          throw new ORPCError("BAD_REQUEST", { message: "Not impersonating" });
        }
        // Impersonator must still be admin + on an allowed network (actor is the target).
        await requireOpsDashboardAccess(deps, session.impersonatedBy, context.clientIp);
        await switchImpersonation(deps, {
          sessionId: context.sessionId,
          adminUserId: session.impersonatedBy,
          targetUserId: input.userId,
          organizationId: input.organizationId,
          spaceId: context.actor.spaceId,
          ip: context.clientIp,
        });
        // View-only: omit sessionId so requireMembership does not re-pin activeOrganizationId.
        const targetActor = await requireMembership(deps.prisma, input.userId, null, undefined);
        return meDto(deps, targetActor, context.sessionId);
      }),
      team: authed.ops.team.handler(async ({ context, input }) => {
        await gate(context);
        const secretsDegraded = deps.secrets?.describe().capabilities.degraded === true;
        try {
          return await loadOpsTeam(
            deps.prisma,
            input.organizationId,
            {
              degraded: secretsDegraded,
              revision: deps.env?.gitSha ?? null,
              runtime: deps.env?.agentRuntime,
              sandbox: deps.env?.sandboxProvider,
            },
            deps.env?.sharedKeyMonthlyBudgetUsd ?? null,
            {
              secrets: deps.secrets,
              deploymentModelKey: deploymentModelKey(),
              envBootstrapAdmins: envBootstrapAdmins(),
            },
          );
        } catch (error) {
          const message = error instanceof Error ? error.message : "Team unavailable";
          if (message === "Organization not found") {
            throw new ORPCError("NOT_FOUND", { message });
          }
          throw error;
        }
      }),
      organizations: authed.ops.organizations.handler(async ({ context }) => {
        await gate(context);
        return listOpsOrganizations(deps.prisma);
      }),
      transferSharedKeyAllotment: authed.ops.transferSharedKeyAllotment.handler(
        async ({ context, input }) => {
          await gate(context);
          try {
            return await transferSharedKeyAllotment(deps.prisma, {
              fromUserId: input.fromUserId,
              toUserId: input.toUserId,
              createdById: context.actor.userId,
              audit: async (tx, transfer) => {
                await runAsSystemInTransaction(tx, "append a security event", () =>
                  (tx as typeof deps.prisma).securityEvent.create({
                    data: {
                      type: "ops.shared_key_allotment.transferred",
                      userId: context.actor.userId,
                      spaceId: context.actor.spaceId,
                      metadata: {
                        procedure: "ops.transferSharedKeyAllotment",
                        transferId: transfer.id,
                        fromUserId: transfer.fromUserId,
                        toUserId: transfer.toUserId,
                        amountUsd: transfer.amountUsd,
                      },
                    },
                  }),
                );
              },
            });
          } catch (error) {
            badRequest(error);
          }
        },
      ),
      reverseSharedKeyAllotmentTransfer: authed.ops.reverseSharedKeyAllotmentTransfer.handler(
        async ({ context, input }) => {
          await gate(context);
          try {
            return await reverseSharedKeyAllotmentTransfer(deps.prisma, {
              transferId: input.transferId,
              audit: async (tx, result) => {
                await runAsSystemInTransaction(tx, "append a security event", () =>
                  (tx as typeof deps.prisma).securityEvent.create({
                    data: {
                      type: "ops.shared_key_allotment.reversed",
                      userId: context.actor.userId,
                      spaceId: context.actor.spaceId,
                      metadata: {
                        procedure: "ops.reverseSharedKeyAllotmentTransfer",
                        transferId: result.transfer.id,
                        clamped: result.clamped,
                        amountUsd: result.transfer.amountUsd,
                      },
                    },
                  }),
                );
              },
            });
          } catch (error) {
            badRequest(error);
          }
        },
      ),
      addSharedKeyBudgetMember: authed.ops.addSharedKeyBudgetMember.handler(
        async ({ context, input }) => {
          await gate(context);
          try {
            const result = await addSharedKeyBudgetMember(deps.prisma, input.userId, new Date(), {
              admin: true,
              actorUserId: context.actor.userId,
            });
            return {
              ok: true as const,
              enrolled: result.enrolled,
              ...(result.enrolled ? {} : { reason: result.reason }),
            };
          } catch (error) {
            badRequest(error);
          }
        },
      ),
      updateSharedKeyBudgetSettings: authed.ops.updateSharedKeyBudgetSettings.handler(
        async ({ context, input }) => {
          await gate(context);
          try {
            const result = await updateSharedKeyBudgetSettings(deps.prisma, input, {
              actorUserId: context.actor.userId,
              gatedDeployment: deps.env?.sharedKeyGatedDeployment === true,
              spaceId: context.actor.spaceId,
            });
            const previous = result.previous;
            const changedMeta: Record<string, string | number | boolean | null> = {
              procedure: "ops.updateSharedKeyBudgetSettings",
              applyScheduleNow: result.applyScheduleNow,
            };
            const track = (
              field: string,
              prev: string | number | boolean | null | undefined,
              next: string | number | boolean | null | undefined,
            ) => {
              if (next === undefined) return;
              changedMeta[`prev.${field}`] = prev ?? null;
              changedMeta[`next.${field}`] = next;
            };
            track("monthlyCapUsd", previous?.sharedKeyMonthlyBudgetUsd, input.monthlyCapUsd);
            track("period", previous?.sharedKeyPeriod, input.period);
            track("resetDow", previous?.sharedKeyResetDow, input.resetDow);
            track("resetDom", previous?.sharedKeyResetDom, input.resetDom);
            track("resetMinutes", previous?.sharedKeyResetMinutes, input.resetMinutes);
            track("timezone", previous?.sharedKeyTimezone, input.timezone);
            track("autoEnrollMode", previous?.sharedKeyAutoEnrollMode, input.autoEnrollMode);
            if (input.warningThresholds !== undefined) {
              track(
                "warningThresholds",
                previous?.sharedKeyWarningThresholds == null
                  ? null
                  : JSON.stringify(previous.sharedKeyWarningThresholds),
                input.warningThresholds == null ? null : JSON.stringify(input.warningThresholds),
              );
            }
            track("hardStopEnabled", previous?.sharedKeyHardStopEnabled, input.hardStopEnabled);
            track("holdStaleMinutes", previous?.sharedKeyHoldStaleMinutes, input.holdStaleMinutes);
            track("pruneInactive", previous?.sharedKeyPruneInactive, input.pruneInactive);
            await recordSecurityEvent({
              type: "ops.shared_key_budget.settings.changed",
              userId: context.actor.userId,
              spaceId: context.actor.spaceId,
              metadata: changedMeta,
            });
            return loadSharedKeyBudgetSettingsView(
              deps.prisma,
              deps.env?.sharedKeyMonthlyBudgetUsd ?? null,
            );
          } catch (error) {
            badRequest(error);
          }
        },
      ),
      setSharedKeyMemberOverride: authed.ops.setSharedKeyMemberOverride.handler(
        async ({ context, input }) => {
          await gate(context);
          try {
            await setSharedKeyMemberOverride(deps.prisma, {
              userId: input.userId,
              weeklyAllotmentUsd: input.weeklyAllotmentUsd,
              actorUserId: context.actor.userId,
              spaceId: context.actor.spaceId,
            });
            await recordSecurityEvent({
              type: "ops.shared_key_budget.member.override",
              userId: context.actor.userId,
              spaceId: context.actor.spaceId,
              metadata: {
                procedure: "ops.setSharedKeyMemberOverride",
                targetUserId: input.userId,
                "next.weeklyAllotmentUsd": input.weeklyAllotmentUsd,
              },
            });
            return { ok: true as const };
          } catch (error) {
            badRequest(error);
          }
        },
      ),
      removeSharedKeyBudgetMember: authed.ops.removeSharedKeyBudgetMember.handler(
        async ({ context, input }) => {
          await gate(context);
          try {
            await removeSharedKeyBudgetMember(deps.prisma, input.userId, new Date(), {
              envPinnedUserIds: envPinnedSharedKeyUserIds(),
              actorUserId: context.actor.userId,
            });
            await recordSecurityEvent({
              type: "ops.shared_key_budget.member.removed",
              userId: context.actor.userId,
              spaceId: context.actor.spaceId,
              metadata: {
                procedure: "ops.removeSharedKeyBudgetMember",
                targetUserId: input.userId,
              },
            });
            return { ok: true as const };
          } catch (error) {
            badRequest(error);
          }
        },
      ),
      softDeleteAccount: authed.ops.softDeleteAccount.handler(async ({ context, input }) => {
        await gate(context);
        try {
          const result = await requestAccountSoftDelete(deps.prisma, {
            userId: input.userId,
            actorUserId: context.actor.userId,
            envPinnedUserIds: envPinnedSharedKeyUserIds(),
          });
          // Same teardown as directory/operator deactivate: sessions, devices, push, runs.
          if (deps.devices) {
            await endDeactivatedAccess(
              {
                prisma: deps.prisma,
                pushTokens: deps.pushTokens,
                devices: deps.devices,
                events: deps.events,
              },
              input.userId,
            ).catch(() => undefined);
          } else {
            await cancelDeactivatedAccountRuns(deps.prisma, deps.events, input.userId).catch(
              () => undefined,
            );
          }
          await recordSecurityEvent({
            type: "ops.account.soft_deleted",
            userId: context.actor.userId,
            spaceId: context.actor.spaceId,
            metadata: {
              procedure: "ops.softDeleteAccount",
              targetUserId: input.userId,
              priorSharedKeyBudgetMember: result.priorSharedKeyBudgetMember,
            },
          });
          return {
            ok: true as const,
            purgeAfter: result.purgeAfter.toISOString(),
            priorSharedKeyBudgetMember: result.priorSharedKeyBudgetMember,
          };
        } catch (error) {
          badRequest(error);
        }
      }),
      restoreAccount: authed.ops.restoreAccount.handler(async ({ context, input }) => {
        await gate(context);
        const target = await deps.prisma.user.findUnique({
          where: { id: input.userId },
          select: {
            id: true,
            email: true,
            deletionRequestedAt: true,
            purgeAfter: true,
            purgeClaimedAt: true,
          },
        });
        if (!target || target.deletionRequestedAt == null) {
          throw new ORPCError("BAD_REQUEST", { message: "Account is not pending deletion" });
        }
        if (
          normalizeAccountEmail(input.emailConfirmation) !== normalizeAccountEmail(target.email)
        ) {
          await recordSecurityEvent({
            type: "ops.account.restore.failed",
            userId: context.actor.userId,
            spaceId: context.actor.spaceId,
            metadata: {
              procedure: "ops.restoreAccount",
              targetUserId: input.userId,
              reason: "email_mismatch",
            },
          });
          throw new ORPCError("BAD_REQUEST", { message: "Email confirmation does not match" });
        }
        const attempts = await countRecentRestoreAttempts(deps.prisma, input.userId);
        await recordSecurityEvent({
          type: "auth.account.restore.attempted",
          userId: context.actor.userId,
          spaceId: context.actor.spaceId,
          metadata: {
            procedure: "ops.restoreAccount",
            targetUserId: input.userId,
            attempts,
          },
        });
        if (attempts >= ACCOUNT_RESTORE_RATE_LIMIT) {
          await recordSecurityEvent({
            type: "ops.account.restore.failed",
            userId: context.actor.userId,
            spaceId: context.actor.spaceId,
            metadata: {
              procedure: "ops.restoreAccount",
              targetUserId: input.userId,
              reason: "rate_limited",
            },
          });
          throw new ORPCError("TOO_MANY_REQUESTS", { message: "Too many restore attempts" });
        }
        try {
          const outcome = await restoreAccountSoftDelete(deps.prisma, {
            userId: input.userId,
            actorUserId: context.actor.userId,
            via: "admin",
          });
          if (!outcome.restored) {
            await recordSecurityEvent({
              type: "ops.account.restore.failed",
              userId: context.actor.userId,
              spaceId: context.actor.spaceId,
              metadata: {
                procedure: "ops.restoreAccount",
                targetUserId: input.userId,
                reason: outcome.reason,
              },
            });
            throw new ORPCError("BAD_REQUEST", {
              message:
                outcome.reason === "purge_due" || outcome.reason === "purge_claimed"
                  ? "Account is past its restore window"
                  : "Could not restore account",
            });
          }
          await recordSecurityEvent({
            type: "ops.account.restored",
            userId: context.actor.userId,
            spaceId: context.actor.spaceId,
            metadata: {
              procedure: "ops.restoreAccount",
              targetUserId: input.userId,
              priorSharedKeyBudgetMember: outcome.priorSharedKeyBudgetMember,
            },
          });
          return { ok: true as const };
        } catch (error) {
          if (error instanceof ORPCError) throw error;
          badRequest(error);
        }
      }),
      setSharedKeyTrackedSpend: authed.ops.setSharedKeyTrackedSpend.handler(
        async ({ context, input }) => {
          await gate(context);
          try {
            const row = await setSharedKeyTrackedSpend(deps.prisma, {
              targetUsd: input.targetUsd,
              reason: input.reason,
              userId: input.userId,
              createdById: context.actor.userId,
            });
            await recordSecurityEvent({
              type: "ops.shared_key_spend.set",
              userId: context.actor.userId,
              spaceId: context.actor.spaceId,
              metadata: {
                procedure: "ops.setSharedKeyTrackedSpend",
                adjustmentId: row.id,
                targetUsd: input.targetUsd,
                deltaUsd: row.deltaUsd,
                targetUserId: input.userId ?? null,
              },
            });
            return row;
          } catch (error) {
            badRequest(error);
          }
        },
      ),
      adjustSharedKeyTrackedSpend: authed.ops.adjustSharedKeyTrackedSpend.handler(
        async ({ context, input }) => {
          await gate(context);
          try {
            const row = await adjustSharedKeyTrackedSpend(deps.prisma, {
              deltaUsd: input.deltaUsd,
              reason: input.reason,
              userId: input.userId,
              createdById: context.actor.userId,
            });
            await recordSecurityEvent({
              type: "ops.shared_key_spend.adjusted",
              userId: context.actor.userId,
              spaceId: context.actor.spaceId,
              metadata: {
                procedure: "ops.adjustSharedKeyTrackedSpend",
                adjustmentId: row.id,
                deltaUsd: row.deltaUsd,
                targetUserId: input.userId ?? null,
              },
            });
            return row;
          } catch (error) {
            badRequest(error);
          }
        },
      ),
      reverseSharedKeySpendAdjustment: authed.ops.reverseSharedKeySpendAdjustment.handler(
        async ({ context, input }) => {
          await gate(context);
          try {
            const row = await reverseSharedKeySpendAdjustment(deps.prisma, {
              adjustmentId: input.adjustmentId,
              reason: input.reason,
              createdById: context.actor.userId,
            });
            await recordSecurityEvent({
              type: "ops.shared_key_spend.reversed",
              userId: context.actor.userId,
              spaceId: context.actor.spaceId,
              metadata: {
                procedure: "ops.reverseSharedKeySpendAdjustment",
                adjustmentId: row.id,
                reversesId: input.adjustmentId,
                deltaUsd: row.deltaUsd,
              },
            });
            return row;
          } catch (error) {
            badRequest(error);
          }
        },
      ),
      listSharedKeySpendAdjustments: authed.ops.listSharedKeySpendAdjustments.handler(
        async ({ context, input }) => {
          await gate(context);
          return listSharedKeySpendAdjustments(deps.prisma, {
            limit: input?.limit,
          });
        },
      ),
    },
  };
}
