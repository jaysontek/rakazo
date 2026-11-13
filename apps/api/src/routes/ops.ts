import { ORPCError } from "@orpc/server";
import { parseSharedKeyMonthlyBudgetInput } from "@rakazo/core";
import {
  addAdminGrant,
  listAdminGrants,
  recordSecurityEvent,
  removeAdminGrant,
  requireMembership,
  reverseSharedKeyAllotmentTransfer,
  runAsSystemInTransaction,
  setSharedKeyMonthlyBudgetUsd,
  transferSharedKeyAllotment,
} from "@rakazo/db";
import {
  requireNotImpersonating,
  startImpersonation,
  stopImpersonation,
} from "../impersonation.js";
import { requireOpsDashboardAccess } from "../ops-access.js";
import {
  listOpsAgents,
  listOpsRequestLog,
  loadOpsChatLog,
  loadOpsOverview,
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

  function sharedGoogleApiKey(): string | null {
    return deps.env?.defaultProvider === "google" ? (deps.env.deploymentModelKey ?? null) : null;
  }

  function envBootstrapAdmins(): string[] {
    return deps.env?.adminEmails ?? [];
  }

  return {
    ops: {
      overview: authed.ops.overview.handler(async ({ context }) => {
        await gate(context);
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
            sharedGoogleApiKey: sharedGoogleApiKey(),
            envBootstrapAdmins: envBootstrapAdmins(),
          },
        );
      }),
      agents: authed.ops.agents.handler(async ({ context }) => {
        await gate(context);
        return listOpsAgents(deps.prisma);
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
          spaceId: context.actor.spaceId,
          ip: context.clientIp,
        });
        const targetActor = await requireMembership(
          deps.prisma,
          input.userId,
          null,
          context.sessionId,
        );
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
    },
  };
}
