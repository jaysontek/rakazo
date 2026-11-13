import { spendingPeriodStart } from "./spending.js";

/** Weekly shared-key budgets reset at Monday 00:00 in this zone. */
export const SHARED_KEY_BUDGET_TIMEZONE = "America/New_York";

/** Monday 00:00 America/New_York for the week that contains `now`. */
export function sharedKeyWeekStart(now = new Date()): Date {
  return spendingPeriodStart("week", now, SHARED_KEY_BUDGET_TIMEZONE, now);
}

/** Next Monday 00:00 America/New_York after `weekStart` (DST-safe week length). */
export function sharedKeyWeekEnd(weekStart: Date): Date {
  const nextWeekInstant = new Date(weekStart.getTime() + 8 * 24 * 60 * 60 * 1000);
  return sharedKeyWeekStart(nextWeekInstant);
}

/**
 * One user's full-week share of a monthly shared-key spend cap: monthly / users / 4 weeks.
 * Zero when there are no members or the cap is not positive.
 */
export function fullWeekShareUsd(monthlyCapUsd: number, memberCount: number): number {
  if (!(monthlyCapUsd > 0) || memberCount <= 0) return 0;
  return monthlyCapUsd / memberCount / 4;
}

/** Fraction of the week still left at `now` (1 at the start, 0 at or after the end). */
export function weekFractionRemaining(now: Date, weekStart: Date): number {
  const end = sharedKeyWeekEnd(weekStart).getTime();
  const start = weekStart.getTime();
  const total = end - start;
  if (total <= 0) return 0;
  return Math.min(1, Math.max(0, (end - now.getTime()) / total));
}

/**
 * Lower bound for shared-key spend counted against a member's weekly allotment.
 * Mid-week joiners are only charged for usage at/after `joinedAt`, so pre-join company-key
 * spend (from before they were enrolled) cannot instantly exhaust a pro-rated slice.
 */
export function sharedKeySpendWindowStart(weekStart: Date, joinedAt: Date): Date {
  return joinedAt.getTime() > weekStart.getTime() ? joinedAt : weekStart;
}

/**
 * Pro-rate fraction for a mid-week joiner, frozen at their join instant.
 * Cap re-bases and later membership syncs must reuse this — never `weekFractionRemaining(now)` —
 * or each later save would shrink the same joiner's slice toward zero.
 */
export function midWeekJoinFraction(joinedAt: Date, weekStart: Date): number {
  if (joinedAt.getTime() <= weekStart.getTime()) return 1;
  return weekFractionRemaining(joinedAt, weekStart);
}

export type SharedKeyBudgetMember = { userId: string; joinedAt: Date };

/**
 * Recompute each member's weekly allotment after a membership change or at week open.
 *
 * - The week's pool starts as monthlyCap/4, or as the sum of unspent *and unreserved* prior
 *   allotments when redistributing mid-week (including unused remainder from removed users).
 * - That remaining pool is split evenly across the current member set.
 * - A member who joined after this week's start and has no prior allotment is capped at
 *   (full-week share) × (fraction of week remaining at join time), not a full share and not
 *   the fraction remaining at the current recompute instant.
 * - Continuing members keep spent + reserved committed; their new allotment is
 *   spent + reserved + evenRemaining so in-flight holds are not redistributed.
 * - When `rebaseOnMonthlyCap` is set (admin changed the monthly cap), ignore prior
 *   allotment rows and assign monthlyCap/4/n afresh so raising the cap unblocks this week
 *   and lowering it tightens it. Mid-week joiners stay pro-rated by join time (not save time).
 *   reservedUsd is preserved by the caller on the allotment row.
 * - Callers must pass `spentByUser` as spend inside each member's
 *   {@link sharedKeySpendWindowStart} window so mid-week join allotments stay pool-conserving.
 */
export function redivideWeeklyAllotments(args: {
  monthlyCapUsd: number;
  members: SharedKeyBudgetMember[];
  weekStart: Date;
  now: Date;
  previousAllotments: ReadonlyMap<string, number>;
  spentByUser: ReadonlyMap<string, number>;
  reservedByUser?: ReadonlyMap<string, number>;
  /** Admin cap edit: re-base this week on monthlyCap/4/n instead of redistributing the old pool. */
  rebaseOnMonthlyCap?: boolean;
}): Map<string, number> {
  const {
    monthlyCapUsd,
    members,
    weekStart,
    previousAllotments,
    spentByUser,
    reservedByUser = new Map(),
    rebaseOnMonthlyCap = false,
  } = args;
  const result = new Map<string, number>();
  const n = members.length;
  if (n <= 0 || !(monthlyCapUsd > 0)) return result;

  const weekPool = monthlyCapUsd / 4;
  const fullShare = weekPool / n;

  // Fresh week (no prior allotments) or admin rebased the monthly cap: each member gets an
  // even full-week share of the (new) cap. Spend and reserved are counted separately against
  // that allotment — do not fold them into the allotment.
  if (previousAllotments.size === 0 || rebaseOnMonthlyCap) {
    for (const member of members) {
      const midWeekJoin = member.joinedAt.getTime() > weekStart.getTime();
      result.set(
        member.userId,
        midWeekJoin ? fullShare * midWeekJoinFraction(member.joinedAt, weekStart) : fullShare,
      );
    }
    return result;
  }

  let remainingPool = 0;
  for (const [userId, allotment] of previousAllotments) {
    const spent = spentByUser.get(userId) ?? 0;
    const reserved = reservedByUser.get(userId) ?? 0;
    remainingPool += Math.max(0, allotment - spent - reserved);
  }

  const evenRemaining = remainingPool / n;
  let surplus = 0;
  const continuing: string[] = [];

  for (const member of members) {
    const spent = spentByUser.get(member.userId) ?? 0;
    const reserved = reservedByUser.get(member.userId) ?? 0;
    const midWeekJoin =
      member.joinedAt.getTime() > weekStart.getTime() && !previousAllotments.has(member.userId);
    if (midWeekJoin) {
      const proportional = fullShare * midWeekJoinFraction(member.joinedAt, weekStart);
      const slice = Math.min(evenRemaining, proportional);
      surplus += evenRemaining - slice;
      result.set(member.userId, slice);
    } else {
      continuing.push(member.userId);
      // Keep spent and in-flight reserved; remaining budget becomes an even slice of the pool.
      result.set(member.userId, spent + reserved + evenRemaining);
    }
  }

  if (surplus > 0 && continuing.length > 0) {
    const extra = surplus / continuing.length;
    for (const userId of continuing) {
      result.set(userId, (result.get(userId) ?? 0) + extra);
    }
  }

  return result;
}

/** Percent of a weekly allotment already spent, clamped to 0..100. */
export function sharedKeyBudgetPercentUsed(spentUsd: number, allotmentUsd: number): number {
  if (!(allotmentUsd > 0)) return spentUsd > 0 ? 100 : 0;
  return Math.min(100, Math.max(0, (spentUsd / allotmentUsd) * 100));
}

/** Upper bound for the admin-editable monthly shared-key cap (USD). */
export const SHARED_KEY_MONTHLY_BUDGET_MAX_USD = 1_000_000;

/**
 * Account-menu reset label, e.g. "Mon 12:00 AM", always in America/New_York.
 */
export function formatSharedKeyBudgetResetAt(resetsAt: Date | string, locale = "en-US"): string {
  const date = typeof resetsAt === "string" ? new Date(resetsAt) : resetsAt;
  const weekday = new Intl.DateTimeFormat(locale, {
    timeZone: SHARED_KEY_BUDGET_TIMEZONE,
    weekday: "short",
  }).format(date);
  const time = new Intl.DateTimeFormat(locale, {
    timeZone: SHARED_KEY_BUDGET_TIMEZONE,
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(date);
  return `${weekday} ${time}`;
}

/** Parse SHARED_KEY_MONTHLY_BUDGET_USD; null when unset or not a positive number. */
export function parseSharedKeyMonthlyBudgetUsd(raw: string | undefined): number | null {
  if (raw == null || raw.trim() === "") return null;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : null;
}

/** Validate an admin-entered monthly cap: positive and within the sane upper bound. */
export function parseSharedKeyMonthlyBudgetInput(value: unknown): number | null {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isFinite(n) || n <= 0 || n > SHARED_KEY_MONTHLY_BUDGET_MAX_USD) return null;
  return n;
}

/** Parse SHARED_KEY_BUDGET_USER_IDS as a comma-separated list of user ids. */
export function parseSharedKeyBudgetUserIds(raw: string | undefined): string[] {
  if (!raw?.trim()) return [];
  return [
    ...new Set(
      raw
        .split(",")
        .map((part) => part.trim())
        .filter(Boolean),
    ),
  ];
}
