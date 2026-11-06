import type { AgentRuntimeEvent, UsageOperationKind } from "@rakazo/adapter-kit";
import type { PrismaClient } from "./generated/prisma/client.js";
import { hasFinalModelCost, settleModelCreditsTx } from "./model-credits.js";
import { withTransactionRetry } from "./transaction-retry.js";

type UsageEvent = Extract<AgentRuntimeEvent, { type: "usage" }>;
export interface UsageAttribution {
  spaceId: string;
  userId: string;
  botId?: string;
  runId?: string;
  parentRunId?: string;
  operationId?: string;
  operationKind?: UsageOperationKind;
}

const USAGE_SUM_FIELDS = ["inputTokens", "outputTokens", "totalTokens", "costUsd"] as const;
export type UsageSumField = (typeof USAGE_SUM_FIELDS)[number];

/**
 * Prisma `_sum` is null for a field when any row in the group is null. Treat that as
 * unknown rather than understating. When `totalTokens` is incomplete but input+output
 * are complete, derive a display total with unmeasured cache as 0 (same as normalizePiUsage).
 */
export function completeUsageSums(group: {
  _sum: Record<UsageSumField, number | null>;
  _count: Record<UsageSumField | "_all", number>;
}): {
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  costUsd: number | null;
  modelCalls: number;
} {
  const complete = (field: UsageSumField) =>
    group._count[field] === group._count._all ? (group._sum[field] ?? 0) : null;
  const inputTokens = complete("inputTokens");
  const outputTokens = complete("outputTokens");
  const storedTotal = complete("totalTokens");
  const derivedTotal =
    storedTotal === null && inputTokens !== null && outputTokens !== null
      ? inputTokens + outputTokens
      : null;
  return {
    inputTokens,
    outputTokens,
    totalTokens: storedTotal ?? derivedTotal,
    costUsd: complete("costUsd"),
    modelCalls: group._count._all,
  };
}

/** Usage is financial history, independent from message clearing or bot deletion. */
export async function recordUsage(
  prisma: Pick<PrismaClient, "$transaction">,
  event: UsageEvent,
  attribution: UsageAttribution,
  reconcile = false,
) {
  const observation = {
    providerRequestId: event.providerRequestId ?? null,
    inputTokens: event.inputTokens,
    outputTokens: event.outputTokens,
    cacheReadTokens: event.cacheReadTokens ?? null,
    cacheWriteTokens: event.cacheWriteTokens ?? null,
    cacheWrite1hTokens: event.cacheWrite1hTokens ?? null,
    reasoningTokens: event.reasoningTokens ?? null,
    totalTokens: event.totalTokens ?? null,
    costUsd: event.costUsd ?? null,
    costSource: event.costSource ?? null,
    pricingVersion: event.pricingVersion ?? null,
    pricingSnapshot: event.pricingSnapshot
      ? JSON.parse(JSON.stringify(event.pricingSnapshot))
      : undefined,
    usageSource: event.usageSource ?? null,
  };
  const data = {
    provider: event.provider,
    model: event.model,
    spaceId: attribution.spaceId,
    userId: attribution.userId,
    botId: attribution.botId,
    runId: attribution.runId,
    operationId: attribution.operationId,
    parentRunId: attribution.parentRunId ?? attribution.runId,
    ...observation,
    callId: event.callId ?? null,
    operationKind: attribution.operationKind ?? event.operationKind ?? "answer",
    agentId: event.agentId ?? null,
  };
  return withTransactionRetry(() =>
    prisma.$transaction(async (tx) => {
      await tx.usageRecord.createMany({ data: [data], skipDuplicates: true });
      const entry = event.callId
        ? await tx.modelCreditEntry.findUnique({ where: { callId: event.callId } })
        : null;
      if (!entry) return;
      if (
        entry.userId !== attribution.userId ||
        entry.spaceId !== attribution.spaceId ||
        entry.provider !== event.provider ||
        entry.model !== event.model
      )
        throw new Error("Usage attribution does not match its credit reservation");
      if (!entry.pending && entry.reconciliationState === "complete" && !reconcile) return;
      let usage = await tx.usageRecord.findUniqueOrThrow({ where: { callId: event.callId! } });
      if (reconcile) {
        usage = await tx.usageRecord.update({
          where: { id: usage.id },
          data: observation,
        });
      }
      await settleModelCreditsTx(tx, entry.id, usage.costUsd, reconcile);
      const complete = hasFinalModelCost(usage);
      await tx.modelCreditEntry.update({
        where: { id: entry.id },
        data: {
          reconciliationState: complete ? "complete" : "pending",
          ...(usage.providerRequestId ? { providerRequestId: usage.providerRequestId } : {}),
          ...(complete ? { nextReconcileAt: null } : {}),
        },
      });
    }),
  );
}
