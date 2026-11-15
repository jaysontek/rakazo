/**
 * Ops-editable shared-key budget settings. Every write takes the members advisory lock
 * and runs in one transaction with allotment recompute when needed. Audit rows are
 * written inside the same locked transaction via appendAuditEventTx.
 */
import {
  parseSharedKeyMonthlyBudgetInput,
  parseSharedKeyTimezone,
  resolveSharedKeyPeriodSchedule,
  roundUsdToCents,
  sharedKeyPeriodPoolUsd,
  sharedKeyPeriodStart,
  type SharedKeyPeriodKind,
} from "@rakazo/core";
import {
  appendAuditEventTx,
  DEPLOYMENT_AUDIT_ORGANIZATION_ID,
} from "./audit-events.js";
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

export type UpdateSharedKeyBudgetSettingsOptions = {
  actorUserId: string;
  /** True when the deployment is already gated (signups off / allowlist / etc.). */
  gatedDeployment: boolean;
  /**
   * Audit target so appendAuditEventTx never writes zero rows. Prefer the actor's
   * space; fall back to the deployment-level organization sentinel.
   */
  spaceId?: string | null;
  organizationId?: string | null;
  now?: Date;
};

function auditTarget(options: {
  spaceId?: string | null;
  organizationId?: string | null;
}): { spaceId?: string; organizationId?: string } {
  if (options.spaceId) return { spaceId: options.spaceId };
  if (options.organizationId) return { organizationId: options.organizationId };
  return { organizationId: DEPLOYMENT_AUDIT_ORGANIZATION_ID };
}

/** Reject when the sum of absolute overrides would exceed the period pool. */
async function assertOverridesFitPool(
  tx: Pick<Prisma.TransactionClient, "sharedKeyMemberOverride">,
  monthlyCapUsd: number | null | undefined,
  period: SharedKeyPeriodKind,
): Promise<void> {
  if (!(monthlyCapUsd != null && monthlyCapUsd > 0)) {
    const any = await tx.sharedKeyMemberOverride.findFirst({
      select: { userId: true },
    });
    if (any) {
      throw new Error("Clear member overrides before removing the monthly shared-key cap");
    }
    return;
  }
  const pool = sharedKeyPeriodPoolUsd(monthlyCapUsd, period);
  const overrides = await tx.sharedKeyMemberOverride.findMany({
    select: { weeklyAllotmentUsd: true },
  });
  const sum = overrides.reduce((acc, row) => acc + row.weeklyAllotmentUsd, 0);
  if (sum > pool) {
    throw new Error(
      `Sum of member overrides (${sum}) exceeds the period pool (${pool})`,
    );
  }
}

type AuditScalar = string | number | boolean | null;

function settingsAuditPrev(
  previous: SharedKeyBudgetSettingsRow | null,
  key: keyof SharedKeyBudgetSettingsRow,
): AuditScalar {
  if (!previous) return null;
  const value = previous[key];
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return JSON.stringify(value);
  if (value === undefined) return null;
  return value as AuditScalar;
}

/**
 * Persist ops budget settings under the members lock. Schedule changes take effect at
 * the next boundary unless applyScheduleNow is set. Every changed field is audited
 * inside the same locked transaction (prev→new); failure rolls the tx back.
 */
export async function updateSharedKeyBudgetSettings(
  prisma: SettingsPrisma,
  patch: SharedKeyBudgetSettingsPatch,
  options: UpdateSharedKeyBudgetSettingsOptions,
): Promise<{ previous: SharedKeyBudgetSettingsRow | null; applyScheduleNow: boolean }> {
  const now = options.now ?? new Date();
  let previous: SharedKeyBudgetSettingsRow | null = null;
  const applyScheduleNow = patch.applyScheduleNow === true;

  const data: Record<string, unknown> = {};
  const changed: Array<{ field: string; prev: AuditScalar; next: AuditScalar }> = [];

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
    else if (Number.isInteger(patch.resetDom) && patch.resetDom >= 1 && patch.resetDom <= 31) {
      data.sharedKeyResetDom = patch.resetDom;
    } else throw new Error("resetDom must be an integer 1–31");
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
      if (patch.autoEnrollMode === "gated" && !options.gatedDeployment) {
        throw new Error(
          "autoEnrollMode 'gated' requires a gated shared-key deployment (signups closed, allowlist, single-account, or directory)",
        );
      }
      data.sharedKeyAutoEnrollMode = patch.autoEnrollMode;
    } else throw new Error("Invalid auto-enroll mode");
  }
  if ("warningThresholds" in patch) {
    if (patch.warningThresholds == null) data.sharedKeyWarningThresholds = Prisma.DbNull;
    else {
      if (!Array.isArray(patch.warningThresholds) || patch.warningThresholds.length === 0) {
        throw new Error("warningThresholds must be a non-empty number array");
      }
      if (patch.warningThresholds.length > 10) {
        throw new Error("warningThresholds accepts at most 10 entries");
      }
      for (const value of patch.warningThresholds) {
        if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 100) {
          throw new Error("warningThresholds entries must be numbers from 0 to 100");
        }
      }
      data.sharedKeyWarningThresholds = resolveWarningThresholds(patch.warningThresholds);
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

    // Cap reduction or period shrink (e.g. month→week) must not leave overrides over pool.
    if ("monthlyCapUsd" in patch || "period" in patch) {
      const nextMonthly =
        "monthlyCapUsd" in patch
          ? (data.sharedKeyMonthlyBudgetUsd as number | null | undefined)
          : previous?.sharedKeyMonthlyBudgetUsd;
      const nextPeriodRaw =
        "period" in patch
          ? (data.sharedKeyPeriod as string | null | undefined)
          : previous?.sharedKeyPeriod;
      const nextPeriod: SharedKeyPeriodKind =
        nextPeriodRaw === "month" ? "month" : "week";
      await assertOverridesFitPool(tx, nextMonthly, nextPeriod);
    }

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
      // applyScheduleNow only rebases when schedule fields actually change; alone it is a no-op.
      if (applyScheduleNow) {
        data.sharedKeyActivePeriodStart = sharedKeyPeriodStart(mergedForSchedule, now);
      } else if (previous?.sharedKeyActivePeriodStart == null) {
        // Freeze the current period so the new schedule applies at the next boundary.
        const current = resolveSharedKeyPeriodBounds(previous, now);
        data.sharedKeyActivePeriodStart = current.periodStart;
      }
    }

    const fieldMap: Array<{ patchKey: keyof SharedKeyBudgetSettingsPatch; dbKey: keyof SharedKeyBudgetSettingsRow; dataKey: string }> = [
      { patchKey: "monthlyCapUsd", dbKey: "sharedKeyMonthlyBudgetUsd", dataKey: "sharedKeyMonthlyBudgetUsd" },
      { patchKey: "period", dbKey: "sharedKeyPeriod", dataKey: "sharedKeyPeriod" },
      { patchKey: "resetDow", dbKey: "sharedKeyResetDow", dataKey: "sharedKeyResetDow" },
      { patchKey: "resetDom", dbKey: "sharedKeyResetDom", dataKey: "sharedKeyResetDom" },
      { patchKey: "resetMinutes", dbKey: "sharedKeyResetMinutes", dataKey: "sharedKeyResetMinutes" },
      { patchKey: "timezone", dbKey: "sharedKeyTimezone", dataKey: "sharedKeyTimezone" },
      { patchKey: "autoEnrollMode", dbKey: "sharedKeyAutoEnrollMode", dataKey: "sharedKeyAutoEnrollMode" },
      { patchKey: "warningThresholds", dbKey: "sharedKeyWarningThresholds", dataKey: "sharedKeyWarningThresholds" },
      { patchKey: "hardStopEnabled", dbKey: "sharedKeyHardStopEnabled", dataKey: "sharedKeyHardStopEnabled" },
      { patchKey: "holdStaleMinutes", dbKey: "sharedKeyHoldStaleMinutes", dataKey: "sharedKeyHoldStaleMinutes" },
      { patchKey: "pruneInactive", dbKey: "sharedKeyPruneInactive", dataKey: "sharedKeyPruneInactive" },
    ];
    for (const { patchKey, dbKey, dataKey } of fieldMap) {
      if (!(patchKey in patch) || !(dataKey in data)) continue;
      const nextRaw = data[dataKey];
      const next: AuditScalar =
        nextRaw instanceof Date
          ? nextRaw.toISOString()
          : Array.isArray(nextRaw)
            ? JSON.stringify(nextRaw)
            : nextRaw === Prisma.DbNull || nextRaw === undefined
              ? null
              : (nextRaw as AuditScalar);
      changed.push({
        field: patchKey,
        prev: settingsAuditPrev(previous, dbKey),
        next,
      });
    }
    if (applyScheduleNow && data.sharedKeyActivePeriodStart instanceof Date) {
      changed.push({
        field: "applyScheduleNow",
        prev: previous?.sharedKeyActivePeriodStart?.toISOString() ?? null,
        next: data.sharedKeyActivePeriodStart.toISOString(),
      });
    }

    await tx.deploymentSettings.upsert({
      where: { id: "default" },
      create: { id: "default", ...data },
      update: data,
    });

    if (changed.length > 0) {
      const metadata: Record<string, string | number | boolean | null> = {
        applyScheduleNow,
      };
      for (const row of changed) {
        metadata[`prev.${row.field}`] = row.prev;
        metadata[`next.${row.field}`] = row.next;
      }
      await appendAuditEventTx(tx, {
        action: "shared_key_budget.settings.changed",
        actor: { type: "user", id: options.actorUserId },
        ...auditTarget(options),
        metadata,
      });
    }

    // Cap edits always rebase (audited via the monthlyCapUsd field change above).
    // applyScheduleNow only rebases when schedule fields changed — otherwise it is a
    // no-op so an unaudited rebase cannot run.
    const needsRebase =
      "monthlyCapUsd" in patch || (applyScheduleNow && scheduleFieldsChanged);
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
  input: {
    userId: string;
    weeklyAllotmentUsd: number | null;
    actorUserId: string;
    spaceId?: string | null;
    organizationId?: string | null;
    now?: Date;
  },
): Promise<void> {
  const now = input.now ?? new Date();
  let nextOverride: number | null = null;
  if (input.weeklyAllotmentUsd != null) {
    const rounded = roundUsdToCents(input.weeklyAllotmentUsd);
    if (!Number.isFinite(rounded) || rounded < 0 || rounded > 1_000_000) {
      throw new Error("weeklyAllotmentUsd must be a non-negative number within the allowed range");
    }
    nextOverride = rounded;
  }
  await prisma.$transaction(async (tx) => {
    await lockSharedKeyBudget(tx, SHARED_KEY_BUDGET_MEMBERS_LOCK);
    const member = await tx.sharedKeyBudgetMember.findUnique({
      where: { userId: input.userId },
      select: { userId: true },
    });
    if (!member) throw new Error("User is not on the shared-key roster");

    const existing = await tx.sharedKeyMemberOverride.findUnique({
      where: { userId: input.userId },
      select: { weeklyAllotmentUsd: true },
    });
    const prevOverride = existing?.weeklyAllotmentUsd ?? null;

    if (nextOverride != null) {
      const settings = await tx.deploymentSettings.findUnique({
        where: { id: "default" },
        select: SETTINGS_SELECT,
      });
      const monthly = settings?.sharedKeyMonthlyBudgetUsd;
      if (!(monthly != null && monthly > 0)) {
        throw new Error("Set a monthly shared-key cap before assigning overrides");
      }
      const { schedule } = resolveSharedKeyPeriodBounds(settings, now);
      const pool = sharedKeyPeriodPoolUsd(monthly, schedule.period);
      const others = await tx.sharedKeyMemberOverride.findMany({
        where: { userId: { not: input.userId } },
        select: { weeklyAllotmentUsd: true },
      });
      const othersSum = others.reduce((sum, row) => sum + row.weeklyAllotmentUsd, 0);
      if (othersSum + nextOverride > pool) {
        throw new Error(
          `Sum of member overrides (${othersSum + nextOverride}) exceeds the period pool (${pool})`,
        );
      }
      await tx.sharedKeyMemberOverride.upsert({
        where: { userId: input.userId },
        create: { userId: input.userId, weeklyAllotmentUsd: nextOverride },
        update: { weeklyAllotmentUsd: nextOverride },
      });
    } else {
      await tx.sharedKeyMemberOverride.deleteMany({ where: { userId: input.userId } });
    }

    await appendAuditEventTx(tx, {
      action: "shared_key_budget.member.override",
      actor: { type: "user", id: input.actorUserId },
      target: { type: "user", id: input.userId },
      ...auditTarget(input),
      metadata: {
        userId: input.userId,
        "prev.weeklyAllotmentUsd": prevOverride,
        "next.weeklyAllotmentUsd": nextOverride,
      },
    });

    // Mid-period override edits keep the headroom-only rule: never raise continuing
    // peers above their current allotment (PR #16). Freed gap may fund joiners only.
    await recomputeSharedKeyWeekAllotmentsTx(tx, now);
  });
}
