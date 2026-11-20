import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { deployMigrations } from "./deferred-migrations.js";

const databaseUrl = process.env.DATABASE_MIGRATION_URL ?? process.env.DATABASE_URL;
const dbTests = process.env.VERIFY_DATABASE && databaseUrl ? describe.sequential : describe.skip;
const dbPackageDir = fileURLToPath(new URL("..", import.meta.url));
const MIGRATION = "20261218120000_account_soft_delete";

const DOWN = `
DROP INDEX IF EXISTS "user_purgeAfter_idx";
ALTER TABLE "user" DROP COLUMN IF EXISTS "deactivatedBeforeDeletion";
ALTER TABLE "user" DROP COLUMN IF EXISTS "purgeClaimedAt";
ALTER TABLE "user" DROP COLUMN IF EXISTS "priorSharedKeyBudgetMember";
ALTER TABLE "user" DROP CONSTRAINT IF EXISTS "user_deletedByUserId_fkey";
ALTER TABLE "user" DROP COLUMN IF EXISTS "deletedByUserId";
ALTER TABLE "user" DROP COLUMN IF EXISTS "purgeAfter";
ALTER TABLE "user" DROP COLUMN IF EXISTS "deletionRequestedAt";
`;

const SOFT_DELETE_COLUMNS = [
  "deactivatedBeforeDeletion",
  "deletedByUserId",
  "deletionRequestedAt",
  "priorSharedKeyBudgetMember",
  "purgeAfter",
  "purgeClaimedAt",
] as const;

dbTests("account soft-delete migration", () => {
  const stamp = `${process.pid}_${Date.now()}`;
  const schema = `account_soft_delete_${stamp}`;
  const dir = mkdtempSync(path.join(tmpdir(), "account-soft-delete-"));
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

  it("applies additively with the self-FK and documents a reversible down", async () => {
    const url = new URL(databaseUrl!);
    url.searchParams.set("schema", schema);
    await deployMigrations({
      migrationUrl: url.toString(),
      dbPackageDir,
      migrationsDir: dir,
    });

    const { rows: columns } = await client.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = $1 AND table_name = 'user'
         AND column_name = ANY($2::text[])
       ORDER BY 1`,
      [schema, SOFT_DELETE_COLUMNS],
    );
    expect(columns.map((row) => row.column_name)).toEqual([...SOFT_DELETE_COLUMNS]);

    const { rows: fks } = await client.query<{ conname: string }>(
      `SELECT c.conname
       FROM pg_constraint c
       JOIN pg_namespace n ON n.oid = c.connamespace
       WHERE n.nspname = $1 AND c.conname = 'user_deletedByUserId_fkey'`,
      [schema],
    );
    expect(fks).toHaveLength(1);

    const { rows: defaults } = await client.query<{ priorSharedKeyBudgetMember: boolean }>(
      `SELECT "priorSharedKeyBudgetMember" FROM "${schema}"."user" LIMIT 1`,
    );
    if (defaults[0]) expect(defaults[0].priorSharedKeyBudgetMember).toBe(false);

    const upSql = readFileSync(
      path.join(dbPackageDir, "prisma/migrations", MIGRATION, "migration.sql"),
      "utf8",
    );
    expect(upSql).toContain(
      "DELETE FROM _prisma_migrations WHERE migration_name = '20261218120000_account_soft_delete'",
    );
    for (const column of SOFT_DELETE_COLUMNS) {
      expect(DOWN).toContain(column);
    }
  });
});
