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
 * Pro-rate fraction for a mid-week joiner, frozen at their join instant.
 * Cap re-bases must reuse this — never `weekFractionRemaining(now)` — or each later save
 * would shrink the same joiner's slice toward zero.
 */
export function midWeekJoinFraction(joinedAt: Date, weekStart: Date): number {
  if (joinedAt.getTime() <= weekStart.getTime()) return 1;
  return weekFractionRemaining(joinedAt, weekStart);
}

/**
 * Spend charged against a weekly allotment: Monday→now shared-key total minus the baseline
 * captured at first enrollment this week. Pre-join company spend cannot instantly exhaust a
 * pro-rated slice; remove/re-add reuses the same baseline so the pool cannot be overspent.
 */
export function effectiveSharedKeySpendUsd(mondaySpendUsd: number, preJoinSpendUsd: number): number {
  if (!(mondaySpendUsd > 0)) return 0;
  return Math.max(0, mondaySpendUsd - Math.max(0, preJoinSpendUsd));
}

export type SharedKeyBudgetMember = { userId: string; joinedAt: Date };

/**
 * Recompute each member's weekly allotment after a membership change or at week open.
 *
 * - Fresh week (no prior rows): each member gets monthlyCap/4/n, join-time pro-rated.
 * - Cap rebase: free = max(0, newPool − Σ(eff+res) over all rows); each member gets
 *   eff+res + free × share_i / Σshare. Never invents budget above the new pool.
 * - Mid-week membership change: never raise a continuing member. Joiners are funded
 *   only from headroom — first freed headroom of removed rows, then a proportional
 *   take from continuing members' headroom. Joiner slice =
 *   min(fullShare × joinFraction, totalHeadroom / n). Re-added members keep their
 *   week row, so they are capped at the prior allotment.
 * - `spentByUser` must be Monday→now totals; `preJoinSpendByUser` supplies baselines so
 *   effective spend = monday − preJoin.
 */
export function redivideWeeklyAllotments(args: {
  monthlyCapUsd: number;
  members: SharedKeyBudgetMember[];
  weekStart: Date;
  now: Date;
  previousAllotments: ReadonlyMap<string, number>;
  spentByUser: ReadonlyMap<string, number>;
  reservedByUser?: ReadonlyMap<string, number>;
  preJoinSpendByUser?: ReadonlyMap<string, number>;
  /** Admin cap edit: re-base this week on the new pool minus already-committed spend. */
  rebaseOnMonthlyCap?: boolean;
}): Map<string, number> {
  const {
    monthlyCapUsd,
    members,
    weekStart,
    previousAllotments,
    spentByUser,
    reservedByUser = new Map(),
    preJoinSpendByUser = new Map(),
    rebaseOnMonthlyCap = false,
  } = args;
  const result = new Map<string, number>();
  const n = members.length;
  if (n <= 0 || !(monthlyCapUsd > 0)) return result;

  const weekPool = monthlyCapUsd / 4;
  const fullShare = weekPool / n;

  const effective = (userId: string) =>
    effectiveSharedKeySpendUsd(spentByUser.get(userId) ?? 0, preJoinSpendByUser.get(userId) ?? 0);

  const shareOf = (member: SharedKeyBudgetMember) =>
    member.joinedAt.getTime() > weekStart.getTime()
      ? fullShare * midWeekJoinFraction(member.joinedAt, weekStart)
      : fullShare;

  // Fresh week: even full-week shares (join-time pro-rated). Spend is counted separately.
  if (previousAllotments.size === 0) {
    for (const member of members) {
      result.set(member.userId, shareOf(member));
    }
    return result;
  }

  if (rebaseOnMonthlyCap) {
    // New pool minus everything already committed (all prior rows, including removed).
    let committed = 0;
    for (const [userId] of previousAllotments) {
      committed += effective(userId) + (reservedByUser.get(userId) ?? 0);
    }
    for (const member of members) {
      if (!previousAllotments.has(member.userId)) {
        committed += effective(member.userId) + (reservedByUser.get(member.userId) ?? 0);
      }
    }
    const free = Math.max(0, weekPool - committed);
    // Members already at/over their new share stay at spent+reserved; remaining free
    // is split among the others by share weight so overspent rows are never raised.
    const floors = members.map((member) => {
      const spent = effective(member.userId);
      const reserved = reservedByUser.get(member.userId) ?? 0;
      return { member, spent, reserved, floor: spent + reserved, want: shareOf(member) };
    });
    const overspent = floors.filter((row) => row.floor >= row.want);
    const receivers = floors.filter((row) => row.floor < row.want);
    for (const row of overspent) {
      result.set(row.member.userId, row.floor);
    }
    const wantSum = receivers.reduce((sum, row) => sum + row.want, 0);
    if (wantSum > 0 && free > 0) {
      for (const row of receivers) {
        result.set(row.member.userId, row.floor + (free * row.want) / wantSum);
      }
    } else {
      for (const row of receivers) {
        result.set(row.member.userId, row.floor);
      }
    }
    return result;
  }

  // Never raise a continuing member; joiners are funded only from existing headroom.
  const headroom = new Map<string, number>();
  let freed = 0;
  for (const [userId, allotment] of previousAllotments) {
    const head = Math.max(0, allotment - effective(userId) - (reservedByUser.get(userId) ?? 0));
    if (members.some((member) => member.userId === userId)) headroom.set(userId, head);
    else freed += head;
  }

  const joiners = members.filter((member) => !previousAllotments.has(member.userId));
  const totalHeadroom = [...headroom.values()].reduce((sum, value) => sum + value, 0) + freed;
  let taken = 0;
  for (const joiner of joiners) {
    const slice = Math.min(shareOf(joiner), totalHeadroom / n);
    result.set(joiner.userId, slice);
    taken += slice;
  }

  const fromContinuing = Math.max(0, taken - freed);
  const continuingHeadroom = [...headroom.values()].reduce((sum, value) => sum + value, 0);
  for (const [userId, head] of headroom) {
    const take = continuingHeadroom > 0 ? (fromContinuing * head) / continuingHeadroom : 0;
    const prev = previousAllotments.get(userId) ?? 0;
    const spent = effective(userId);
    const reserved = reservedByUser.get(userId) ?? 0;
    // Cap at prior allotment so remove→re-add cannot grow, and drained members stay drained.
    result.set(userId, Math.min(prev, spent + reserved + head - take));
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
