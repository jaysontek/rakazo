import type { ModelCallObserver } from "@rakazo/adapter-kit";
import {
  SHARED_KEY_BUDGET_NOT_ENROLLED_ERROR,
  SHARED_KEY_WEEKLY_BUDGET_ERROR,
} from "@rakazo/core";
import type { PrismaClient, SharedKeyBudgetEnrollmentPolicy } from "@rakazo/db";
import {
  releaseSharedKeyBudgetHold,
  reserveSharedKeyBudget,
  SharedKeyBudgetNotEnrolledError,
  SharedKeyWeeklyBudgetExceededError,
  STRICT_SHARED_KEY_ENROLLMENT_POLICY,
  sharedKeyMonthlyBudgetUsd,
} from "@rakazo/db";

export class SharedKeyWeeklyBudgetExceededRunError extends Error {
  constructor(message = SHARED_KEY_WEEKLY_BUDGET_ERROR) {
    super(message);
    this.name = "SharedKeyWeeklyBudgetExceededRunError";
  }
}

export class SharedKeyBudgetNotEnrolledRunError extends Error {
  constructor(message = SHARED_KEY_BUDGET_NOT_ENROLLED_ERROR) {
    super(message);
    this.name = "SharedKeyBudgetNotEnrolledRunError";
  }
}

type Hold = { userId: string; maxCostUsd: number };

function encodeHold(hold: Hold): string {
  return `shared-key-budget:${hold.userId}:${hold.maxCostUsd}`;
}

function decodeHold(reservationId: string): Hold | null {
  const match = /^shared-key-budget:([^:]+):(.+)$/.exec(reservationId);
  if (!match) return null;
  const maxCostUsd = Number(match[2]);
  if (!Number.isFinite(maxCostUsd)) return null;
  return { userId: match[1]!, maxCostUsd };
}

/**
 * Hard-stop when the current user has used their weekly share of the deployment shared key.
 * Personal connections never attach this observer. When model fallback is also in play, call
 * {@link assertSharedKeyWeeklyBudget} (or attach this observer) before spending the shared key
 * on a backup — the weekly hard-stop wins.
 *
 * `enrollmentPolicy` must come from {@link sharedKeyBudgetEnrollmentPolicyFromEnv} in api/worker.
 * Missing policy falls back to the strict open-signup bar (never the gated fail-open default).
 */
export async function sharedKeyBudgetObserver(
  prisma: PrismaClient,
  scope: { userId: string },
  envFallback: number | null = null,
  enrollmentPolicy: SharedKeyBudgetEnrollmentPolicy = STRICT_SHARED_KEY_ENROLLMENT_POLICY,
): Promise<ModelCallObserver | undefined> {
  if (!(await sharedKeyMonthlyBudgetUsd(prisma, envFallback))) return undefined;
  return {
    beforeCall: async (call) => {
      const maxCostUsd = call.maxCostUsd ?? 0;
      try {
        await reserveSharedKeyBudget(prisma, scope.userId, maxCostUsd, new Date(), enrollmentPolicy);
      } catch (error) {
        if (error instanceof SharedKeyBudgetNotEnrolledError) {
          throw new SharedKeyBudgetNotEnrolledRunError();
        }
        if (error instanceof SharedKeyWeeklyBudgetExceededError) {
          throw new SharedKeyWeeklyBudgetExceededRunError();
        }
        throw error;
      }
      return encodeHold({ userId: scope.userId, maxCostUsd });
    },
    afterCall: async (reservationId) => {
      const hold = decodeHold(reservationId);
      if (!hold) return;
      await releaseSharedKeyBudgetHold(prisma, hold.userId, hold.maxCostUsd);
    },
  };
}

/**
 * Shared check for model-fallback and other shared-key paths: refuse before any spend once the
 * weekly cap is reached. No-ops when the monthly cap is unset. Does not reserve; pair with the
 * observer on the live call path.
 */
export async function assertSharedKeyWeeklyBudget(
  prisma: PrismaClient,
  userId: string,
  estimateCostUsd = 0,
  now = new Date(),
  envFallback: number | null = null,
  enrollmentPolicy: SharedKeyBudgetEnrollmentPolicy = STRICT_SHARED_KEY_ENROLLMENT_POLICY,
): Promise<void> {
  if (!(await sharedKeyMonthlyBudgetUsd(prisma, envFallback))) return;
  try {
    await reserveSharedKeyBudget(prisma, userId, estimateCostUsd, now, enrollmentPolicy);
  } catch (error) {
    if (error instanceof SharedKeyBudgetNotEnrolledError) {
      throw new SharedKeyBudgetNotEnrolledRunError();
    }
    if (error instanceof SharedKeyWeeklyBudgetExceededError) {
      throw new SharedKeyWeeklyBudgetExceededRunError();
    }
    throw error;
  }
  await releaseSharedKeyBudgetHold(prisma, userId, estimateCostUsd, now);
}

/**
 * Run the shared-key weekly hard-stop before any inner observer (e.g. model credits).
 * Weekly budget always wins over continuing to spend the shared key.
 */
export function composeSharedKeyBudgetObserver(
  budget: ModelCallObserver | undefined,
  inner: ModelCallObserver | undefined,
): ModelCallObserver | undefined {
  if (!budget) return inner;
  if (!inner) return budget;
  return {
    beforeCall: async (call) => {
      const budgetId = await budget.beforeCall(call);
      try {
        const innerId = await inner.beforeCall(call);
        return JSON.stringify({ budgetId, innerId });
      } catch (error) {
        await budget.afterCall(budgetId, null);
        throw error;
      }
    },
    afterCall: async (reservationId, usage) => {
      let budgetId = reservationId;
      let innerId: string | undefined;
      try {
        const parsed = JSON.parse(reservationId) as { budgetId?: string; innerId?: string };
        if (typeof parsed.budgetId === "string") budgetId = parsed.budgetId;
        if (typeof parsed.innerId === "string") innerId = parsed.innerId;
      } catch {
        /* plain budget id */
      }
      try {
        if (innerId !== undefined) await inner.afterCall(innerId, usage);
      } finally {
        await budget.afterCall(budgetId, usage);
      }
    },
    onRequestId: async (reservationId, providerRequestId) => {
      if (!inner.onRequestId) return;
      try {
        const parsed = JSON.parse(reservationId) as { innerId?: string };
        if (typeof parsed.innerId === "string") {
          await inner.onRequestId(parsed.innerId, providerRequestId);
          return;
        }
      } catch {
        /* fall through */
      }
      await inner.onRequestId(reservationId, providerRequestId);
    },
  };
}
