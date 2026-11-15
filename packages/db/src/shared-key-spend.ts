/**
 * Single source for tracked shared-key spend: usage_records with sharedKey=true
 * plus append-only shared_key_spend_adjustments. Personal-key rows (sharedKey=false)
 * are never included.
 *
 * Spend math for adjustments always uses the explicit `scope` column (and
 * userIdSnapshot for user rows) so a null live userId can never be reinterpreted
 * as team-wide.
 */

/**
 * Loose client surface: accepts Prisma delegates and unit-test stubs.
 * Prisma's overloaded aggregate/groupBy return types do not narrow cleanly.
 */
export type SharedKeySpendClient = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  usageRecord: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sharedKeySpendAdjustment?: any;
};

type UsageClient = SharedKeySpendClient;

export type SharedKeySpendWindow = {
  /** Inclusive lower bound. Omit for lifetime. */
  since?: Date;
  /** Exclusive upper bound. */
  until: Date;
};

export type SharedKeyAdjustmentWindow = {
  periodStart: Date;
  /** When set, only adjustments with createdAt < this instant (pre-join baseline). */
  createdBefore?: Date;
  /** When set, only adjustments with createdAt >= this instant. */
  createdSince?: Date;
};

/**
 * Sum shared-key usage cost (sharedKey=true only). Personal-key rows never count.
 */
export async function sumSharedKeyUsageUsd(
  prisma: UsageClient,
  args: SharedKeySpendWindow & { userId?: string; userIds?: string[] },
): Promise<number> {
  const userFilter = usageUserFilter(args);
  const { _sum } = await prisma.usageRecord.aggregate({
    _sum: { costUsd: true },
    where: {
      sharedKey: true,
      ...userFilter,
      ...(args.since || args.until
        ? {
            createdAt: {
              ...(args.since ? { gte: args.since } : {}),
              lt: args.until,
            },
          }
        : {}),
    },
  });
  return _sum.costUsd ?? 0;
}

/**
 * Per-user shared-key usage for a window. Missing users are omitted (not zero-filled).
 * Always filters sharedKey=true.
 */
export async function sumSharedKeyUsageByUser(
  prisma: UsageClient,
  args: SharedKeySpendWindow & { userIds: string[] },
): Promise<Map<string, number>> {
  const spent = new Map<string, number>();
  if (args.userIds.length === 0) return spent;
  const groups = await prisma.usageRecord.groupBy({
    by: ["userId"],
    where: {
      userId: { in: args.userIds },
      sharedKey: true,
      createdAt: {
        ...(args.since ? { gte: args.since } : {}),
        lt: args.until,
      },
    },
    _sum: { costUsd: true },
  });
  for (const group of groups) {
    spent.set(group.userId, group._sum.costUsd ?? 0);
  }
  return spent;
}

function adjustmentCreatedAtFilter(args: SharedKeyAdjustmentWindow):
  | { createdAt?: { gte?: Date; lt?: Date } }
  | Record<string, never> {
  if (!args.createdBefore && !args.createdSince) return {};
  return {
    createdAt: {
      ...(args.createdSince ? { gte: args.createdSince } : {}),
      ...(args.createdBefore ? { lt: args.createdBefore } : {}),
    },
  };
}

/**
 * Sum of spend adjustments for a period.
 * Team-wide: scope=team. Per-user: scope=user matched by userIdSnapshot (fallback userId).
 */
export async function sumSharedKeyAdjustmentsUsd(
  prisma: UsageClient,
  args: SharedKeyAdjustmentWindow & {
    userId?: string | null;
    userIds?: string[];
  },
): Promise<number> {
  if (!prisma.sharedKeySpendAdjustment) return 0;
  const where = adjustmentWhere(args);
  const { _sum } = await prisma.sharedKeySpendAdjustment.aggregate({
    _sum: { deltaUsd: true },
    where,
  });
  return _sum.deltaUsd ?? 0;
}

/**
 * Per-user adjustment totals for a period (excludes team-wide scope=team rows).
 * Groups by userIdSnapshot so a null live userId still counts under the snapshot.
 */
export async function sumSharedKeyAdjustmentsByUser(
  prisma: UsageClient,
  args: SharedKeyAdjustmentWindow & { userIds: string[] },
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (!prisma.sharedKeySpendAdjustment || args.userIds.length === 0) return out;
  const groups = await prisma.sharedKeySpendAdjustment.groupBy({
    by: ["userIdSnapshot"],
    where: {
      periodStart: args.periodStart,
      scope: "user",
      userIdSnapshot: { in: args.userIds },
      ...adjustmentCreatedAtFilter(args),
    },
    _sum: { deltaUsd: true },
  });
  for (const group of groups) {
    if (group.userIdSnapshot == null) continue;
    out.set(group.userIdSnapshot, group._sum.deltaUsd ?? 0);
  }
  return out;
}

/**
 * Tracked spend for one user in a window: shared-key usage + that user's period adjustments.
 * Personal-key usage never counts. Team-wide adjustments are excluded from per-user totals.
 */
export async function trackedSharedKeySpendUsd(
  prisma: UsageClient,
  args: SharedKeySpendWindow & {
    userId: string;
    /** When set, include this period's per-user adjustments. */
    periodStart?: Date;
    /** Limit included adjustments to createdAt < this (pre-join baseline). */
    adjustmentCreatedBefore?: Date;
  },
): Promise<number> {
  const usage = await sumSharedKeyUsageUsd(prisma, {
    userId: args.userId,
    since: args.since,
    until: args.until,
  });
  if (!args.periodStart) return usage;
  const adjustments = await sumSharedKeyAdjustmentsUsd(prisma, {
    periodStart: args.periodStart,
    userId: args.userId,
    createdBefore: args.adjustmentCreatedBefore,
  });
  return usage + adjustments;
}

/**
 * Tracked spend per user: usage + per-user adjustments. Team-wide adjustments excluded.
 */
export async function trackedSharedKeySpendByUser(
  prisma: UsageClient,
  args: SharedKeySpendWindow & {
    userIds: string[];
    periodStart?: Date;
  },
): Promise<Map<string, number>> {
  const usage = await sumSharedKeyUsageByUser(prisma, {
    userIds: args.userIds,
    since: args.since,
    until: args.until,
  });
  if (!args.periodStart) return usage;
  const adjustments = await sumSharedKeyAdjustmentsByUser(prisma, {
    periodStart: args.periodStart,
    userIds: args.userIds,
  });
  const out = new Map<string, number>();
  for (const userId of args.userIds) {
    const total = (usage.get(userId) ?? 0) + (adjustments.get(userId) ?? 0);
    if (total !== 0 || usage.has(userId) || adjustments.has(userId)) {
      out.set(userId, total);
    }
  }
  return out;
}

/**
 * Team tracked spend for ops totals: all shared-key usage in the window plus
 * team-wide adjustments for the period (scope=team) and optionally per-user ones.
 */
export async function trackedSharedKeyTeamSpendUsd(
  prisma: UsageClient,
  args: SharedKeySpendWindow & {
    periodStart?: Date;
    /** Limit usage to these users (e.g. visible roster). Omit for all users. */
    userIds?: string[];
    /** Include per-user adjustments as well as team-wide. Default true when periodStart set. */
    includeUserAdjustments?: boolean;
  },
): Promise<number> {
  const usage = await sumSharedKeyUsageUsd(prisma, {
    userIds: args.userIds,
    since: args.since,
    until: args.until,
  });
  if (!args.periodStart || !prisma.sharedKeySpendAdjustment) return usage;
  const includeUsers = args.includeUserAdjustments !== false;
  const { _sum } = await prisma.sharedKeySpendAdjustment.aggregate({
    _sum: { deltaUsd: true },
    where: {
      periodStart: args.periodStart,
      ...(includeUsers
        ? args.userIds
          ? {
              OR: [
                { scope: "team" },
                { scope: "user", userIdSnapshot: { in: args.userIds } },
              ],
            }
          : {}
        : { scope: "team" }),
    },
  });
  return usage + (_sum.deltaUsd ?? 0);
}

function usageUserFilter(args: { userId?: string; userIds?: string[] }): {
  userId?: string | { in: string[] };
} {
  if (args.userId) return { userId: args.userId };
  if (args.userIds) return { userId: { in: args.userIds } };
  return {};
}

function adjustmentWhere(args: SharedKeyAdjustmentWindow & {
  userId?: string | null;
  userIds?: string[];
}): Record<string, unknown> {
  const created = adjustmentCreatedAtFilter(args);
  if (args.userId === null) {
    return { periodStart: args.periodStart, scope: "team", ...created };
  }
  if (typeof args.userId === "string") {
    return {
      periodStart: args.periodStart,
      scope: "user",
      OR: [{ userIdSnapshot: args.userId }, { userId: args.userId }],
      ...created,
    };
  }
  if (args.userIds) {
    return {
      periodStart: args.periodStart,
      scope: "user",
      userIdSnapshot: { in: args.userIds },
      ...created,
    };
  }
  return { periodStart: args.periodStart, ...created };
}
