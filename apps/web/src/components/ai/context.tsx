"use client";

import { Trans } from "@lingui/react/macro";
import {
  Button,
  cn,
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
  Progress,
  ProgressIndicator,
  ProgressTrack,
} from "@rakazo/ui-web";
import type { ComponentProps, ReactNode } from "react";
import { createContext, useContext, useMemo } from "react";

/**
 * AI Elements Context pattern adapted for shared-key budget: spent + reserved
 * against the weekly cap, with reset time. Built on Hover Card + Progress.
 * No tokenlens — dollars stay out of the account-menu meter.
 */

type BudgetContextValue = {
  usedPercent: number;
  spentPercent: number;
  reservedPercent: number;
  resetLabel: string;
  blocked: boolean;
  warning: boolean;
};

const BudgetContext = createContext<BudgetContextValue | null>(null);

function useBudgetContext() {
  const value = useContext(BudgetContext);
  if (!value) throw new Error("Context parts must be used within Context");
  return value;
}

export type ContextProps = {
  usedPercent: number;
  spentPercent: number;
  reservedPercent: number;
  resetLabel: string;
  blocked?: boolean;
  warning?: boolean;
  children: ReactNode;
  className?: string;
};

export function Context({
  usedPercent,
  spentPercent,
  reservedPercent,
  resetLabel,
  blocked = false,
  warning = false,
  children,
  className,
}: ContextProps) {
  const value = useMemo(
    () => ({
      usedPercent,
      spentPercent,
      reservedPercent,
      resetLabel,
      blocked,
      warning,
    }),
    [usedPercent, spentPercent, reservedPercent, resetLabel, blocked, warning],
  );
  return (
    <BudgetContext.Provider value={value}>
      <HoverCard>
        <div className={className}>{children}</div>
      </HoverCard>
    </BudgetContext.Provider>
  );
}

export type ContextTriggerProps = ComponentProps<typeof HoverCardTrigger> & {
  className?: string;
};

export function ContextTrigger({ className, children, ...props }: ContextTriggerProps) {
  const { usedPercent, blocked, warning } = useBudgetContext();
  const tone = blocked ? "text-destructive" : warning ? "text-warning" : "text-foreground";
  return (
    <HoverCardTrigger
      delay={10}
      closeDelay={100}
      render={<Button variant="ghost" size="sm" className={cn("h-auto px-0", className)} />}
      {...props}
    >
      {children ?? <span className={cn("tabular-nums text-[12.5px]", tone)}>{usedPercent}%</span>}
    </HoverCardTrigger>
  );
}

export type ContextContentProps = ComponentProps<typeof HoverCardContent>;

export function ContextContent({ className, ...props }: ContextContentProps) {
  return <HoverCardContent className={cn("flex w-64 flex-col gap-3", className)} {...props} />;
}

export function ContextContentHeader({ className, ...props }: ComponentProps<"div">) {
  const { usedPercent, resetLabel } = useBudgetContext();
  return (
    <div className={cn("flex items-center justify-between gap-3 text-sm", className)} {...props}>
      <span className="font-medium tabular-nums">{usedPercent}%</span>
      <span className="min-w-0 truncate text-muted-foreground">
        <Trans>Resets {resetLabel}</Trans>
      </span>
    </div>
  );
}

export function ContextContentBody({ className, children, ...props }: ComponentProps<"div">) {
  return (
    <div className={cn("flex flex-col gap-2", className)} {...props}>
      {children}
    </div>
  );
}

/** Compact dual-fill bar for the always-visible meter surface. */
export function ContextUsageBar({ className }: { className?: string }) {
  const { usedPercent, spentPercent, reservedPercent, blocked, warning } = useBudgetContext();
  const spentFill = blocked ? "bg-destructive" : warning ? "bg-warning" : "bg-foreground";
  const reservedFill = blocked
    ? "bg-destructive/50"
    : warning
      ? "bg-warning/50"
      : "bg-muted-foreground/50";
  const spentWidth = Math.min(100, Math.max(0, spentPercent));
  const reservedWidth = Math.min(100 - spentWidth, Math.max(0, reservedPercent));

  return (
    <div
      className={cn("flex h-1.5 overflow-hidden rounded-full bg-muted", className)}
      role="progressbar"
      aria-valuenow={usedPercent}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label={`${usedPercent}%`}
    >
      <div className={cn("h-full", spentFill)} style={{ width: `${spentWidth}%` }} />
      {reservedWidth > 0 ? (
        <div
          data-testid="shared-key-usage-reserved"
          className={cn("h-full", reservedFill)}
          style={{ width: `${reservedWidth}%` }}
        />
      ) : null}
    </div>
  );
}

/** Hover-card breakdown: Progress + spent/held rows (AI Elements Context body). */
export function ContextUsageBreakdown({ className }: { className?: string }) {
  const { usedPercent, spentPercent, reservedPercent } = useBudgetContext();
  return (
    <div className={cn("flex flex-col gap-2", className)}>
      <Progress value={usedPercent} className="w-full gap-0" aria-label={`${usedPercent}%`}>
        <ProgressTrack className="h-1.5">
          <ProgressIndicator />
        </ProgressTrack>
      </Progress>
      <div className="flex flex-col gap-1 text-sm">
        <div className="flex justify-between gap-3">
          <span className="text-muted-foreground">
            <Trans>Spent</Trans>
          </span>
          <span className="tabular-nums">{spentPercent}%</span>
        </div>
        {reservedPercent > 0 ? (
          <div className="flex justify-between gap-3">
            <span className="text-muted-foreground">
              <Trans>Held</Trans>
            </span>
            <span className="tabular-nums">{reservedPercent}%</span>
          </div>
        ) : null}
      </div>
    </div>
  );
}

export function ContextContentFooter({ className, ...props }: ComponentProps<"div">) {
  const { resetLabel, blocked } = useBudgetContext();
  if (!blocked) return null;
  return (
    <p
      data-testid="shared-key-usage-blocked"
      className={cn("text-[12.5px] text-destructive", className)}
      {...props}
    >
      <Trans>Weekly limit reached for new runs · Resets {resetLabel}</Trans>
    </p>
  );
}
