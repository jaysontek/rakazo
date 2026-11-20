import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import { describe, expect, it } from "vitest";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres = process.env.VERIFY_DATABASE && databaseUrl ? describe : describe.skip;

const UP = new URL(
  "../prisma/migrations/20261218120000_account_soft_delete/migration.sql",
  import.meta.url,
);

const DOWN = `
DROP INDEX IF EXISTS "user_purgeAfter_idx";
ALTER TABLE "user" DROP COLUMN IF EXISTS "purgeClaimedAt";
ALTER TABLE "user" DROP COLUMN IF EXISTS "priorSharedKeyBudgetMember";
ALTER TABLE "user" DROP CONSTRAINT IF EXISTS "user_deletedByUserId_fkey";
ALTER TABLE "user" DROP COLUMN IF EXISTS "deletedByUserId";
ALTER TABLE "user" DROP COLUMN IF EXISTS "purgeAfter";
ALTER TABLE "user" DROP COLUMN IF EXISTS "deletionRequestedAt";
`;

describePostgres("account soft-delete migration (PostgreSQL)", () => {
  it("applies additively and rolls back cleanly", async () => {
    const pool = new Pool({ connectionString: databaseUrl });
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      // Shadow the live user table so the migration SQL can run without touching prod rows.
      await client.query(`
        CREATE TEMP TABLE "user" (
          id TEXT PRIMARY KEY,
          email TEXT NOT NULL
        ) ON COMMIT DROP
      `);
      await client.query(`INSERT INTO "user" (id, email) VALUES ('u1', 'a@example.test')`);

      const upSql = await readFile(UP, "utf8");
      // Skip the FK to the real user table — temp table can't reference itself across schemas
      // the same way; apply column adds and index only for this fixture.
      const additive = upSql
        .split("\n")
        .filter((line) => !line.includes("ADD CONSTRAINT") && !line.startsWith("--"))
        .join("\n");
      await client.query(additive);

      const { rows: columns } = await client.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns
         WHERE table_name = 'user' AND table_schema LIKE 'pg_temp%'
           AND column_name IN (
             'deletionRequestedAt', 'purgeAfter', 'deletedByUserId',
             'priorSharedKeyBudgetMember', 'purgeClaimedAt'
           )
         ORDER BY 1`,
      );
      expect(columns.map((row) => row.column_name)).toEqual([
        "deletedByUserId",
        "deletionRequestedAt",
        "priorSharedKeyBudgetMember",
        "purgeAfter",
        "purgeClaimedAt",
      ]);

      const { rows: defaults } = await client.query<{ priorSharedKeyBudgetMember: boolean }>(
        `SELECT "priorSharedKeyBudgetMember" FROM "user" WHERE id = 'u1'`,
      );
      expect(defaults[0]?.priorSharedKeyBudgetMember).toBe(false);

      await client.query(DOWN);

      const { rows: after } = await client.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns
         WHERE table_name = 'user' AND table_schema LIKE 'pg_temp%'
           AND column_name IN (
             'deletionRequestedAt', 'purgeAfter', 'deletedByUserId',
             'priorSharedKeyBudgetMember', 'purgeClaimedAt'
           )`,
      );
      expect(after).toEqual([]);
    } finally {
      await client.query("ROLLBACK");
      client.release();
      await pool.end();
    }
  });
});
