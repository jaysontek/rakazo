/**
 * Append-only tracked-spend adjustments for the shared company key.
 * Every mutation takes the shared-key budget advisory lock; there is no update/delete.
 */
import { effectiveSharedKeySpendUsd } from "@rakazo/core";
import type { PrismaClient } from "./client.js";
import { Prisma } from "./client.js";
import {
  lockSharedKeyBudget,
  resolveSharedKeyPeriodBounds,
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
  userId: string | null;
  deltaUsd: number;
  reason: string;
  createdById: string | null;
  createdByEmail: string | null;
  createdByName: string | null;
  createdAt: string;
  previousTrackedUsd: number;
  newTrackedUsd: number;
  reversesId: string | null;
};

async function currentTrackedUsd(
  tx: AdjTx,
  args: { periodStart: Date; until: Date; userId: string | null },
): Promise<number> {
  if (args.userId == null) {
    return trackedSharedKeyTeamSpendUsd(tx, {
      since: args.periodStart,
      until: args.until,
      periodStart: args.periodStart,
    });
  }
  const raw = await trackedSharedKeySpendUsd(tx, {
    userId: args.userId,
    since: args.periodStart,
    until: args.until,
    periodStart: args.periodStart,
  });
  const allotment = await tx.sharedKeyWeekAllotment.findUnique({
    where: { weekStart_userId: { weekStart: args.periodStart, userId: args.userId } },
    select: { preJoinSpendUsd: true },
  });
  return effectiveSharedKeySpendUsd(raw, allotment?.preJoinSpendUsd ?? 0);
}

function toRow(
  row: {
    id: string;
    periodStart: Date;
    userId: string | null;
    deltaUsd: number;
    reason: string;
    createdById: string | null;
    createdAt: Date;
    previousTrackedUsd: number;
    newTrackedUsd: number;
    reversesId: string | null;
  },
  createdBy?: { email: string; name: string } | null,
): SharedKeySpendAdjustmentRow {
  return {
    id: row.id,
    periodStart: row.periodStart.toISOString(),
    userId: row.userId,
    deltaUsd: row.deltaUsd,
    reason: row.reason,
    createdById: row.createdById,
    createdByEmail: createdBy?.email ?? null,
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
    until: Date;
    userId: string | null;
    deltaUsd: number;
    reason: string;
    createdById: string;
    reversesId?: string | null;
  },
): Promise<SharedKeySpendAdjustmentRow> {
  if (!Number.isFinite(input.deltaUsd) || input.deltaUsd === 0) {
    throw new Error("Adjustment delta must be a non-zero finite number");
  }
  const reason = input.reason.trim();
  if (!reason) throw new Error("Reason is required");
  if (input.userId) {
    const user = await tx.user.findUnique({
      where: { id: input.userId },
      select: { id: true },
    });
    if (!user) throw new Error("User not found");
  }
  const previousTrackedUsd = await currentTrackedUsd(tx, {
    periodStart: input.periodStart,
    until: input.until,
    userId: input.userId,
  });
  const newTrackedUsd = previousTrackedUsd + input.deltaUsd;
  const created = await tx.sharedKeySpendAdjustment.create({
    data: {
      periodStart: input.periodStart,
      userId: input.userId,
      deltaUsd: input.deltaUsd,
      reason,
      createdById: input.createdById,
      previousTrackedUsd,
      newTrackedUsd,
      reversesId: input.reversesId ?? null,
    },
  });
  const createdBy = await tx.user.findUnique({
    where: { id: input.createdById },
    select: { email: true, name: true },
  });
  return toRow(created, createdBy);
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
  if (!Number.isFinite(input.targetUsd)) {
    throw new Error("targetUsd must be a finite number");
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
    const { periodStart } = resolveSharedKeyPeriodBounds(settings, now);
    const previous = await currentTrackedUsd(tx, {
      periodStart,
      until: now,
      userId: input.userId ?? null,
    });
    const deltaUsd = input.targetUsd - previous;
    if (deltaUsd === 0) {
      throw new Error("Tracked spend already equals the target value");
    }
    return appendAdjustment(tx, {
      periodStart,
      until: now,
      userId: input.userId ?? null,
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
    const { periodStart } = resolveSharedKeyPeriodBounds(settings, now);
    return appendAdjustment(tx, {
      periodStart,
      until: now,
      userId: input.userId ?? null,
      deltaUsd: input.deltaUsd,
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
    const already = await tx.sharedKeySpendAdjustment.findFirst({
      where: { reversesId: existing.id },
      select: { id: true },
    });
    if (already) throw new Error("Adjustment already reversed");
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
    const { periodStart } = resolveSharedKeyPeriodBounds(settings, now);
    return appendAdjustment(tx, {
      periodStart,
      until: now,
      userId: existing.userId,
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
