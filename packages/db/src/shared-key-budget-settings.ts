/**
 * Ops-editable shared-key budget settings. Every write takes the members advisory lock
 * and runs in one transaction with allotment recompute when needed.
 */
import {
  parseSharedKeyMonthlyBudgetInput,
  parseSharedKeyTimezone,
  resolveSharedKeyPeriodSchedule,
  sharedKeyPeriodStart,
  type SharedKeyPeriodKind,
} from "@rakazo/core";
import type { PrismaClient } from "./client.js";
import { Prisma } from "./client.js";
import {
  DEFAULT_SHARED_KEY_HARD_STOP_ENABLED,
  DEFAULT_SHARED_KEY_HOLD_STALE_MINUTES,
  DEFAULT_SHARED_KEY_PRUNE_INACTIVE,
  lockSharedKeyBudget,
  recomputeSharedKeyWeekAllotmentsTx,
  resolveSharedKeyPeriodBounds,
  resolveWarningThresholds,
  SHARED_KEY_BUDGET_MEMBERS_LOCK,
  type SharedKeyBudgetSettingsRow,
} from "./shared-key-budget.js";

type SettingsPrisma = Pick<
  PrismaClient,
  | "deploymentSettings"
  | "sharedKeyBudgetMember"
  | "sharedKeyMemberOverride"
  | "sharedKeyWeekAllotment"
  | "sharedKeyAllotmentTransfer"
  | "sharedKeySpendAdjustment"
  | "usageRecord"
  | "user"
  | "member"
  | "adminGrant"
  | "auditEvent"
  | "space"
  | "$transaction"
  | "$queryRaw"
>;

const SETTINGS_SELECT = {
  sharedKeyMonthlyBudgetUsd: true,
  sharedKeyPeriod: true,
  sharedKeyResetDow: true,
  sharedKeyResetDom: true,
  sharedKeyResetMinutes: true,
  sharedKeyTimezone: true,
  sharedKeyActivePeriodStart: true,
  sharedKeyAutoEnrollMode: true,
  sharedKeyWarningThresholds: true,
  sharedKeyHardStopEnabled: true,
  sharedKeyHoldStaleMinutes: true,
  sharedKeyPruneInactive: true,
} as const;

export type SettingSource = "db" | "env" | "default";

export type SharedKeyBudgetSettingsView = {
  monthlyCapUsd: number | null;
  monthlyCapSource: SettingSource;
  period: SharedKeyPeriodKind;
  periodSource: SettingSource;
  resetDow: number;
  resetDowSource: SettingSource;
  resetDom: number;
  resetDomSource: SettingSource;
  resetMinutes: number;
  resetMinutesSource: SettingSource;
  timezone: string;
  timezoneSource: SettingSource;
  weekStartsAt: string;
  resetsAt: string;
  autoEnrollMode: "off" | "gated" | "open" | "signup";
  autoEnrollModeSource: SettingSource;
  warningThresholds: number[];
  warningThresholdsSource: SettingSource;
  hardStopEnabled: boolean;
  hardStopEnabledSource: SettingSource;
  holdStaleMinutes: number;
  holdStaleMinutesSource: SettingSource;
  pruneInactive: boolean;
  pruneInactiveSource: SettingSource;
  memberOverrides: Array<{ userId: string; weeklyAllotmentUsd: number }>;
};

function source(dbValue: unknown): SettingSource {
  return dbValue == null ? "default" : "db";
}

export async function loadSharedKeyBudgetSettingsView(
  prisma: Pick<SettingsPrisma, "deploymentSettings" | "sharedKeyMemberOverride">,
  envMonthlyCap: number | null = null,
  now = new Date(),
): Promise<SharedKeyBudgetSettingsView> {
  const settings = await prisma.deploymentSettings.findUnique({
    where: { id: "default" },
    select: SETTINGS_SELECT,
  });
  const schedule = resolveSharedKeyPeriodSchedule({
    period:
      settings?.sharedKeyPeriod === "week" || settings?.sharedKeyPeriod === "month"
        ? settings.sharedKeyPeriod
        : undefined,
    resetDow: settings?.sharedKeyResetDow ?? undefined,
    resetDom: settings?.sharedKeyResetDom ?? undefined,
    resetMinutes: settings?.sharedKeyResetMinutes ?? undefined,
    timezone: settings?.sharedKeyTimezone ?? undefined,
  });
  const { periodStart, periodEnd } = resolveSharedKeyPeriodBounds(settings, now);
  const dbCap = settings?.sharedKeyMonthlyBudgetUsd;
  const monthlyCapUsd =
    dbCap != null && dbCap > 0
      ? dbCap
      : envMonthlyCap != null && envMonthlyCap > 0
        ? envMonthlyCap
        : null;
  const monthlyCapSource: SettingSource =
    dbCap != null && dbCap > 0 ? "db" : envMonthlyCap != null && envMonthlyCap > 0 ? "env" : "default";

  const modeRaw = settings?.sharedKeyAutoEnrollMode;
  const autoEnrollMode =
    modeRaw === "off" || modeRaw === "gated" || modeRaw === "open" ? modeRaw : "signup";

  const overrides = await prisma.sharedKeyMemberOverride.findMany({
    select: { userId: true, weeklyAllotmentUsd: true },
    orderBy: { userId: "asc" },
  });

  return {
    monthlyCapUsd,
    monthlyCapSource,
    period: schedule.period,
    periodSource: source(settings?.sharedKeyPeriod),
    resetDow: schedule.resetDow,
    resetDowSource: source(settings?.sharedKeyResetDow),
    resetDom: schedule.resetDom,
    resetDomSource: source(settings?.sharedKeyResetDom),
    resetMinutes: schedule.resetMinutes,
    resetMinutesSource: source(settings?.sharedKeyResetMinutes),
    timezone: schedule.timezone,
    timezoneSource: source(settings?.sharedKeyTimezone),
    weekStartsAt: periodStart.toISOString(),
    resetsAt: periodEnd.toISOString(),
    autoEnrollMode,
    autoEnrollModeSource: source(settings?.sharedKeyAutoEnrollMode),
    warningThresholds: resolveWarningThresholds(settings?.sharedKeyWarningThresholds),
    warningThresholdsSource: source(settings?.sharedKeyWarningThresholds),
    hardStopEnabled:
      settings?.sharedKeyHardStopEnabled == null
        ? DEFAULT_SHARED_KEY_HARD_STOP_ENABLED
        : settings.sharedKeyHardStopEnabled,
    hardStopEnabledSource: source(settings?.sharedKeyHardStopEnabled),
    holdStaleMinutes:
      settings?.sharedKeyHoldStaleMinutes == null
        ? DEFAULT_SHARED_KEY_HOLD_STALE_MINUTES
        : settings.sharedKeyHoldStaleMinutes,
    holdStaleMinutesSource: source(settings?.sharedKeyHoldStaleMinutes),
    pruneInactive:
      settings?.sharedKeyPruneInactive == null
        ? DEFAULT_SHARED_KEY_PRUNE_INACTIVE
        : settings.sharedKeyPruneInactive,
    pruneInactiveSource: source(settings?.sharedKeyPruneInactive),
    memberOverrides: overrides,
  };
}

export type SharedKeyBudgetSettingsPatch = {
  monthlyCapUsd?: number | null;
  period?: SharedKeyPeriodKind | null;
  resetDow?: number | null;
  resetDom?: number | null;
  resetMinutes?: number | null;
  timezone?: string | null;
  autoEnrollMode?: "off" | "gated" | "open" | "signup" | null;
  warningThresholds?: number[] | null;
  hardStopEnabled?: boolean | null;
  holdStaleMinutes?: number | null;
  pruneInactive?: boolean | null;
  /** When true, freeze active period to the new schedule's current start and rebase. */
  applyScheduleNow?: boolean;
};

/**
 * Persist ops budget settings under the members lock. Schedule changes take effect at
 * the next boundary unless applyScheduleNow is set (audited by the caller).
 */
export async function updateSharedKeyBudgetSettings(
  prisma: SettingsPrisma,
  patch: SharedKeyBudgetSettingsPatch,
  now = new Date(),
): Promise<{ previous: SharedKeyBudgetSettingsRow | null; applyScheduleNow: boolean }> {
  let previous: SharedKeyBudgetSettingsRow | null = null;
  const applyScheduleNow = patch.applyScheduleNow === true;

  const data: Record<string, unknown> = {};
  if ("monthlyCapUsd" in patch) {
    if (patch.monthlyCapUsd == null) {
      data.sharedKeyMonthlyBudgetUsd = null;
    } else {
      const parsed = parseSharedKeyMonthlyBudgetInput(patch.monthlyCapUsd);
      if (parsed == null) throw new Error("Invalid shared-key monthly budget");
      data.sharedKeyMonthlyBudgetUsd = parsed;
    }
  }
  if ("period" in patch) {
    if (patch.period == null) data.sharedKeyPeriod = null;
    else if (patch.period === "week" || patch.period === "month") data.sharedKeyPeriod = patch.period;
    else throw new Error("period must be week or month");
  }
  if ("resetDow" in patch) {
    if (patch.resetDow == null) data.sharedKeyResetDow = null;
    else if (Number.isInteger(patch.resetDow) && patch.resetDow >= 0 && patch.resetDow <= 6) {
      data.sharedKeyResetDow = patch.resetDow;
    } else throw new Error("resetDow must be an integer 0–6");
  }
  if ("resetDom" in patch) {
    if (patch.resetDom == null) data.sharedKeyResetDom = null;
    else if (Number.isInteger(patch.resetDom) && patch.resetDom >= 1 && patch.resetDom <= 28) {
      data.sharedKeyResetDom = patch.resetDom;
    } else throw new Error("resetDom must be an integer 1–28");
  }
  if ("resetMinutes" in patch) {
    if (patch.resetMinutes == null) data.sharedKeyResetMinutes = null;
    else if (
      Number.isInteger(patch.resetMinutes) &&
      patch.resetMinutes >= 0 &&
      patch.resetMinutes <= 1439
    ) {
      data.sharedKeyResetMinutes = patch.resetMinutes;
    } else throw new Error("resetMinutes must be an integer 0–1439");
  }
  if ("timezone" in patch) {
    if (patch.timezone == null || patch.timezone === "") data.sharedKeyTimezone = null;
    else {
      const tz = parseSharedKeyTimezone(patch.timezone);
      if (!tz) throw new Error("Invalid IANA timezone");
      data.sharedKeyTimezone = tz;
    }
  }
  if ("autoEnrollMode" in patch) {
    if (patch.autoEnrollMode == null || patch.autoEnrollMode === "signup") {
      data.sharedKeyAutoEnrollMode = null;
    } else if (
      patch.autoEnrollMode === "off" ||
      patch.autoEnrollMode === "gated" ||
      patch.autoEnrollMode === "open"
    ) {
      data.sharedKeyAutoEnrollMode = patch.autoEnrollMode;
    } else throw new Error("Invalid auto-enroll mode");
  }
  if ("warningThresholds" in patch) {
    if (patch.warningThresholds == null) data.sharedKeyWarningThresholds = Prisma.DbNull;
    else {
      const values = resolveWarningThresholds(patch.warningThresholds);
      if (values.length === 0) throw new Error("warningThresholds must be a non-empty number array");
      data.sharedKeyWarningThresholds = values;
    }
  }
  if ("hardStopEnabled" in patch) {
    data.sharedKeyHardStopEnabled = patch.hardStopEnabled;
  }
  if ("holdStaleMinutes" in patch) {
    if (patch.holdStaleMinutes == null) data.sharedKeyHoldStaleMinutes = null;
    else if (
      Number.isInteger(patch.holdStaleMinutes) &&
      patch.holdStaleMinutes > 0 &&
      patch.holdStaleMinutes <= 24 * 60
    ) {
      data.sharedKeyHoldStaleMinutes = patch.holdStaleMinutes;
    } else throw new Error("holdStaleMinutes must be a positive integer up to 1440");
  }
  if ("pruneInactive" in patch) {
    data.sharedKeyPruneInactive = patch.pruneInactive;
  }

  await prisma.$transaction(async (tx) => {
    await lockSharedKeyBudget(tx, SHARED_KEY_BUDGET_MEMBERS_LOCK);
    previous = await tx.deploymentSettings.findUnique({
      where: { id: "default" },
      select: SETTINGS_SELECT,
    });

    const scheduleFieldsChanged =
      "period" in patch ||
      "resetDow" in patch ||
      "resetDom" in patch ||
      "resetMinutes" in patch ||
      "timezone" in patch;

    if (scheduleFieldsChanged) {
      const mergedForSchedule = resolveSharedKeyPeriodSchedule({
        period:
          "period" in patch
            ? (patch.period ?? undefined)
            : previous?.sharedKeyPeriod === "week" || previous?.sharedKeyPeriod === "month"
              ? previous.sharedKeyPeriod
              : undefined,
        resetDow:
          "resetDow" in patch
            ? (patch.resetDow ?? undefined)
            : (previous?.sharedKeyResetDow ?? undefined),
        resetDom:
          "resetDom" in patch
            ? (patch.resetDom ?? undefined)
            : (previous?.sharedKeyResetDom ?? undefined),
        resetMinutes:
          "resetMinutes" in patch
            ? (patch.resetMinutes ?? undefined)
            : (previous?.sharedKeyResetMinutes ?? undefined),
        timezone:
          "timezone" in patch
            ? (patch.timezone ?? undefined)
            : (previous?.sharedKeyTimezone ?? undefined),
      });
      if (applyScheduleNow) {
        data.sharedKeyActivePeriodStart = sharedKeyPeriodStart(mergedForSchedule, now);
      } else if (previous?.sharedKeyActivePeriodStart == null) {
        // Freeze the current period so the new schedule applies at the next boundary.
        const current = resolveSharedKeyPeriodBounds(previous, now);
        data.sharedKeyActivePeriodStart = current.periodStart;
      }
    }

    await tx.deploymentSettings.upsert({
      where: { id: "default" },
      create: { id: "default", ...data },
      update: data,
    });

    const needsRebase = applyScheduleNow || "monthlyCapUsd" in patch;
    if (needsRebase) {
      await recomputeSharedKeyWeekAllotmentsTx(tx, now, {
        rebaseOnMonthlyCap: true,
      });
    }
  });

  return { previous, applyScheduleNow };
}

/** Set or clear a per-user weekly allotment override under the members lock. */
export async function setSharedKeyMemberOverride(
  prisma: SettingsPrisma,
  input: { userId: string; weeklyAllotmentUsd: number | null; now?: Date },
): Promise<void> {
  const now = input.now ?? new Date();
  if (input.weeklyAllotmentUsd != null) {
    if (
      !Number.isFinite(input.weeklyAllotmentUsd) ||
      input.weeklyAllotmentUsd <= 0 ||
      input.weeklyAllotmentUsd > 1_000_000
    ) {
      throw new Error("weeklyAllotmentUsd must be a positive number within the allowed range");
    }
  }
  await prisma.$transaction(async (tx) => {
    await lockSharedKeyBudget(tx, SHARED_KEY_BUDGET_MEMBERS_LOCK);
    const member = await tx.sharedKeyBudgetMember.findUnique({
      where: { userId: input.userId },
      select: { userId: true },
    });
    if (!member) throw new Error("User is not on the shared-key roster");
    if (input.weeklyAllotmentUsd == null) {
      await tx.sharedKeyMemberOverride.deleteMany({ where: { userId: input.userId } });
    } else {
      await tx.sharedKeyMemberOverride.upsert({
        where: { userId: input.userId },
        create: { userId: input.userId, weeklyAllotmentUsd: input.weeklyAllotmentUsd },
        update: { weeklyAllotmentUsd: input.weeklyAllotmentUsd },
      });
    }
    await recomputeSharedKeyWeekAllotmentsTx(tx, now, { rebaseOnMonthlyCap: true });
  });
}
