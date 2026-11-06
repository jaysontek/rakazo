// `docker compose exec api node dist/cli/backfill-voice.js [--dry-run]`:
// one-time idempotent provision of the operator's default self-hosted voice
// connection for active accounts that have none. Dry-run only prints counts.
import { parseArgs } from "node:util";
import {
  contentKeyProviderFromEnv,
  createSecretStore,
  resolveDefaultVoiceConfig,
  unwrapEnvFromKeyManager,
} from "@rakazo/adapters";
import { createDb, runAsSystem } from "@rakazo/db";
import { loadEnv } from "../env.js";
import { backfillDefaultVoice } from "../provision-default-voice.js";

const USAGE = `Usage: backfill-voice [--dry-run]

Provisions the self-hosted voice defaults from RAKAZO_DEFAULT_VOICE_* for active
accounts that have no voice connection yet. Skips accounts that already have one.

  --dry-run   Count accounts that would be touched; write nothing.
`;

const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  options: { "dry-run": { type: "boolean" }, help: { type: "boolean", short: "h" } },
  allowPositionals: true,
});

if (positionals.length > 0 || values.help) {
  process.stderr.write(USAGE);
  process.exit(positionals.length > 0 ? 2 : 0);
}

await unwrapEnvFromKeyManager();
const env = loadEnv();
const config = resolveDefaultVoiceConfig();
if (!config) {
  process.stderr.write(
    "RAKAZO_DEFAULT_VOICE_BASE_URL is unset; nothing to provision. See .env.example.\n",
  );
  process.exit(2);
}

const dryRun = values["dry-run"] === true;
const { prisma, pool } = createDb(env.databaseUrl, {
  keyProvider: contentKeyProviderFromEnv(),
});
const secrets = createSecretStore(env.encryptionKey, process.env);
await secrets.start();

try {
  const result = await runAsSystem("backfill default voice", () =>
    backfillDefaultVoice(
      { prisma, secrets, allowPrivateEndpoint: env.mcpAllowPrivateEndpoint },
      { dryRun },
    ),
  );
  const touchLabel = dryRun ? "wouldTouch" : "provisioned";
  const touchCount = dryRun ? result.wouldTouch : result.provisioned;
  process.stdout.write(
    `${[
      dryRun ? "dry-run" : "backfill",
      `scanned=${result.scanned}`,
      `${touchLabel}=${touchCount}`,
      `skippedAlreadySet=${result.skippedAlreadySet}`,
      `skippedNoSpace=${result.skippedNoSpace}`,
      `failed=${result.failed}`,
    ].join(" ")}\n`,
  );
  if (result.failed > 0) process.exitCode = 1;
} finally {
  await secrets.close();
  await prisma.$disconnect();
  await pool.end();
}
