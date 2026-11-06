import { estimateCatalogCostUsd } from "@rakazo/adapters";

type UsageRow = {
  id: string;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  cacheWrite1hTokens: number | null;
  totalTokens: number | null;
  costUsd: number | null;
  costSource: string | null;
  pricingVersion: string | null;
  pricingSnapshot: unknown;
};

type CatalogCost = NonNullable<Parameters<typeof estimateCatalogCostUsd>[0]>;

export type UsageTotalsPatch = {
  totalTokens?: number;
  costUsd?: number;
  costSource?: string;
  pricingVersion?: string;
};

type UsageTotalsStore = {
  usageRecord: {
    findMany: (args: object) => Promise<UsageRow[]>;
    update: (args: { where: { id: string }; data: UsageTotalsPatch }) => Promise<unknown>;
  };
};

/** Idempotent patch for null totalTokens / costUsd from stored buckets + pricingSnapshot. */
export function usageTotalsPatch(row: UsageRow): UsageTotalsPatch | null {
  if (row.inputTokens === null || row.outputTokens === null) return null;
  const patch: UsageTotalsPatch = {};
  if (row.totalTokens === null) {
    const derived =
      row.inputTokens + row.outputTokens + (row.cacheReadTokens ?? 0) + (row.cacheWriteTokens ?? 0);
    if (!Number.isSafeInteger(derived)) return null;
    patch.totalTokens = derived;
  }
  if (row.costUsd === null) {
    const snapshot = row.pricingSnapshot;
    if (!snapshot || typeof snapshot !== "object") {
      return Object.keys(patch).length > 0 ? patch : null;
    }
    const estimated = estimateCatalogCostUsd(snapshot as CatalogCost, {
      inputTokens: row.inputTokens,
      outputTokens: row.outputTokens,
      cacheReadTokens: row.cacheReadTokens,
      cacheWriteTokens: row.cacheWriteTokens,
      cacheWrite1hTokens: row.cacheWrite1hTokens,
    });
    if (estimated === null) return Object.keys(patch).length > 0 ? patch : null;
    patch.costUsd = estimated;
    patch.costSource = "pi-catalog-estimate";
    patch.pricingVersion = "pi-ai-1.3.0";
  }
  return Object.keys(patch).length > 0 ? patch : null;
}

export type BackfillUsageTotalsResult = {
  scanned: number;
  wouldTouch: number;
  updated: number;
  skipped: number;
};

/**
 * Fill null totalTokens / catalog costUsd on historical usage rows.
 * Never invents cost when pricingSnapshot is missing; leaves provider-reported costs alone.
 */
export async function backfillUsageTotals(
  prisma: UsageTotalsStore,
  options: { dryRun?: boolean; limit?: number } = {},
): Promise<BackfillUsageTotalsResult> {
  const dryRun = options.dryRun === true;
  const limit = options.limit ?? 10_000;
  const rows = await prisma.usageRecord.findMany({
    where: {
      OR: [{ totalTokens: null }, { costUsd: null }],
      inputTokens: { not: null },
      outputTokens: { not: null },
    },
    take: limit,
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      inputTokens: true,
      outputTokens: true,
      cacheReadTokens: true,
      cacheWriteTokens: true,
      cacheWrite1hTokens: true,
      totalTokens: true,
      costUsd: true,
      costSource: true,
      pricingVersion: true,
      pricingSnapshot: true,
    },
  });
  let wouldTouch = 0;
  let updated = 0;
  let skipped = 0;
  for (const row of rows) {
    const patch = usageTotalsPatch(row);
    if (!patch) {
      skipped += 1;
      continue;
    }
    wouldTouch += 1;
    if (dryRun) continue;
    await prisma.usageRecord.update({ where: { id: row.id }, data: patch });
    updated += 1;
  }
  return { scanned: rows.length, wouldTouch, updated: dryRun ? 0 : updated, skipped };
}
