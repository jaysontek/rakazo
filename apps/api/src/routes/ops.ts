import { ORPCError } from "@orpc/server";
import { requireOpsDashboardAccess } from "../ops-access.js";
import {
  listOpsAgents,
  listOpsRequestLog,
  loadOpsChatLog,
  loadOpsOverview,
} from "../ops-dashboard.js";
import type { RouterContext } from "./context.js";

export function opsRoutes(ctx: RouterContext) {
  const { deps, authed } = ctx;

  async function gate(context: { actor: { userId: string }; clientIp?: string }) {
    await requireOpsDashboardAccess(deps, context.actor.userId, context.clientIp);
  }

  return {
    ops: {
      overview: authed.ops.overview.handler(async ({ context }) => {
        await gate(context);
        const secretsDegraded = deps.secrets?.describe().capabilities.degraded === true;
        return loadOpsOverview(deps.prisma, {
          degraded: secretsDegraded,
          revision: deps.env.gitSha ?? null,
          runtime: deps.env.agentRuntime,
          sandbox: deps.env.sandboxProvider,
        });
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
    },
  };
}
