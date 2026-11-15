import { wallClock, zonedDateTime } from "./cron.js";

/** Weekly shared-key budgets reset at Monday 00:00 in this zone. */
export const SHARED_KEY_BUDGET_TIMEZONE = "America/New_York";

export type SharedKeyPeriodKind = "week" | "month";

export type SharedKeyPeriodSchedule = {
  period: SharedKeyPeriodKind;
  /** 0=Sunday .. 6=Saturday; default Monday=1 */
  resetDow: number;
  /** 1-28; default 1 */
  resetDom: number;
  /** minutes after local midnight 0..1439; default 0 */
  resetMinutes: number;
  /** IANA timezone name */
  timezone: string;
};

export const DEFAULT_SHARED_KEY_PERIOD_SCHEDULE: SharedKeyPeriodSchedule = {
  period: "week",
  resetDow: 1,
  resetDom: 1,
  resetMinutes: 0,
  timezone: SHARED_KEY_BUDGET_TIMEZONE,
};

/** Validate IANA timezone; return null if invalid. */
export function parseSharedKeyTimezone(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const timezone = raw.trim();
  if (!timezone) return null;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format();
    return timezone;
  } catch {
    return null;
  }
}

/** Normalize partial/nullable DB fields into a schedule; null fields use defaults so null schedule === today's behavior. */
export function resolveSharedKeyPeriodSchedule(
  input?: Partial<SharedKeyPeriodSchedule> | null,
): SharedKeyPeriodSchedule {
  const defaults = DEFAULT_SHARED_KEY_PERIOD_SCHEDULE;
  if (input == null) return { ...defaults };

  const period =
    input.period === "week" || input.period === "month" ? input.period : defaults.period;
  const resetDow =
    typeof input.resetDow === "number" &&
    Number.isInteger(input.resetDow) &&
    input.resetDow >= 0 &&
    input.resetDow <= 6
      ? input.resetDow
      : defaults.resetDow;
  const resetDom =
    typeof input.resetDom === "number" &&
    Number.isInteger(input.resetDom) &&
    input.resetDom >= 1 &&
    input.resetDom <= 28
      ? input.resetDom
      : defaults.resetDom;
  const resetMinutes =
    typeof input.resetMinutes === "number" &&
    Number.isInteger(input.resetMinutes) &&
    input.resetMinutes >= 0 &&
    input.resetMinutes <= 1439
      ? input.resetMinutes
      : defaults.resetMinutes;
  const timezone = parseSharedKeyTimezone(input.timezone) ?? defaults.timezone;

  return { period, resetDow, resetDom, resetMinutes, timezone };
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

function resetClockParts(resetMinutes: number): { hour: number; minute: number } {
  const clamped = Math.min(1439, Math.max(0, Math.trunc(resetMinutes)));
  return { hour: Math.floor(clamped / 60), minute: clamped % 60 };
}

function localWallParts(
  now: Date,
  timezone: string,
): { year: number; month: number; day: number; localMinutes: number } {
  const clock = wallClock(now, timezone);
  const [datePart, timePart = "00:00:00"] = clock.split("T");
  const [year, month, day] = datePart!.split("-").map(Number) as [number, number, number];
  const [hour, minute] = timePart.split(":").map(Number) as [number, number];
  return { year, month, day, localMinutes: hour * 60 + minute };
}

function instantAtLocal(
  year: number,
  month: number,
  day: number,
  resetMinutes: number,
  timezone: string,
): Date {
  const { hour, minute } = resetClockParts(resetMinutes);
  const iso = `${year}-${pad2(month)}-${pad2(day)}T${pad2(hour)}:${pad2(minute)}`;
  return zonedDateTime(iso, timezone) ?? new Date(Date.UTC(year, month - 1, day, hour, minute));
}

/** Period start containing `now` for the given schedule (DST-safe via wallClock/zonedDateTime). */
export function sharedKeyPeriodStart(schedule: SharedKeyPeriodSchedule, now = new Date()): Date {
  const { year, month, day, localMinutes } = localWallParts(now, schedule.timezone);

  if (schedule.period === "month") {
    const resetDom = Math.min(28, Math.max(1, Math.trunc(schedule.resetDom) || 1));
    let y = year;
    let m = month;
    const beforeReset =
      day < resetDom || (day === resetDom && localMinutes < schedule.resetMinutes);
    if (beforeReset) {
      m -= 1;
      if (m < 1) {
        m = 12;
        y -= 1;
      }
    }
    return instantAtLocal(y, m, resetDom, schedule.resetMinutes, schedule.timezone);
  }

  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  const resetDow = ((Math.trunc(schedule.resetDow) % 7) + 7) % 7;
  let daysBack = (weekday - resetDow + 7) % 7;
  if (daysBack === 0 && localMinutes < schedule.resetMinutes) daysBack = 7;
  const start = new Date(Date.UTC(year, month - 1, day - daysBack));
  return instantAtLocal(
    start.getUTCFullYear(),
    start.getUTCMonth() + 1,
    start.getUTCDate(),
    schedule.resetMinutes,
    schedule.timezone,
  );
}

/** Next period start after `periodStart` (DST-safe). */
export function sharedKeyPeriodEnd(schedule: SharedKeyPeriodSchedule, periodStart: Date): Date {
  if (schedule.period === "month") {
    const { year, month } = localWallParts(periodStart, schedule.timezone);
    const resetDom = Math.min(28, Math.max(1, Math.trunc(schedule.resetDom) || 1));
    let nextYear = year;
    let nextMonth = month + 1;
    if (nextMonth > 12) {
      nextMonth = 1;
      nextYear += 1;
    }
    return instantAtLocal(
      nextYear,
      nextMonth,
      resetDom,
      schedule.resetMinutes,
      schedule.timezone,
    );
  }

  const nextWeekInstant = new Date(periodStart.getTime() + 8 * 24 * 60 * 60 * 1000);
  return sharedKeyPeriodStart(schedule, nextWeekInstant);
}

/**
 * Effective period start: if activePeriodStart is set and now < periodEnd(activePeriodStart),
 * keep activePeriodStart (schedule change takes effect at next boundary). Otherwise compute from schedule.
 */
export function effectiveSharedKeyPeriodStart(args: {
  schedule: SharedKeyPeriodSchedule;
  activePeriodStart?: Date | null;
  now?: Date;
}): Date {
  const now = args.now ?? new Date();
  if (args.activePeriodStart) {
    const end = sharedKeyPeriodEnd(args.schedule, args.activePeriodStart);
    if (now.getTime() < end.getTime()) return args.activePeriodStart;
  }
  return sharedKeyPeriodStart(args.schedule, now);
}

/** Monday 00:00 America/New_York for the week that contains `now`. */
export function sharedKeyWeekStart(now = new Date()): Date {
  return sharedKeyPeriodStart(DEFAULT_SHARED_KEY_PERIOD_SCHEDULE, now);
}

/** Next Monday 00:00 America/New_York after `weekStart` (DST-safe week length). */
export function sharedKeyWeekEnd(weekStart: Date): Date {
  return sharedKeyPeriodEnd(DEFAULT_SHARED_KEY_PERIOD_SCHEDULE, weekStart);
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
 * Account-menu reset label, e.g. "Mon 12:00 AM", in the given timezone (default America/New_York).
 */
export function formatSharedKeyBudgetResetAt(
  resetsAt: Date | string,
  locale = "en-US",
  timezone = SHARED_KEY_BUDGET_TIMEZONE,
): string {
  const date = typeof resetsAt === "string" ? new Date(resetsAt) : resetsAt;
  const zone = parseSharedKeyTimezone(timezone) ?? SHARED_KEY_BUDGET_TIMEZONE;
  const weekday = new Intl.DateTimeFormat(locale, {
    timeZone: zone,
    weekday: "short",
  }).format(date);
  const time = new Intl.DateTimeFormat(locale, {
    timeZone: zone,
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
