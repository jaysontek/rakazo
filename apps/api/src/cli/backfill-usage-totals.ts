// `docker compose exec api node dist/cli/backfill-usage-totals.js [--dry-run] [--limit N]`:
// idempotent fill of null totalTokens / catalog costUsd from stored buckets + pricingSnapshot.
// Dry-run only prints counts. Do not run against production without an explicit operator review.
import { parseArgs } from "node:util";
import { contentKeyProviderFromEnv, unwrapEnvFromKeyManager } from "@rakazo/adapters";
import { createDb, runAsSystem } from "@rakazo/db";
import { backfillUsageTotals } from "../backfill-usage-totals.js";
import { loadEnv } from "../env.js";

const USAGE = `Usage: backfill-usage-totals [--dry-run] [--limit N]

Recomputes null totalTokens and catalog costUsd on usage_records from stored
input/output/(cache??0) buckets and pricingSnapshot. Leaves provider-reported
costs alone. Idempotent: rows that already have totals/costs are skipped.

  --dry-run   Count rows that would be updated; write nothing.
  --limit N   Max rows to scan (default 10000).

Example (compose):
  docker compose exec api node dist/cli/backfill-usage-totals.js --dry-run
`;

const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  options: {
    "dry-run": { type: "boolean" },
    limit: { type: "string" },
    help: { type: "boolean", short: "h" },
  },
  allowPositionals: true,
});

if (positionals.length > 0 || values.help) {
  process.stderr.write(USAGE);
  process.exit(positionals.length > 0 ? 2 : 0);
}

const limitRaw = values.limit;
const limit = limitRaw === undefined ? 10_000 : Number(limitRaw);
if (!Number.isSafeInteger(limit) || limit < 1) {
  process.stderr.write("--limit must be a positive integer\n");
  process.exit(2);
}

await unwrapEnvFromKeyManager();
const env = loadEnv();
const dryRun = values["dry-run"] === true;
const { prisma, pool } = createDb(env.databaseUrl, {
  keyProvider: contentKeyProviderFromEnv(),
});

try {
  const result = await runAsSystem("backfill usage totals", () =>
    backfillUsageTotals(prisma, { dryRun, limit }),
  );
  process.stdout.write(
    `${[
      dryRun ? "dry-run" : "backfill",
      `scanned=${result.scanned}`,
      `wouldTouch=${result.wouldTouch}`,
      `updated=${result.updated}`,
      `skipped=${result.skipped}`,
    ].join(" ")}\n`,
  );
} finally {
  await prisma.$disconnect();
  await pool.end();
}
