import type { ModelCatalogEntry } from "@rakazo/contracts";
import { Badge } from "@rakazo/ui-web";
import { ModelLabel, modelBadgeClassName, resolveModelDisplay } from "./model-label";

export function ModelBadge({
  provider,
  modelId,
  source,
  catalog = [],
}: {
  provider: string | null | undefined;
  modelId: string | null | undefined;
  source?: string | null;
  catalog?: ModelCatalogEntry[];
}) {
  const display = resolveModelDisplay(provider, modelId, catalog);
  if (!display) {
    return <span className="text-muted-foreground">—</span>;
  }
  const title = source ? `${display.raw} · ${source}` : display.raw;
  return (
    <Badge variant="outline" className={modelBadgeClassName} title={title}>
      <ModelLabel
        name={display.name}
        providerName={display.providerName}
        className="max-w-full gap-1 text-xs font-normal"
      />
    </Badge>
  );
}
