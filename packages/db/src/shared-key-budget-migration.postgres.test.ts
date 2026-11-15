import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { deployMigrations } from "./deferred-migrations.js";

const databaseUrl = process.env.DATABASE_MIGRATION_URL ?? process.env.DATABASE_URL;
const dbTests = process.env.VERIFY_DATABASE && databaseUrl ? describe.sequential : describe.skip;
const dbPackageDir = fileURLToPath(new URL("..", import.meta.url));
const MIGRATION = "20261215120000_shared_key_budget_ops_settings";

dbTests("shared-key budget ops settings migration", () => {
  const stamp = `${process.pid}_${Date.now()}`;
  const schema = `shared_key_budget_ops_${stamp}`;
  const dir = mkdtempSync(path.join(tmpdir(), "shared-key-budget-ops-"));
  let client: Client;

  beforeAll(async () => {
    cpSync(path.join(dbPackageDir, "prisma/migrations"), dir, { recursive: true });
    client = new Client({ connectionString: databaseUrl });
    await client.connect();
    await client.query(`CREATE SCHEMA "${schema}"`);
  });

  afterAll(async () => {
    await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await client
      .query("DELETE FROM _prisma_migrations WHERE migration_name = $1", [MIGRATION])
      .catch(() => undefined);
    await client.end();
    rmSync(dir, { recursive: true, force: true });
  });

  it("applies on a copy of the current schema", async () => {
    const url = new URL(databaseUrl!);
    url.searchParams.set("schema", schema);
    await deployMigrations({
      migrationUrl: url.toString(),
      dbPackageDir,
      migrationsDir: dir,
    });
    const { rows: columns } = await client.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = $1 AND table_name = 'deployment_settings'
         AND column_name LIKE 'sharedKey%'
       ORDER BY 1`,
      [schema],
    );
    expect(columns.map((row) => row.column_name)).toEqual(
      expect.arrayContaining([
        "sharedKeyMonthlyBudgetUsd",
        "sharedKeyPeriod",
        "sharedKeyResetDow",
        "sharedKeyResetDom",
        "sharedKeyResetMinutes",
        "sharedKeyTimezone",
        "sharedKeyActivePeriodStart",
        "sharedKeyAutoEnrollMode",
        "sharedKeyWarningThresholds",
        "sharedKeyHardStopEnabled",
        "sharedKeyHoldStaleMinutes",
        "sharedKeyPruneInactive",
      ]),
    );
    const { rows: tables } = await client.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = $1
         AND table_name IN ('shared_key_spend_adjustments', 'shared_key_member_overrides')
       ORDER BY 1`,
      [schema],
    );
    expect(tables.map((row) => row.table_name)).toEqual([
      "shared_key_member_overrides",
      "shared_key_spend_adjustments",
    ]);
  });
});
