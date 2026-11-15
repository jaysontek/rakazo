/**
 * Append-only tracked-spend adjustments for the shared company key.
 * Every mutation takes the shared-key budget advisory lock; there is no update/delete.
 */
import { effectiveSharedKeySpendUsd, roundUsdToCents, sharedKeyPeriodEnd } from "@rakazo/core";
import type { PrismaClient } from "./client.js";
import { Prisma } from "./client.js";
import {
  lockSharedKeyBudget,
  resolveSharedKeyPeriodBounds,
  scheduleFromSettings,
  SHARED_KEY_BUDGET_MEMBERS_LOCK,
} from "./shared-key-budget.js";
import {
  trackedSharedKeySpendUsd,
  trackedSharedKeyTeamSpendUsd,
} from "./shared-key-spend.js";

type AdjPrisma = Pick<
  PrismaClient,
  | "deploymentSettings"
  | "sharedKeySpendAdjustment"
  | "sharedKeyWeekAllotment"
  | "usageRecord"
  | "user"
  | "$transaction"
  | "$queryRaw"
>;

type AdjTx = Pick<
  Prisma.TransactionClient,
  | "deploymentSettings"
  | "sharedKeySpendAdjustment"
  | "sharedKeyWeekAllotment"
  | "usageRecord"
  | "user"
  | "$queryRaw"
>;

export type SharedKeySpendAdjustmentRow = {
  id: string;
  periodStart: string;
  periodEnd: string | null;
  scope: "user" | "team";
  userId: string | null;
  userIdSnapshot: string | null;
  deltaUsd: number;
  reason: string;
  createdById: string | null;
  createdByIdSnapshot: string | null;
  createdByEmailSnapshot: string | null;
  createdByEmail: string | null;
  createdByName: string | null;
  createdAt: string;
  previousTrackedUsd: number;
  newTrackedUsd: number;
  reversesId: string | null;
};

async function currentTrackedUsd(
  tx: AdjTx,
  args: {
    periodStart: Date;
    until: Date;
    scope: "user" | "team";
    /** Live FK or snapshot id used for per-user spend lookup. */
    userKey: string | null;
  },
): Promise<number> {
  if (args.scope === "team" || args.userKey == null) {
    return trackedSharedKeyTeamSpendUsd(tx, {
      since: args.periodStart,
      until: args.until,
      periodStart: args.periodStart,
    });
  }
  const raw = await trackedSharedKeySpendUsd(tx, {
    userId: args.userKey,
    since: args.periodStart,
    until: args.until,
    periodStart: args.periodStart,
  });
  const allotment = await tx.sharedKeyWeekAllotment.findUnique({
    where: { weekStart_userId: { weekStart: args.periodStart, userId: args.userKey } },
    select: { preJoinSpendUsd: true },
  });
  return effectiveSharedKeySpendUsd(raw, allotment?.preJoinSpendUsd ?? 0);
}

function toRow(
  row: {
    id: string;
    periodStart: Date;
    periodEnd?: Date | null;
    scope: string;
    userId: string | null;
    userIdSnapshot: string | null;
    deltaUsd: number;
    reason: string;
    createdById: string | null;
    createdByIdSnapshot: string | null;
    createdByEmailSnapshot: string | null;
    createdAt: Date;
    previousTrackedUsd: number;
    newTrackedUsd: number;
    reversesId: string | null;
  },
  createdBy?: { email: string; name: string } | null,
): SharedKeySpendAdjustmentRow {
  if (row.scope !== "user" && row.scope !== "team") {
    throw new Error(`Invalid spend-adjustment scope: ${row.scope}`);
  }
  const scope = row.scope;
  return {
    id: row.id,
    periodStart: row.periodStart.toISOString(),
    periodEnd: row.periodEnd ? row.periodEnd.toISOString() : null,
    scope,
    userId: row.userId,
    userIdSnapshot: row.userIdSnapshot,
    deltaUsd: row.deltaUsd,
    reason: row.reason,
    createdById: row.createdById,
    createdByIdSnapshot: row.createdByIdSnapshot,
    createdByEmailSnapshot: row.createdByEmailSnapshot,
    createdByEmail: createdBy?.email ?? row.createdByEmailSnapshot ?? null,
    createdByName: createdBy?.name ?? null,
    createdAt: row.createdAt.toISOString(),
    previousTrackedUsd: row.previousTrackedUsd,
    newTrackedUsd: row.newTrackedUsd,
    reversesId: row.reversesId,
  };
}

async function appendAdjustment(
  tx: AdjTx,
  input: {
    periodStart: Date;
    /** End of the period under the schedule in force at write; stored on the row. */
    periodEnd: Date;
    until: Date;
    /** Live user FK; null for team-wide or after the scoped user was deleted. */
    userId: string | null;
    /**
     * Explicit scope. Defaults from userId when omitted (new adjustments).
     * Reversals pass the original scope so a null live userId never becomes team.
     */
    scope?: "user" | "team";
    /** Defaults to userId; reversals keep the original snapshot after user delete. */
    userIdSnapshot?: string | null;
    deltaUsd: number;
    reason: string;
    createdById: string;
    reversesId?: string | null;
  },
): Promise<SharedKeySpendAdjustmentRow> {
  const deltaUsd = roundUsdToCents(input.deltaUsd);
  if (!Number.isFinite(deltaUsd) || deltaUsd === 0) {
    throw new Error("Adjustment delta must be a non-zero finite number");
  }
  const reason = input.reason.trim();
  if (!reason) throw new Error("Reason is required");
  const creator = await tx.user.findUnique({
    where: { id: input.createdById },
    select: { id: true, email: true, name: true },
  });
  if (!creator) throw new Error("Creator not found");
  const scope: "user" | "team" =
    input.scope ?? (input.userId == null ? "team" : "user");
  const userIdSnapshot =
    input.userIdSnapshot !== undefined ? input.userIdSnapshot : input.userId;
  if (scope === "user" && userIdSnapshot == null) {
    throw new Error("user-scoped adjustments require a userIdSnapshot");
  }
  if (scope === "team" && userIdSnapshot != null) {
    throw new Error("team-scoped adjustments must not set userIdSnapshot");
  }
  // New per-user adjustments need a live user; reversals may keep a null FK after delete.
  if (input.userId && !input.reversesId) {
    const user = await tx.user.findUnique({
      where: { id: input.userId },
      select: { id: true },
    });
    if (!user) throw new Error("User not found");
  }
  const previousTrackedUsd = roundUsdToCents(
    await currentTrackedUsd(tx, {
      periodStart: input.periodStart,
      until: input.until,
      scope,
      userKey: userIdSnapshot,
    }),
  );
  const newTrackedUsd = roundUsdToCents(previousTrackedUsd + deltaUsd);
  if (newTrackedUsd < 0) {
    throw new Error("Tracked spend cannot go below zero");
  }
  try {
    const created = await tx.sharedKeySpendAdjustment.create({
      data: {
        periodStart: input.periodStart,
        periodEnd: input.periodEnd,
        scope,
        userId: input.userId,
        userIdSnapshot,
        deltaUsd,
        reason,
        createdById: input.createdById,
        createdByIdSnapshot: input.createdById,
        createdByEmailSnapshot: creator.email,
        previousTrackedUsd,
        newTrackedUsd,
        reversesId: input.reversesId ?? null,
      },
    });
    return toRow(created, creator);
  } catch (error) {
    if (
      input.reversesId &&
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      throw new Error("Adjustment already reversed");
    }
    throw error;
  }
}

/** Set tracked spend to an absolute value (stored as a delta from current tracked). */
export async function setSharedKeyTrackedSpend(
  prisma: AdjPrisma,
  input: {
    targetUsd: number;
    reason: string;
    createdById: string;
    userId?: string | null;
    now?: Date;
  },
): Promise<SharedKeySpendAdjustmentRow> {
  const targetUsd = roundUsdToCents(input.targetUsd);
  if (!Number.isFinite(targetUsd) || targetUsd < 0) {
    throw new Error("targetUsd must be a non-negative finite number");
  }
  const now = input.now ?? new Date();
  return prisma.$transaction(async (tx) => {
    await lockSharedKeyBudget(tx, SHARED_KEY_BUDGET_MEMBERS_LOCK);
    const settings = await tx.deploymentSettings.findUnique({
      where: { id: "default" },
      select: {
        sharedKeyPeriod: true,
        sharedKeyResetDow: true,
        sharedKeyResetDom: true,
        sharedKeyResetMinutes: true,
        sharedKeyTimezone: true,
        sharedKeyActivePeriodStart: true,
      },
    });
    const { periodStart, periodEnd } = resolveSharedKeyPeriodBounds(settings, now);
    const scope: "user" | "team" = input.userId == null ? "team" : "user";
    const previous = roundUsdToCents(
      await currentTrackedUsd(tx, {
        periodStart,
        until: now,
        scope,
        userKey: input.userId ?? null,
      }),
    );
    const deltaUsd = roundUsdToCents(targetUsd - previous);
    if (deltaUsd === 0) {
      throw new Error("Tracked spend already equals the target value");
    }
    return appendAdjustment(tx, {
      periodStart,
      periodEnd,
      until: now,
      userId: input.userId ?? null,
      scope,
      deltaUsd,
      reason: input.reason,
      createdById: input.createdById,
    });
  });
}

/** Append a signed delta to tracked spend (team-wide or per user). */
export async function adjustSharedKeyTrackedSpend(
  prisma: AdjPrisma,
  input: {
    deltaUsd: number;
    reason: string;
    createdById: string;
    userId?: string | null;
    now?: Date;
  },
): Promise<SharedKeySpendAdjustmentRow> {
  const deltaUsd = roundUsdToCents(input.deltaUsd);
  if (!Number.isFinite(deltaUsd) || deltaUsd === 0) {
    throw new Error("Adjustment delta must be a non-zero finite number");
  }
  const now = input.now ?? new Date();
  return prisma.$transaction(async (tx) => {
    await lockSharedKeyBudget(tx, SHARED_KEY_BUDGET_MEMBERS_LOCK);
    const settings = await tx.deploymentSettings.findUnique({
      where: { id: "default" },
      select: {
        sharedKeyPeriod: true,
        sharedKeyResetDow: true,
        sharedKeyResetDom: true,
        sharedKeyResetMinutes: true,
        sharedKeyTimezone: true,
        sharedKeyActivePeriodStart: true,
      },
    });
    const { periodStart, periodEnd } = resolveSharedKeyPeriodBounds(settings, now);
    return appendAdjustment(tx, {
      periodStart,
      periodEnd,
      until: now,
      userId: input.userId ?? null,
      deltaUsd,
      reason: input.reason,
      createdById: input.createdById,
    });
  });
}

/** Reverse a prior adjustment by appending an opposite delta (append-only). */
export async function reverseSharedKeySpendAdjustment(
  prisma: AdjPrisma,
  input: {
    adjustmentId: string;
    reason: string;
    createdById: string;
    now?: Date;
  },
): Promise<SharedKeySpendAdjustmentRow> {
  const now = input.now ?? new Date();
  return prisma.$transaction(async (tx) => {
    await lockSharedKeyBudget(tx, SHARED_KEY_BUDGET_MEMBERS_LOCK);
    const existing = await tx.sharedKeySpendAdjustment.findUnique({
      where: { id: input.adjustmentId },
    });
    if (!existing) throw new Error("Adjustment not found");
    if (existing.reversesId) {
      throw new Error("Cannot reverse a reversal");
    }
    const already = await tx.sharedKeySpendAdjustment.findFirst({
      where: { reversesId: existing.id },
      select: { id: true },
    });
    if (already) throw new Error("Adjustment already reversed");
    if (existing.scope !== "user" && existing.scope !== "team") {
      throw new Error(`Invalid spend-adjustment scope: ${existing.scope}`);
    }
    // Prefer the periodEnd stored when the row was written so a later schedule
    // change cannot move the original window. Fall back only for legacy rows.
    let originalPeriodEnd: Date;
    if (existing.periodEnd) {
      originalPeriodEnd = existing.periodEnd;
    } else {
      const settings = await tx.deploymentSettings.findUnique({
        where: { id: "default" },
        select: {
          sharedKeyPeriod: true,
          sharedKeyResetDow: true,
          sharedKeyResetDom: true,
          sharedKeyResetMinutes: true,
          sharedKeyTimezone: true,
          sharedKeyActivePeriodStart: true,
        },
      });
      const schedule = scheduleFromSettings(settings);
      originalPeriodEnd = sharedKeyPeriodEnd(schedule, existing.periodStart);
    }
    // Tracked before/after for a past-period reverse is measured at the end of
    // that period, not "now" (which would pull in later usage).
    const until =
      originalPeriodEnd.getTime() < now.getTime() ? originalPeriodEnd : now;
    return appendAdjustment(tx, {
      periodStart: existing.periodStart,
      periodEnd: originalPeriodEnd,
      until,
      // Keep the live FK as-is (may already be null after account delete).
      userId: existing.userId,
      scope: existing.scope,
      userIdSnapshot: existing.userIdSnapshot,
      deltaUsd: -existing.deltaUsd,
      reason: input.reason.trim() || `Reverse ${existing.id}`,
      createdById: input.createdById,
      reversesId: existing.id,
    });
  });
}

export async function listSharedKeySpendAdjustments(
  prisma: Pick<AdjPrisma, "sharedKeySpendAdjustment" | "user" | "deploymentSettings">,
  options?: { periodStart?: Date; limit?: number; now?: Date },
): Promise<SharedKeySpendAdjustmentRow[]> {
  const now = options?.now ?? new Date();
  let periodStart = options?.periodStart;
  if (!periodStart) {
    const settings = await prisma.deploymentSettings.findUnique({
      where: { id: "default" },
      select: {
        sharedKeyPeriod: true,
        sharedKeyResetDow: true,
        sharedKeyResetDom: true,
        sharedKeyResetMinutes: true,
        sharedKeyTimezone: true,
        sharedKeyActivePeriodStart: true,
      },
    });
    periodStart = resolveSharedKeyPeriodBounds(settings, now).periodStart;
  }
  const rows = await prisma.sharedKeySpendAdjustment.findMany({
    where: { periodStart },
    orderBy: { createdAt: "desc" },
    take: Math.min(Math.max(options?.limit ?? 100, 1), 500),
  });
  const creatorIds = [
    ...new Set(rows.map((row) => row.createdById).filter((id): id is string => Boolean(id))),
  ];
  const creators =
    creatorIds.length === 0
      ? []
      : await prisma.user.findMany({
          where: { id: { in: creatorIds } },
          select: { id: true, email: true, name: true },
        });
  const byId = new Map(creators.map((row) => [row.id, row]));
  return rows.map((row) =>
    toRow(row, row.createdById ? (byId.get(row.createdById) ?? null) : null),
  );
}

/** Test helper: assert the advisory lock SQL shape is used (string contains shared-key-budget). */
export function sharedKeyBudgetLockKey(key = SHARED_KEY_BUDGET_MEMBERS_LOCK): string {
  return `shared-key-budget:${key}`;
}
