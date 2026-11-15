import { Trans, useLingui } from "@lingui/react/macro";
import type {
  OpsAccount,
  OpsOverview,
  OpsSharedKeyBudgetSettings,
  OpsSharedKeySettingSource,
  OpsSharedKeySpendAdjustment,
} from "@rakazo/contracts";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Badge,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Checkbox,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  Input,
  NativeSelect,
  NativeSelectOption,
  Spinner,
  Switch,
  buttonVariants,
  cn,
} from "@rakazo/ui-web";
import { ChevronDown } from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useId, useMemo, useState } from "react";
import { rpc } from "../lib/rpc";
import { errorText } from "../lib/user-error";

function money(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return `$${value.toFixed(2)}`;
}

function resetCountdown(resetsAt: string, nowMs = Date.now()): string {
  const msLeft = new Date(resetsAt).getTime() - nowMs;
  if (!(msLeft > 0)) return "0h";
  const totalHours = Math.floor(msLeft / 3_600_000);
  const days = Math.floor(totalHours / 24);
  const hours = totalHours % 24;
  if (days > 0) return `${days}d ${hours}h`;
  const minutes = Math.floor((msLeft % 3_600_000) / 60_000);
  if (totalHours > 0) return `${totalHours}h ${minutes}m`;
  return `${Math.max(1, minutes)}m`;
}

function minutesToTime(minutes: number): string {
  const clamped = Math.max(0, Math.min(1439, Math.floor(minutes)));
  const h = Math.floor(clamped / 60);
  const m = clamped % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

function timeToMinutes(value: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return null;
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null;
  return hours * 60 + minutes;
}

function SourceBadge({ source }: { source: OpsSharedKeySettingSource }) {
  const label = source === "db" ? "DB" : source === "env" ? "Env" : "Default";
  return (
    <Badge variant="outline" className="px-1.5 py-0 text-[10px] font-normal tracking-wide">
      {label}
    </Badge>
  );
}

function SettingLabel({
  children,
  source,
}: {
  children: ReactNode;
  source: OpsSharedKeySettingSource;
}) {
  return (
    <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
      <span>{children}</span>
      <SourceBadge source={source} />
    </div>
  );
}

function UsageBar({
  percent,
  label,
}: {
  percent: number;
  label: string;
}) {
  const value = Math.min(100, Math.max(0, Math.floor(percent)));
  return (
    <div className="space-y-1">
      <div className="flex items-baseline justify-between gap-2 text-xs">
        <span className="tabular-nums">{value}%</span>
      </div>
      <div
        className="h-1.5 overflow-hidden rounded-full bg-muted"
        role="progressbar"
        aria-valuenow={value}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuetext={`${value}%`}
        aria-label={label}
      >
        <div className="h-full rounded-full bg-foreground transition-[width]" style={{ width: `${value}%` }} />
      </div>
    </div>
  );
}

type SettingsDraft = {
  period: "week" | "month";
  resetDow: number;
  resetDom: number;
  resetTime: string;
  timezone: string;
  autoEnrollMode: OpsSharedKeyBudgetSettings["autoEnrollMode"];
  warningLow: string;
  warningHigh: string;
  hardStopEnabled: boolean;
  holdStaleMinutes: string;
  pruneInactive: boolean;
  applyScheduleNow: boolean;
};

function draftFromSettings(settings: OpsSharedKeyBudgetSettings): SettingsDraft {
  const [low, high] = settings.warningThresholds;
  return {
    period: settings.period,
    resetDow: settings.resetDow,
    resetDom: settings.resetDom,
    resetTime: minutesToTime(settings.resetMinutes),
    timezone: settings.timezone,
    autoEnrollMode: settings.autoEnrollMode,
    warningLow: String(low ?? 80),
    warningHigh: String(high ?? 95),
    hardStopEnabled: settings.hardStopEnabled,
    holdStaleMinutes: String(settings.holdStaleMinutes),
    pruneInactive: settings.pruneInactive,
    applyScheduleNow: false,
  };
}

function scheduleChanged(settings: OpsSharedKeyBudgetSettings, draft: SettingsDraft): boolean {
  return (
    draft.period !== settings.period ||
    draft.resetDow !== settings.resetDow ||
    draft.resetDom !== settings.resetDom ||
    draft.resetTime !== minutesToTime(settings.resetMinutes) ||
    draft.timezone !== settings.timezone
  );
}

export function BudgetSection({
  data,
  onChanged,
  interactive,
}: {
  data: OpsOverview;
  onChanged: () => void;
  interactive: boolean;
}) {
  return (
    <div data-testid="ops-budget-section" className="space-y-3">
      <KpiRow data={data} onCapSaved={onChanged} interactive={interactive} />
      {data.sharedKeyBudget.settings ? (
        <BudgetSettingsPanel
          settings={data.sharedKeyBudget.settings}
          onChanged={onChanged}
          interactive={interactive}
        />
      ) : null}
      <SpendAdjustmentsPanel
        adjustments={data.spendAdjustments ?? []}
        accounts={data.accounts}
        onChanged={onChanged}
        interactive={interactive}
      />
    </div>
  );
}

function KpiRow({
  data,
  onCapSaved,
  interactive,
}: {
  data: OpsOverview;
  onCapSaved: () => void;
  interactive: boolean;
}) {
  const { t } = useLingui();
  const budget = data.sharedKeyBudget;
  const [draft, setDraft] = useState(
    budget.monthlyCapUsd != null ? String(budget.monthlyCapUsd) : "",
  );
  const [saving, setSaving] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const pool = budget.weekPoolUsd;
  const spent = budget.weekSpentUsd;
  const poolPct =
    pool != null && pool > 0 ? Math.min(100, Math.max(0, (spent / pool) * 100)) : 0;
  const monthlyCapSource = budget.settings?.monthlyCapSource;

  useEffect(() => {
    setDraft(budget.monthlyCapUsd != null ? String(budget.monthlyCapUsd) : "");
  }, [budget.monthlyCapUsd]);

  function requestSaveCap() {
    const value = Number(draft);
    if (!Number.isFinite(value) || value <= 0 || value > 1_000_000) {
      setError(t`Enter a positive amount up to $1,000,000`);
      return;
    }
    setError(null);
    setConfirmOpen(true);
  }

  async function confirmSaveCap() {
    const value = Number(draft);
    if (!interactive) {
      setConfirmOpen(false);
      setEditing(false);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const result = await rpc.ops.setSharedKeyMonthlyBudget({ monthlyCapUsd: value });
      setDraft(String(result.monthlyCapUsd));
      setConfirmOpen(false);
      setEditing(false);
      onCapSaved();
    } catch (err) {
      setError(errorText(err, "Could not save monthly cap"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4" aria-label={t`Shared-key week`}>
      <Card size="sm" data-testid="shared-key-monthly-cap">
        <CardHeader className="gap-1">
          <CardDescription className="flex items-center gap-1.5">
            <Trans>Monthly cap</Trans>
            {monthlyCapSource ? <SourceBadge source={monthlyCapSource} /> : null}
          </CardDescription>
          <CardTitle className="tabular-nums">
            {budget.monthlyCapUsd == null ? (
              <span className="text-muted-foreground font-normal">
                <Trans>Not configured</Trans>
              </span>
            ) : (
              money(budget.monthlyCapUsd)
            )}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {editing ? (
            <div className="flex flex-wrap items-center gap-2">
              <label className="flex min-w-0 flex-1 items-center gap-1 text-sm">
                <span className="text-muted-foreground" aria-hidden="true">
                  $
                </span>
                <Input
                  type="number"
                  min={0.01}
                  max={1_000_000}
                  step="any"
                  inputMode="decimal"
                  aria-label={t`Monthly shared Gemini key cap`}
                  className="tabular-nums"
                  value={draft}
                  disabled={saving}
                  onChange={(event) => setDraft(event.target.value)}
                />
              </label>
              <button
                type="button"
                className={buttonVariants({ variant: "outline", size: "sm" })}
                disabled={saving}
                onClick={() => requestSaveCap()}
              >
                {saving ? <Spinner className="size-4" /> : <Trans>Save</Trans>}
              </button>
              <button
                type="button"
                className={buttonVariants({ variant: "ghost", size: "sm" })}
                disabled={saving}
                onClick={() => {
                  setEditing(false);
                  setDraft(budget.monthlyCapUsd != null ? String(budget.monthlyCapUsd) : "");
                  setError(null);
                }}
              >
                <Trans>Cancel</Trans>
              </button>
            </div>
          ) : (
            <button
              type="button"
              className={buttonVariants({ variant: "ghost", size: "sm" })}
              onClick={() => setEditing(true)}
            >
              <Trans>Edit</Trans>
            </button>
          )}
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
        </CardContent>
      </Card>

      <Card size="sm">
        <CardHeader className="gap-1">
          <CardDescription>
            <Trans>Shared-key week</Trans>
          </CardDescription>
          <CardTitle className="tabular-nums">
            {pool == null ? "—" : `${money(spent)} / ${money(pool)}`}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          <UsageBar percent={poolPct} label={t`Weekly shared-key pool used`} />
          <p className="text-xs text-muted-foreground" data-testid="ops-budget-reset">
            <Trans>Resets in {resetCountdown(budget.resetsAt)}</Trans>
            {" · "}
            {budget.timezone}
          </p>
        </CardContent>
      </Card>

      <Card size="sm">
        <CardHeader className="gap-1">
          <CardDescription>
            <Trans>Roster</Trans>
          </CardDescription>
          <CardTitle className="tabular-nums">{budget.memberCount}</CardTitle>
        </CardHeader>
      </Card>

      <Card size="sm">
        <CardHeader className="gap-1">
          <CardDescription>
            <Trans>Spend</Trans>
          </CardDescription>
          <CardTitle className="tabular-nums">{money(data.spend.totalCostUsd)}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-1 text-xs text-muted-foreground">
          <div className="flex justify-between gap-2">
            <Trans>Shared</Trans>
            <span className="tabular-nums text-foreground">{money(data.spend.sharedKeyCostUsd)}</span>
          </div>
          <div className="flex justify-between gap-2">
            <Trans>Personal</Trans>
            <span className="tabular-nums text-foreground">
              {money(data.spend.personalKeyCostUsd)}
            </span>
          </div>
        </CardContent>
      </Card>

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              <Trans>Save monthly shared-key cap?</Trans>
            </AlertDialogTitle>
            <AlertDialogDescription>
              <Trans>
                This sets the deployment monthly cap for the shared Gemini key to{" "}
                {money(Number(draft) || 0)}.
              </Trans>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={saving}>
              <Trans>Cancel</Trans>
            </AlertDialogCancel>
            <AlertDialogAction disabled={saving} onClick={() => void confirmSaveCap()}>
              <Trans>Save</Trans>
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}

function BudgetSettingsPanel({
  settings,
  onChanged,
  interactive,
}: {
  settings: OpsSharedKeyBudgetSettings;
  onChanged: () => void;
  interactive: boolean;
}) {
  const { t } = useLingui();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(() => draftFromSettings(settings));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmApply, setConfirmApply] = useState(false);
  const applyNowId = useId();
  const hardStopId = useId();
  const pruneId = useId();

  useEffect(() => {
    setDraft(draftFromSettings(settings));
  }, [settings]);

  const dirty = useMemo(() => {
    const base = draftFromSettings(settings);
    return (
      draft.period !== base.period ||
      draft.resetDow !== base.resetDow ||
      draft.resetDom !== base.resetDom ||
      draft.resetTime !== base.resetTime ||
      draft.timezone !== base.timezone ||
      draft.autoEnrollMode !== base.autoEnrollMode ||
      draft.warningLow !== base.warningLow ||
      draft.warningHigh !== base.warningHigh ||
      draft.hardStopEnabled !== base.hardStopEnabled ||
      draft.holdStaleMinutes !== base.holdStaleMinutes ||
      draft.pruneInactive !== base.pruneInactive ||
      draft.applyScheduleNow
    );
  }, [draft, settings]);

  function buildPatch():
    | { ok: true; patch: Parameters<typeof rpc.ops.updateSharedKeyBudgetSettings>[0] }
    | { ok: false; error: string } {
    const resetMinutes = timeToMinutes(draft.resetTime);
    if (resetMinutes == null) {
      return { ok: false, error: t`Enter reset time as HH:MM` };
    }
    const warningLow = Number(draft.warningLow);
    const warningHigh = Number(draft.warningHigh);
    if (
      !Number.isFinite(warningLow) ||
      !Number.isFinite(warningHigh) ||
      warningLow < 0 ||
      warningHigh > 100 ||
      warningLow >= warningHigh
    ) {
      return { ok: false, error: t`Enter two warning thresholds between 0 and 100` };
    }
    const holdStaleMinutes = Number(draft.holdStaleMinutes);
    if (!Number.isFinite(holdStaleMinutes) || holdStaleMinutes < 1 || holdStaleMinutes > 1440) {
      return { ok: false, error: t`Enter a stale-hold timeout between 1 and 1440 minutes` };
    }
    if (!draft.timezone.trim()) {
      return { ok: false, error: t`Enter a timezone` };
    }

    const patch: Parameters<typeof rpc.ops.updateSharedKeyBudgetSettings>[0] = {};
    if (draft.period !== settings.period) patch.period = draft.period;
    if (draft.resetDow !== settings.resetDow) patch.resetDow = draft.resetDow;
    if (draft.resetDom !== settings.resetDom) patch.resetDom = draft.resetDom;
    if (resetMinutes !== settings.resetMinutes) patch.resetMinutes = resetMinutes;
    if (draft.timezone.trim() !== settings.timezone) patch.timezone = draft.timezone.trim();
    if (draft.autoEnrollMode !== settings.autoEnrollMode) {
      patch.autoEnrollMode = draft.autoEnrollMode;
    }
    if (
      warningLow !== (settings.warningThresholds[0] ?? 80) ||
      warningHigh !== (settings.warningThresholds[1] ?? 95)
    ) {
      patch.warningThresholds = [warningLow, warningHigh];
    }
    if (draft.hardStopEnabled !== settings.hardStopEnabled) {
      patch.hardStopEnabled = draft.hardStopEnabled;
    }
    if (holdStaleMinutes !== settings.holdStaleMinutes) {
      patch.holdStaleMinutes = holdStaleMinutes;
    }
    if (draft.pruneInactive !== settings.pruneInactive) {
      patch.pruneInactive = draft.pruneInactive;
    }
    if (scheduleChanged(settings, draft) && draft.applyScheduleNow) {
      patch.applyScheduleNow = true;
    }
    return { ok: true, patch };
  }

  async function save(forceApplyConfirm = false) {
    const built = buildPatch();
    if (!built.ok) {
      setError(built.error);
      return;
    }
    if (Object.keys(built.patch).length === 0) {
      setError(null);
      return;
    }
    if (built.patch.applyScheduleNow && !forceApplyConfirm) {
      setConfirmApply(true);
      return;
    }
    if (!interactive) {
      setConfirmApply(false);
      setError(null);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await rpc.ops.updateSharedKeyBudgetSettings(built.patch);
      setConfirmApply(false);
      onChanged();
    } catch (err) {
      setError(errorText(err, t`Could not save budget settings`));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Collapsible open={open} onOpenChange={setOpen} data-testid="ops-budget-settings">
      <CollapsibleTrigger
        className={cn(
          buttonVariants({ variant: "ghost", size: "sm" }),
          "inline-flex w-full justify-between gap-2 px-0 sm:w-auto",
        )}
      >
        <Trans>Budget settings</Trans>
        <ChevronDown
          className={cn("size-4 transition-transform", open ? "rotate-180" : "")}
          aria-hidden="true"
        />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="mt-3 space-y-4 rounded-lg border p-3 sm:p-4">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <label className="space-y-1.5">
              <SettingLabel source={settings.periodSource}>
                <Trans>Period</Trans>
              </SettingLabel>
              <NativeSelect
                size="sm"
                value={draft.period}
                aria-label={t`Budget period`}
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    period: event.target.value as "week" | "month",
                  }))
                }
              >
                <NativeSelectOption value="week">{t`Week`}</NativeSelectOption>
                <NativeSelectOption value="month">{t`Month`}</NativeSelectOption>
              </NativeSelect>
            </label>

            {draft.period === "week" ? (
              <label className="space-y-1.5">
                <SettingLabel source={settings.resetDowSource}>
                  <Trans>Reset day</Trans>
                </SettingLabel>
                <NativeSelect
                  size="sm"
                  value={String(draft.resetDow)}
                  aria-label={t`Reset day of week`}
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      resetDow: Number(event.target.value),
                    }))
                  }
                >
                  <NativeSelectOption value="0">{t`Sunday`}</NativeSelectOption>
                  <NativeSelectOption value="1">{t`Monday`}</NativeSelectOption>
                  <NativeSelectOption value="2">{t`Tuesday`}</NativeSelectOption>
                  <NativeSelectOption value="3">{t`Wednesday`}</NativeSelectOption>
                  <NativeSelectOption value="4">{t`Thursday`}</NativeSelectOption>
                  <NativeSelectOption value="5">{t`Friday`}</NativeSelectOption>
                  <NativeSelectOption value="6">{t`Saturday`}</NativeSelectOption>
                </NativeSelect>
              </label>
            ) : (
              <label className="space-y-1.5">
                <SettingLabel source={settings.resetDomSource}>
                  <Trans>Reset day</Trans>
                </SettingLabel>
                <Input
                  type="number"
                  min={1}
                  max={28}
                  inputMode="numeric"
                  aria-label={t`Reset day of month`}
                  className="tabular-nums"
                  value={draft.resetDom}
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      resetDom: Number(event.target.value) || 1,
                    }))
                  }
                />
              </label>
            )}

            <label className="space-y-1.5">
              <SettingLabel source={settings.resetMinutesSource}>
                <Trans>Reset time</Trans>
              </SettingLabel>
              <Input
                type="time"
                aria-label={t`Reset time`}
                value={draft.resetTime}
                onChange={(event) =>
                  setDraft((current) => ({ ...current, resetTime: event.target.value }))
                }
              />
            </label>

            <label className="space-y-1.5 sm:col-span-2 lg:col-span-1">
              <SettingLabel source={settings.timezoneSource}>
                <Trans>Timezone</Trans>
              </SettingLabel>
              <Input
                aria-label={t`Timezone`}
                value={draft.timezone}
                onChange={(event) =>
                  setDraft((current) => ({ ...current, timezone: event.target.value }))
                }
              />
            </label>

            <label className="space-y-1.5">
              <SettingLabel source={settings.autoEnrollModeSource}>
                <Trans>Auto-enroll</Trans>
              </SettingLabel>
              <NativeSelect
                size="sm"
                value={draft.autoEnrollMode}
                aria-label={t`Auto-enroll mode`}
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    autoEnrollMode: event.target
                      .value as OpsSharedKeyBudgetSettings["autoEnrollMode"],
                  }))
                }
              >
                <NativeSelectOption value="signup">{t`Signup`}</NativeSelectOption>
                <NativeSelectOption value="open">{t`Open`}</NativeSelectOption>
                <NativeSelectOption value="gated">{t`Gated`}</NativeSelectOption>
                <NativeSelectOption value="off">{t`Off`}</NativeSelectOption>
              </NativeSelect>
            </label>

            <div className="space-y-1.5">
              <SettingLabel source={settings.warningThresholdsSource}>
                <Trans>Warnings</Trans>
              </SettingLabel>
              <div className="flex items-center gap-2">
                <Input
                  type="number"
                  min={0}
                  max={99}
                  inputMode="numeric"
                  aria-label={t`First warning threshold`}
                  className="tabular-nums"
                  value={draft.warningLow}
                  onChange={(event) =>
                    setDraft((current) => ({ ...current, warningLow: event.target.value }))
                  }
                />
                <span className="text-muted-foreground" aria-hidden="true">
                  /
                </span>
                <Input
                  type="number"
                  min={1}
                  max={100}
                  inputMode="numeric"
                  aria-label={t`Second warning threshold`}
                  className="tabular-nums"
                  value={draft.warningHigh}
                  onChange={(event) =>
                    setDraft((current) => ({ ...current, warningHigh: event.target.value }))
                  }
                />
              </div>
            </div>

            <label className="space-y-1.5">
              <SettingLabel source={settings.holdStaleMinutesSource}>
                <Trans>Stale hold (min)</Trans>
              </SettingLabel>
              <Input
                type="number"
                min={1}
                max={1440}
                inputMode="numeric"
                aria-label={t`Stale-hold timeout minutes`}
                className="tabular-nums"
                value={draft.holdStaleMinutes}
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    holdStaleMinutes: event.target.value,
                  }))
                }
              />
            </label>
          </div>

          <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center">
            <div className="inline-flex items-center gap-2 text-sm">
              <Switch
                id={hardStopId}
                checked={draft.hardStopEnabled}
                onCheckedChange={(checked) =>
                  setDraft((current) => ({ ...current, hardStopEnabled: checked }))
                }
              />
              <span className="inline-flex items-center gap-1.5">
                <label htmlFor={hardStopId}>
                  <Trans>Hard stop</Trans>
                </label>
                <SourceBadge source={settings.hardStopEnabledSource} />
              </span>
            </div>

            <div className="inline-flex items-center gap-2 text-sm">
              <Switch
                id={pruneId}
                checked={draft.pruneInactive}
                onCheckedChange={(checked) =>
                  setDraft((current) => ({ ...current, pruneInactive: checked }))
                }
              />
              <span className="inline-flex items-center gap-1.5">
                <label htmlFor={pruneId}>
                  <Trans>Prune inactive</Trans>
                </label>
                <SourceBadge source={settings.pruneInactiveSource} />
              </span>
            </div>

            {scheduleChanged(settings, draft) ? (
              <div className="inline-flex items-center gap-2 text-sm">
                <Checkbox
                  id={applyNowId}
                  checked={draft.applyScheduleNow}
                  onCheckedChange={(checked) =>
                    setDraft((current) => ({
                      ...current,
                      applyScheduleNow: checked === true,
                    }))
                  }
                />
                <label htmlFor={applyNowId}>
                  <Trans>Apply schedule now</Trans>
                </label>
              </div>
            ) : null}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              className={buttonVariants({ variant: "outline", size: "sm" })}
              disabled={saving || !dirty}
              onClick={() => void save()}
            >
              {saving ? <Spinner className="size-4" /> : <Trans>Save</Trans>}
            </button>
            <button
              type="button"
              className={buttonVariants({ variant: "ghost", size: "sm" })}
              disabled={saving || !dirty}
              onClick={() => {
                setDraft(draftFromSettings(settings));
                setError(null);
              }}
            >
              <Trans>Reset</Trans>
            </button>
          </div>

          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
        </div>
      </CollapsibleContent>

      <AlertDialog open={confirmApply} onOpenChange={setConfirmApply}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              <Trans>Apply schedule now?</Trans>
            </AlertDialogTitle>
            <AlertDialogDescription>
              <Trans>This starts a new budget period immediately.</Trans>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={saving}>
              <Trans>Cancel</Trans>
            </AlertDialogCancel>
            <AlertDialogAction disabled={saving} onClick={() => void save(true)}>
              <Trans>Apply</Trans>
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Collapsible>
  );
}

function accountLabel(account: Pick<OpsAccount, "name" | "email">): string {
  return account.name || account.email;
}

function SpendAdjustmentsPanel({
  adjustments,
  accounts,
  onChanged,
  interactive,
}: {
  adjustments: OpsSharedKeySpendAdjustment[];
  accounts: OpsOverview["accounts"];
  onChanged: () => void;
  interactive: boolean;
}) {
  const { t } = useLingui();
  const [historyOpen, setHistoryOpen] = useState(false);
  const [mode, setMode] = useState<"set" | "adjust">("adjust");
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reverseTarget, setReverseTarget] = useState<OpsSharedKeySpendAdjustment | null>(null);
  const [reverseReason, setReverseReason] = useState("");

  const accountsById = useMemo(
    () => new Map(accounts.map((account) => [account.userId, account])),
    [accounts],
  );

  async function submitAdjustment() {
    const value = Number(amount);
    if (!Number.isFinite(value)) {
      setError(t`Enter an amount`);
      return;
    }
    if (!reason.trim()) {
      setError(t`Enter a reason`);
      return;
    }
    if (!interactive) {
      setAmount("");
      setReason("");
      setError(null);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      if (mode === "set") {
        await rpc.ops.setSharedKeyTrackedSpend({
          targetUsd: value,
          reason: reason.trim(),
        });
      } else {
        await rpc.ops.adjustSharedKeyTrackedSpend({
          deltaUsd: value,
          reason: reason.trim(),
        });
      }
      setAmount("");
      setReason("");
      onChanged();
    } catch (err) {
      setError(errorText(err, t`Could not adjust tracked spend`));
    } finally {
      setSaving(false);
    }
  }

  async function confirmReverse() {
    if (!reverseTarget) return;
    if (!reverseReason.trim()) {
      setError(t`Enter a reason`);
      return;
    }
    if (!interactive) {
      setReverseTarget(null);
      setReverseReason("");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await rpc.ops.reverseSharedKeySpendAdjustment({
        adjustmentId: reverseTarget.id,
        reason: reverseReason.trim(),
      });
      setReverseTarget(null);
      setReverseReason("");
      onChanged();
    } catch (err) {
      setError(errorText(err, t`Could not reverse adjustment`));
    } finally {
      setSaving(false);
    }
  }

  function whoLabel(row: OpsSharedKeySpendAdjustment): string {
    if (row.createdByName || row.createdByEmail) {
      return row.createdByName || row.createdByEmail || "";
    }
    return row.createdById ?? "—";
  }

  function scopeLabel(row: OpsSharedKeySpendAdjustment): string {
    if (!row.userId) return t`Team`;
    const account = accountsById.get(row.userId);
    return account ? accountLabel(account) : row.userId;
  }

  const reversedIds = useMemo(() => {
    const ids = new Set<string>();
    for (const row of adjustments) {
      if (row.reversesId) ids.add(row.reversesId);
    }
    return ids;
  }, [adjustments]);

  return (
    <section data-testid="ops-spend-adjustments" className="space-y-3">
      <div className="rounded-lg border p-3 sm:p-4">
        <div className="mb-3 text-sm font-medium">
          <Trans>Tracked spend</Trans>
        </div>
        <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-end">
          <label className="space-y-1.5">
            <span className="text-xs text-muted-foreground">
              <Trans>Mode</Trans>
            </span>
            <NativeSelect
              size="sm"
              value={mode}
              aria-label={t`Spend adjustment mode`}
              onChange={(event) => setMode(event.target.value as "set" | "adjust")}
            >
              <NativeSelectOption value="adjust">{t`Adjust by`}</NativeSelectOption>
              <NativeSelectOption value="set">{t`Set to`}</NativeSelectOption>
            </NativeSelect>
          </label>
          <label className="space-y-1.5">
            <span className="text-xs text-muted-foreground">
              <Trans>Amount</Trans>
            </span>
            <div className="flex items-center gap-1">
              <span className="text-muted-foreground" aria-hidden="true">
                $
              </span>
              <Input
                type="number"
                step="any"
                inputMode="decimal"
                aria-label={t`Spend amount`}
                className="w-28 tabular-nums"
                value={amount}
                disabled={saving}
                onChange={(event) => setAmount(event.target.value)}
              />
            </div>
          </label>
          <label className="min-w-0 flex-1 space-y-1.5">
            <span className="text-xs text-muted-foreground">
              <Trans>Reason</Trans>
            </span>
            <Input
              aria-label={t`Spend adjustment reason`}
              value={reason}
              disabled={saving}
              onChange={(event) => setReason(event.target.value)}
            />
          </label>
          <button
            type="button"
            className={buttonVariants({ variant: "outline", size: "sm" })}
            disabled={saving}
            onClick={() => void submitAdjustment()}
          >
            {saving ? <Spinner className="size-4" /> : <Trans>Apply</Trans>}
          </button>
        </div>
        {error && !reverseTarget ? (
          <p role="alert" className="mt-2 text-sm text-destructive">
            {error}
          </p>
        ) : null}
      </div>

      <Collapsible open={historyOpen} onOpenChange={setHistoryOpen} data-testid="ops-spend-history">
        <CollapsibleTrigger
          className={cn(
            buttonVariants({ variant: "ghost", size: "sm" }),
            "inline-flex w-full justify-between gap-2 px-0 sm:w-auto",
          )}
        >
          <Trans>Adjustment history ({adjustments.length})</Trans>
          <ChevronDown
            className={cn("size-4 transition-transform", historyOpen ? "rotate-180" : "")}
            aria-hidden="true"
          />
        </CollapsibleTrigger>
        <CollapsibleContent>
          {adjustments.length === 0 ? (
            <p className="mt-2 text-sm text-muted-foreground">
              <Trans>None yet.</Trans>
            </p>
          ) : (
            <ul className="mt-2 divide-y rounded-lg border">
              {adjustments.map((row) => {
                const reversed = reversedIds.has(row.id);
                return (
                  <li
                    key={row.id}
                    className="flex flex-col gap-2 px-3 py-2 text-sm sm:flex-row sm:items-center sm:justify-between"
                  >
                    <div className="min-w-0 space-y-0.5">
                      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                        <span className="font-medium">{whoLabel(row)}</span>
                        <span className="text-muted-foreground">
                          {new Date(row.createdAt).toLocaleString()}
                        </span>
                        <Badge variant="outline" className="font-normal">
                          {scopeLabel(row)}
                        </Badge>
                        {row.reversesId ? (
                          <Badge variant="secondary" className="font-normal">
                            <Trans>Reversal</Trans>
                          </Badge>
                        ) : null}
                        {reversed ? (
                          <Badge variant="secondary" className="font-normal">
                            <Trans>Reversed</Trans>
                          </Badge>
                        ) : null}
                      </div>
                      <div className="text-muted-foreground">{row.reason}</div>
                      <div className="tabular-nums">
                        {money(row.previousTrackedUsd)} → {money(row.newTrackedUsd)}
                        <span className="ms-2 text-muted-foreground">
                          (
                          {row.deltaUsd > 0 ? "+" : row.deltaUsd < 0 ? "−" : ""}
                          {money(Math.abs(row.deltaUsd))})
                        </span>
                      </div>
                    </div>
                    {!reversed && !row.reversesId ? (
                      <button
                        type="button"
                        className={buttonVariants({ variant: "ghost", size: "sm" })}
                        onClick={() => {
                          setError(null);
                          setReverseReason("");
                          setReverseTarget(row);
                        }}
                      >
                        <Trans>Reverse</Trans>
                      </button>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}
        </CollapsibleContent>
      </Collapsible>

      <AlertDialog
        open={Boolean(reverseTarget)}
        onOpenChange={(next) => {
          if (!next) {
            setReverseTarget(null);
            setReverseReason("");
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              <Trans>Reverse this adjustment?</Trans>
            </AlertDialogTitle>
            <AlertDialogDescription>
              <Trans>
                Appends an opposite delta for {money(reverseTarget?.deltaUsd ?? 0)}.
              </Trans>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <label className="space-y-1.5">
            <span className="text-xs text-muted-foreground">
              <Trans>Reason</Trans>
            </span>
            <Input
              aria-label={t`Reverse reason`}
              value={reverseReason}
              disabled={saving}
              onChange={(event) => setReverseReason(event.target.value)}
            />
          </label>
          {error && reverseTarget ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={saving}>
              <Trans>Cancel</Trans>
            </AlertDialogCancel>
            <AlertDialogAction disabled={saving} onClick={() => void confirmReverse()}>
              <Trans>Reverse</Trans>
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}

/** Dialog helpers used from the accounts roster menu. */
export function MemberOverrideDialog({
  account,
  open,
  onOpenChange,
  interactive,
  onChanged,
}: {
  account: OpsAccount | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  interactive: boolean;
  onChanged: () => void;
}) {
  const { t } = useLingui();
  const [value, setValue] = useState(
    account?.allotmentOverrideUsd != null ? String(account.allotmentOverrideUsd) : "",
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setValue(account?.allotmentOverrideUsd != null ? String(account.allotmentOverrideUsd) : "");
    setError(null);
  }, [account]);

  async function save(clear = false) {
    if (!account) return;
    let weeklyAllotmentUsd: number | null = null;
    if (!clear) {
      const parsed = Number(value);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        setError(t`Enter a positive allotment`);
        return;
      }
      weeklyAllotmentUsd = parsed;
    }
    if (!interactive) {
      onOpenChange(false);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await rpc.ops.setSharedKeyMemberOverride({
        userId: account.userId,
        weeklyAllotmentUsd,
      });
      onOpenChange(false);
      onChanged();
    } catch (err) {
      setError(errorText(err, t`Could not save allotment override`));
    } finally {
      setSaving(false);
    }
  }

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            <Trans>Weekly allotment override</Trans>
          </AlertDialogTitle>
          <AlertDialogDescription>
            {account ? accountLabel(account) : null}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <label className="flex items-center gap-1 text-sm">
          <span className="text-muted-foreground" aria-hidden="true">
            $
          </span>
          <Input
            type="number"
            min={0.01}
            step="any"
            inputMode="decimal"
            aria-label={t`Weekly allotment override`}
            className="tabular-nums"
            value={value}
            disabled={saving}
            onChange={(event) => setValue(event.target.value)}
          />
        </label>
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={saving}>
            <Trans>Cancel</Trans>
          </AlertDialogCancel>
          {account?.allotmentOverrideUsd != null ? (
            <AlertDialogAction disabled={saving} onClick={() => void save(true)}>
              <Trans>Clear</Trans>
            </AlertDialogAction>
          ) : null}
          <AlertDialogAction disabled={saving} onClick={() => void save(false)}>
            <Trans>Save</Trans>
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export function RemoveMemberDialog({
  account,
  open,
  onOpenChange,
  interactive,
  onChanged,
}: {
  account: OpsAccount | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  interactive: boolean;
  onChanged: () => void;
}) {
  const { t } = useLingui();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function confirm() {
    if (!account) return;
    if (!interactive) {
      onOpenChange(false);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await rpc.ops.removeSharedKeyBudgetMember({ userId: account.userId });
      onOpenChange(false);
      onChanged();
    } catch (err) {
      setError(errorText(err, t`Could not remove member`));
    } finally {
      setSaving(false);
    }
  }

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            <Trans>Remove from shared budget?</Trans>
          </AlertDialogTitle>
          <AlertDialogDescription>
            {account ? (
              <Trans>Remove {accountLabel(account)} from the roster.</Trans>
            ) : null}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={saving}>
            <Trans>Cancel</Trans>
          </AlertDialogCancel>
          <AlertDialogAction disabled={saving} onClick={() => void confirm()}>
            <Trans>Remove</Trans>
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export function UserSpendAdjustDialog({
  account,
  open,
  onOpenChange,
  interactive,
  onChanged,
}: {
  account: OpsAccount | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  interactive: boolean;
  onChanged: () => void;
}) {
  const { t } = useLingui();
  const [mode, setMode] = useState<"set" | "adjust">("adjust");
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setMode("adjust");
    setAmount("");
    setReason("");
    setError(null);
  }, [account]);

  async function submit() {
    if (!account) return;
    const value = Number(amount);
    if (!Number.isFinite(value)) {
      setError(t`Enter an amount`);
      return;
    }
    if (!reason.trim()) {
      setError(t`Enter a reason`);
      return;
    }
    if (!interactive) {
      onOpenChange(false);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      if (mode === "set") {
        await rpc.ops.setSharedKeyTrackedSpend({
          targetUsd: value,
          reason: reason.trim(),
          userId: account.userId,
        });
      } else {
        await rpc.ops.adjustSharedKeyTrackedSpend({
          deltaUsd: value,
          reason: reason.trim(),
          userId: account.userId,
        });
      }
      onOpenChange(false);
      onChanged();
    } catch (err) {
      setError(errorText(err, t`Could not adjust tracked spend`));
    } finally {
      setSaving(false);
    }
  }

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            <Trans>Adjust tracked spend</Trans>
          </AlertDialogTitle>
          <AlertDialogDescription>
            {account ? accountLabel(account) : null}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="space-y-3">
          <label className="space-y-1.5">
            <span className="text-xs text-muted-foreground">
              <Trans>Mode</Trans>
            </span>
            <NativeSelect
              size="sm"
              value={mode}
              aria-label={t`Spend adjustment mode`}
              onChange={(event) => setMode(event.target.value as "set" | "adjust")}
            >
              <NativeSelectOption value="adjust">{t`Adjust by`}</NativeSelectOption>
              <NativeSelectOption value="set">{t`Set to`}</NativeSelectOption>
            </NativeSelect>
          </label>
          <label className="flex items-center gap-1 text-sm">
            <span className="text-muted-foreground" aria-hidden="true">
              $
            </span>
            <Input
              type="number"
              step="any"
              inputMode="decimal"
              aria-label={t`Spend amount`}
              className="tabular-nums"
              value={amount}
              disabled={saving}
              onChange={(event) => setAmount(event.target.value)}
            />
          </label>
          <label className="space-y-1.5">
            <span className="text-xs text-muted-foreground">
              <Trans>Reason</Trans>
            </span>
            <Input
              aria-label={t`Spend adjustment reason`}
              value={reason}
              disabled={saving}
              onChange={(event) => setReason(event.target.value)}
            />
          </label>
        </div>
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={saving}>
            <Trans>Cancel</Trans>
          </AlertDialogCancel>
          <AlertDialogAction disabled={saving} onClick={() => void submit()}>
            <Trans>Apply</Trans>
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
