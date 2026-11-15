import { wallClock, zonedDateTime } from "./cron.js";

/** Weekly shared-key budgets reset at Monday 00:00 in this zone. */
export const SHARED_KEY_BUDGET_TIMEZONE = "America/New_York";

export type SharedKeyPeriodKind = "week" | "month";

export type SharedKeyPeriodSchedule = {
  period: SharedKeyPeriodKind;
  /** 0=Sunday .. 6=Saturday; default Monday=1 */
  resetDow: number;
  /** 1-31; clamped to the month's length when resolving boundaries (29–31 → last day). */
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
    input.resetDom <= 31
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

/** Days in a calendar month (1–12). */
export function daysInCalendarMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** Clamp resetDom (1–31) to the last day of the given calendar month. */
export function clampResetDom(year: number, month: number, resetDom: number): number {
  const wanted = Math.min(31, Math.max(1, Math.trunc(resetDom) || 1));
  return Math.min(wanted, daysInCalendarMonth(year, month));
}

/** Period start containing `now` for the given schedule (DST-safe via wallClock/zonedDateTime). */
export function sharedKeyPeriodStart(schedule: SharedKeyPeriodSchedule, now = new Date()): Date {
  const { year, month, day, localMinutes } = localWallParts(now, schedule.timezone);

  if (schedule.period === "month") {
    const resetDomWanted = Math.min(31, Math.max(1, Math.trunc(schedule.resetDom) || 1));
    const thisMonthDom = clampResetDom(year, month, resetDomWanted);
    const beforeReset =
      day < thisMonthDom || (day === thisMonthDom && localMinutes < schedule.resetMinutes);
    let y = year;
    let m = month;
    if (beforeReset) {
      m -= 1;
      if (m < 1) {
        m = 12;
        y -= 1;
      }
    }
    const resetDom = clampResetDom(y, m, resetDomWanted);
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
    const resetDomWanted = Math.min(31, Math.max(1, Math.trunc(schedule.resetDom) || 1));
    let nextYear = year;
    let nextMonth = month + 1;
    if (nextMonth > 12) {
      nextMonth = 1;
      nextYear += 1;
    }
    const resetDom = clampResetDom(nextYear, nextMonth, resetDomWanted);
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
 * Period pool from a monthly cap: full month for month periods, monthly/4 for weeks.
 */
export function sharedKeyPeriodPoolUsd(
  monthlyCapUsd: number,
  period: SharedKeyPeriodKind = "week",
): number {
  if (!(monthlyCapUsd > 0)) return 0;
  return period === "month" ? monthlyCapUsd : monthlyCapUsd / 4;
}

/**
 * One user's full-period share of a monthly shared-key spend cap.
 * Week periods: monthly / users / 4. Month periods: monthly / users.
 * Zero when there are no members or the cap is not positive.
 */
export function fullWeekShareUsd(
  monthlyCapUsd: number,
  memberCount: number,
  period: SharedKeyPeriodKind = "week",
): number {
  if (!(monthlyCapUsd > 0) || memberCount <= 0) return 0;
  return sharedKeyPeriodPoolUsd(monthlyCapUsd, period) / memberCount;
}

/** Round USD to cents (half-up via Math.round). */
export function roundUsdToCents(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Fraction of the period still left at `now` (1 at the start, 0 at or after the end). */
export function periodFractionRemaining(now: Date, periodStart: Date, periodEnd: Date): number {
  const total = periodEnd.getTime() - periodStart.getTime();
  if (total <= 0) return 0;
  return Math.min(1, Math.max(0, (periodEnd.getTime() - now.getTime()) / total));
}

/** Fraction of the week still left at `now` (1 at the start, 0 at or after the end). */
export function weekFractionRemaining(now: Date, weekStart: Date): number {
  return periodFractionRemaining(now, weekStart, sharedKeyWeekEnd(weekStart));
}

/**
 * Pro-rate fraction for a mid-period joiner, frozen at their join instant.
 * Cap re-bases must reuse this — never `periodFractionRemaining(now)` — or each later save
 * would shrink the same joiner's slice toward zero.
 */
export function midPeriodJoinFraction(
  joinedAt: Date,
  periodStart: Date,
  periodEnd: Date,
): number {
  if (joinedAt.getTime() <= periodStart.getTime()) return 1;
  return periodFractionRemaining(joinedAt, periodStart, periodEnd);
}

/**
 * Pro-rate fraction for a mid-week joiner, frozen at their join instant.
 * Cap re-bases must reuse this — never `weekFractionRemaining(now)` — or each later save
 * would shrink the same joiner's slice toward zero.
 */
export function midWeekJoinFraction(joinedAt: Date, weekStart: Date): number {
  return midPeriodJoinFraction(joinedAt, weekStart, sharedKeyWeekEnd(weekStart));
}

/**
 * Spend charged against a weekly allotment: Monday→now shared-key total minus the baseline
 * captured at first enrollment this week. Pre-join company spend cannot instantly exhaust a
 * pro-rated slice; remove/re-add reuses the same baseline so the pool cannot be overspent.
 *
 * Pre-join baselines may be negative (a pre-join credit adjustment). Do not clamp the
 * baseline to 0 — that would leave the credit inside mondaySpend and over-charge the member.
 */
export function effectiveSharedKeySpendUsd(mondaySpendUsd: number, preJoinSpendUsd: number): number {
  if (!Number.isFinite(mondaySpendUsd) || !Number.isFinite(preJoinSpendUsd)) return 0;
  return Math.max(0, mondaySpendUsd - preJoinSpendUsd);
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
  /**
   * Absolute allotment overrides. Subtracted from the period pool before the
   * remainder is split among non-overridden members. Override holders get their
   * absolute amount (ops intentional); continuing non-override members keep the
   * headroom-only rule.
   */
  overrides?: ReadonlyMap<string, number>;
  /** week (default) uses monthly/4; month uses the full monthly cap. */
  period?: SharedKeyPeriodKind;
  /** End of the current period for mid-period join fractions. Defaults to week end. */
  periodEnd?: Date;
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
    overrides: overridesInput = new Map(),
    period = "week",
  } = args;
  const result = new Map<string, number>();
  const n = members.length;
  if (n <= 0 || !(monthlyCapUsd > 0)) return result;

  const periodEnd = args.periodEnd ?? sharedKeyWeekEnd(weekStart);
  const periodPool = sharedKeyPeriodPoolUsd(monthlyCapUsd, period);

  const memberIds = new Set(members.map((member) => member.userId));
  const overrides = new Map<string, number>();
  for (const [userId, amount] of overridesInput) {
    if (!memberIds.has(userId)) continue;
    if (!(amount >= 0) || !Number.isFinite(amount)) continue;
    overrides.set(userId, amount);
  }

  const effective = (userId: string) =>
    effectiveSharedKeySpendUsd(spentByUser.get(userId) ?? 0, preJoinSpendByUser.get(userId) ?? 0);
  const floorOf = (userId: string) => effective(userId) + (reservedByUser.get(userId) ?? 0);
  /**
   * An override below already-committed spend must still reserve that floor against
   * the pool — otherwise the gap is handed to everyone else and total spendable
   * (max(allotment, spent)) exceeds the cap.
   */
  const overridePoolTake = (userId: string, overrideUsd: number) =>
    Math.max(overrideUsd, floorOf(userId));

  const remainderMembers = members.filter((member) => !overrides.has(member.userId));
  // Non-override committed spend must stay reserved; scale overrides against what
  // remains of the pool, not the whole pool (otherwise overspent peers are starved
  // while override takes inflate past the cap).
  let othersCommitted = 0;
  for (const member of remainderMembers) {
    othersCommitted += floorOf(member.userId);
  }
  for (const [userId] of previousAllotments) {
    if (overrides.has(userId)) continue;
    if (remainderMembers.some((member) => member.userId === userId)) continue;
    // Removed prior holders: their spent+reserved still counts against the pool.
    othersCommitted += floorOf(userId);
  }
  const availableForOverrides = Math.max(0, periodPool - othersCommitted);

  let overrideTakeSum = 0;
  for (const [userId, amount] of overrides) {
    overrideTakeSum += overridePoolTake(userId, amount);
  }
  if (overrideTakeSum > availableForOverrides && overrideTakeSum > 0) {
    const scale = availableForOverrides / overrideTakeSum;
    for (const [userId, amount] of overrides) {
      overrides.set(userId, amount * scale);
    }
    overrideTakeSum = 0;
    for (const [userId, amount] of overrides) {
      overrideTakeSum += overridePoolTake(userId, amount);
    }
  }

  const remainderPool = Math.max(0, periodPool - overrideTakeSum);
  const remainderN = remainderMembers.length;
  const fullShare = remainderN > 0 ? remainderPool / remainderN : 0;

  const shareOf = (member: SharedKeyBudgetMember) => {
    if (overrides.has(member.userId)) return overrides.get(member.userId)!;
    return member.joinedAt.getTime() > weekStart.getTime()
      ? fullShare * midPeriodJoinFraction(member.joinedAt, weekStart, periodEnd)
      : fullShare;
  };

  /**
   * Apply override ceilings. Mid-period (no rebase): an increase may only consume
   * free pool headroom (pool − Σ current allotments of active members). Raises
   * beyond that are clamped so sum(allotments) never exceeds the pool; decreases
   * apply in full. Callers that write overrides also reject raises past this
   * bound (BAD_REQUEST) — clamp here is the safety net for redivide itself.
   */
  const applyOverrides = (opts?: { clampRaisesToHeadroom?: boolean }) => {
    if (!opts?.clampRaisesToHeadroom) {
      for (const [userId, amount] of overrides) {
        result.set(userId, amount);
      }
      return;
    }
    let free = Math.max(
      0,
      periodPool -
        members.reduce((sum, member) => sum + (previousAllotments.get(member.userId) ?? 0), 0),
    );
    for (const [userId, amount] of overrides) {
      const prev = previousAllotments.get(userId) ?? 0;
      if (amount > prev) {
        const allowed = Math.min(amount - prev, free);
        free -= allowed;
        result.set(userId, prev + allowed);
      } else {
        result.set(userId, amount);
      }
    }
  };

  // Fresh period: even full-period shares (join-time pro-rated) + absolute overrides.
  if (previousAllotments.size === 0) {
    for (const member of remainderMembers) {
      result.set(member.userId, shareOf(member));
    }
    applyOverrides();
    return result;
  }

  if (rebaseOnMonthlyCap) {
    // New pool minus everything already committed (all prior rows, including removed).
    // Override holders reserve max(override, spent+reserved) — never just the override.
    let committed = overrideTakeSum;
    for (const [userId] of previousAllotments) {
      if (overrides.has(userId)) continue;
      committed += floorOf(userId);
    }
    for (const member of remainderMembers) {
      if (!previousAllotments.has(member.userId)) {
        committed += floorOf(member.userId);
      }
    }
    const free = Math.max(0, periodPool - committed);
    // Members already at/over their new share stay at spent+reserved; remaining free
    // is split among the others by share weight so overspent rows are never raised.
    const floors = remainderMembers.map((member) => {
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
    applyOverrides();
    return result;
  }

  // Never raise a continuing non-override member; joiners are funded only from headroom.
  // Override holders get their absolute amount; lowering one frees only the unused gap
  // (previous allotment − max(override, floor)) into joiner funding — never raises peers.
  const headroom = new Map<string, number>();
  let freed = 0;
  for (const [userId, allotment] of previousAllotments) {
    if (overrides.has(userId)) {
      const take = overridePoolTake(userId, overrides.get(userId)!);
      if (members.some((member) => member.userId === userId)) {
        freed += Math.max(0, allotment - take);
      } else {
        freed += Math.max(0, allotment - floorOf(userId));
      }
      continue;
    }
    const head = Math.max(0, allotment - floorOf(userId));
    if (remainderMembers.some((member) => member.userId === userId)) headroom.set(userId, head);
    else freed += head;
  }

  const joiners = remainderMembers.filter((member) => !previousAllotments.has(member.userId));
  const totalHeadroom = [...headroom.values()].reduce((sum, value) => sum + value, 0) + freed;
  const splitN = Math.max(1, remainderN);
  let taken = 0;
  for (const joiner of joiners) {
    const slice = Math.min(shareOf(joiner), totalHeadroom / splitN);
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

  applyOverrides({ clampRaisesToHeadroom: true });
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
