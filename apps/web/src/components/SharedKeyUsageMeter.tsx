import { Trans, useLingui } from "@lingui/react/macro";
import type { UsageLimit } from "@rakazo/contracts";
import { formatSharedKeyBudgetResetAt } from "@rakazo/core";
import {
  Context,
  ContextContent,
  ContextContentBody,
  ContextContentFooter,
  ContextContentHeader,
  ContextTrigger,
  ContextUsageBar,
  ContextUsageBreakdown,
} from "./ai/context";

/**
 * Account-menu usage meter: spent + reserved against the weekly cap, reset time,
 * and a blocked notice when new runs cannot start. Never shows dollars.
 * Follows the AI Elements Context trigger + hover-card structure.
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
  const usedPercent = Math.min(100, Math.max(0, Math.floor(usedRaw)));
  const spentPercent = Math.min(100, Math.max(0, Math.floor(spentRaw)));
  const reservedPercent = Math.min(100, Math.max(0, Math.floor(reservedRaw)));
  const status = limit.status ?? "ok";
  const blocked = status === "blocked";
  const warning = status === "warning";
  const reset = formatSharedKeyBudgetResetAt(limit.resetsAt, i18n.locale || "en-US");
  const tone = blocked ? "text-destructive" : warning ? "text-warning" : "text-foreground";

  return (
    <Context
      usedPercent={usedPercent}
      spentPercent={spentPercent}
      reservedPercent={reservedPercent}
      resetLabel={reset}
      blocked={blocked}
      warning={warning}
      className={`space-y-1.5 px-2.5 py-2 ${className}`}
    >
      <div data-testid="shared-key-usage-meter" className="space-y-1.5">
        <div className="flex items-baseline justify-between gap-2 text-[12.5px]">
          <ContextTrigger className="min-w-0">
            <span className={`tabular-nums ${tone}`}>{usedPercent}%</span>
          </ContextTrigger>
          <span className="min-w-0 truncate text-muted-foreground">
            <Trans>Resets {reset}</Trans>
          </span>
        </div>
        <ContextUsageBar />
        <ContextContentFooter />
      </div>
      <ContextContent>
        <ContextContentHeader />
        <ContextContentBody>
          <ContextUsageBreakdown />
        </ContextContentBody>
      </ContextContent>
    </Context>
  );
}
