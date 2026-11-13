import { Trans, useLingui } from "@lingui/react/macro";
import type { UsageLimit } from "@rakazo/contracts";
import { formatSharedKeyBudgetResetAt } from "@rakazo/core";

/**
 * Grok-style usage meter for the account menu: percent of shared weekly limit plus
 * reset time, or a personal-key note. Never shows dollars.
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
  const percent = Math.round(limit.percentUsed);
  const reset = formatSharedKeyBudgetResetAt(limit.resetsAt, i18n.locale || "en-US");
  return (
    <div data-testid="shared-key-usage-meter" className={`space-y-1.5 px-2.5 py-2 ${className}`}>
      <div className="flex items-baseline justify-between gap-2 text-[12.5px]">
        <span className="tabular-nums text-foreground">{percent}%</span>
        <span className="min-w-0 truncate text-muted-foreground">
          <Trans>Resets {reset}</Trans>
        </span>
      </div>
      <div
        className="h-1.5 overflow-hidden rounded-full bg-muted"
        role="progressbar"
        aria-valuenow={percent}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={`${percent}%`}
      >
        <div
          className="h-full rounded-full bg-foreground transition-[width]"
          style={{ width: `${Math.min(100, Math.max(0, percent))}%` }}
        />
      </div>
    </div>
  );
}
