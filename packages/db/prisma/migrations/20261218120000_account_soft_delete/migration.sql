-- Additive: previous release never reads these columns.
-- Safe on a live DB (nullable columns + default + index only; no drops/renames/rewrites).
--
-- Rollback (down):
--   DROP INDEX IF EXISTS "user_purgeAfter_idx";
--   ALTER TABLE "user" DROP COLUMN IF EXISTS "deactivatedBeforeDeletion";
--   ALTER TABLE "user" DROP COLUMN IF EXISTS "purgeClaimedAt";
--   ALTER TABLE "user" DROP COLUMN IF EXISTS "priorSharedKeyBudgetMember";
--   ALTER TABLE "user" DROP CONSTRAINT IF EXISTS "user_deletedByUserId_fkey";
--   ALTER TABLE "user" DROP COLUMN IF EXISTS "deletedByUserId";
--   ALTER TABLE "user" DROP COLUMN IF EXISTS "purgeAfter";
--   ALTER TABLE "user" DROP COLUMN IF EXISTS "deletionRequestedAt";
--   DELETE FROM _prisma_migrations WHERE migration_name = '20261218120000_account_soft_delete';

ALTER TABLE "user" ADD COLUMN "deletionRequestedAt" TIMESTAMP(3);
ALTER TABLE "user" ADD COLUMN "purgeAfter" TIMESTAMP(3);
ALTER TABLE "user" ADD COLUMN "deletedByUserId" TEXT;
ALTER TABLE "user" ADD COLUMN "priorSharedKeyBudgetMember" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "user" ADD COLUMN "purgeClaimedAt" TIMESTAMP(3);
ALTER TABLE "user" ADD COLUMN "deactivatedBeforeDeletion" TIMESTAMP(3);

CREATE INDEX "user_purgeAfter_idx" ON "user"("purgeAfter");

ALTER TABLE "user" ADD CONSTRAINT "user_deletedByUserId_fkey" FOREIGN KEY ("deletedByUserId") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;
