import { Trans, useLingui } from "@lingui/react/macro";
import type { UsageLimit } from "@rakazo/contracts";
import { formatSharedKeyBudgetResetAt } from "@rakazo/core";

/**
 * Account-menu usage meter: spent + reserved against the weekly cap, reset time,
 * and a blocked notice when new runs cannot start. Never shows dollars.
 */
export function SharedKeyUsageMeter({
  limit,
  className = "",
}: {
  limit: UsageLimit | null | undefined;
  className?: string;
}) {
  const { i18n } = useLingui();
  if (!limit || limit.kind === "none") return null;
  if (limit.kind === "personal_key") {
    return (
      <p
        data-testid="shared-key-usage-personal"
        className={`px-2.5 py-2 text-[12.5px] text-muted-foreground ${className}`}
      >
        <Trans>Using your own API key, no shared limit</Trans>
      </p>
    );
  }
  const usedRaw = limit.usedPercent ?? limit.percentUsed;
  const reservedRaw = limit.reservedPercent ?? 0;
  const spentRaw = limit.spentPercent ?? Math.max(0, usedRaw - reservedRaw);
  // Floor so 99.5% never displays as 100% while still showing 100 when exhausted.
  const usedPercent = Math.min(100, Math.floor(usedRaw));
  const spentPercent = Math.min(100, Math.floor(spentRaw));
  const reservedPercent = Math.min(100, Math.max(0, Math.floor(reservedRaw)));
  const status = limit.status ?? "ok";
  const blocked = status === "blocked";
  const warning = status === "warning";
  const reset = formatSharedKeyBudgetResetAt(limit.resetsAt, i18n.locale || "en-US");
  const tone = blocked ? "text-destructive" : warning ? "text-warning" : "text-foreground";
  const spentFill = blocked ? "bg-destructive" : warning ? "bg-warning" : "bg-foreground";
  const reservedFill = blocked
    ? "bg-destructive/50"
    : warning
      ? "bg-warning/50"
      : "bg-muted-foreground/50";

  return (
    <div data-testid="shared-key-usage-meter" className={`space-y-1.5 px-2.5 py-2 ${className}`}>
      <div className="flex items-baseline justify-between gap-2 text-[12.5px]">
        <span className={`tabular-nums ${tone}`}>{usedPercent}%</span>
        <span className="min-w-0 truncate text-muted-foreground">
          <Trans>Resets {reset}</Trans>
        </span>
      </div>
      <div
        className="flex h-1.5 overflow-hidden rounded-full bg-muted"
        role="progressbar"
        aria-valuenow={usedPercent}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={`${usedPercent}%`}
      >
        <div
          className={`h-full ${spentFill} transition-[width]`}
          style={{ width: `${Math.min(100, Math.max(0, spentPercent))}%` }}
        />
        {reservedPercent > 0 ? (
          <div
            data-testid="shared-key-usage-reserved"
            className={`h-full ${reservedFill} transition-[width]`}
            style={{ width: `${Math.min(100 - spentPercent, reservedPercent)}%` }}
          />
        ) : null}
      </div>
      {blocked ? (
        <p data-testid="shared-key-usage-blocked" className="text-[12.5px] text-destructive">
          <Trans>Weekly limit reached for new runs · Resets {reset}</Trans>
        </p>
      ) : null}
    </div>
  );
}
