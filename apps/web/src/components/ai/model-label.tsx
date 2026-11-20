import type { ModelCatalogEntry } from "@rakazo/contracts";
import { cn } from "@rakazo/ui-web";
import type { ReactNode } from "react";
import { providerDisplayName } from "../../lib/localized-provider-hint";

/**
 * Model Selector / Message display pattern: friendly model name with provider,
 * raw provider/modelId kept in title (or secondary text).
 */

export type ResolvedModelDisplay = {
  name: string;
  providerName: string;
  raw: string;
};

/** Turn slug-like ids into a short readable label when the catalog has no entry. */
export function humanizeModelId(modelId: string): string {
  return modelId
    .split(/[/:_-]+/)
    .filter(Boolean)
    .map((part) => {
      if (/^\d+(\.\d+)*$/.test(part)) return part;
      if (/^gpt$/i.test(part)) return "GPT";
      if (/^o\d/i.test(part)) return part.toUpperCase();
      return part.charAt(0).toUpperCase() + part.slice(1);
    })
    .join(" ");
}

export function resolveModelDisplay(
  provider: string | null | undefined,
  modelId: string | null | undefined,
  catalog: ModelCatalogEntry[] = [],
): ResolvedModelDisplay | null {
  if (!provider || !modelId) return null;
  const entry =
    catalog.find((row) => row.provider === provider && row.id === modelId) ??
    catalog.find(
      (row) =>
        row.provider === provider &&
        (row.id.endsWith(`/${modelId}`) || row.id.endsWith(`:${modelId}`)),
    );
  const name = entry?.label ?? humanizeModelId(modelId);
  const providerName = providerDisplayName(provider, entry?.providerName ?? provider);
  return { name, providerName, raw: `${provider}/${modelId}` };
}

export function ModelLabel({
  name,
  providerName,
  raw,
  secondary,
  className,
}: {
  name: string;
  providerName: string;
  raw?: string;
  secondary?: ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cn("inline-flex min-w-0 max-w-full items-baseline gap-1.5", className)}
      title={raw}
    >
      <span className="min-w-0 truncate font-medium">{name}</span>
      <span className="min-w-0 truncate text-muted-foreground">{providerName}</span>
      {secondary ? (
        <span className="min-w-0 truncate text-muted-foreground">{secondary}</span>
      ) : null}
    </span>
  );
}

/** Badge-friendly classes so long model labels ellipsize instead of clipping mid-glyph. */
export const modelBadgeClassName =
  "max-w-[12rem] min-w-0 shrink justify-start truncate font-normal";
