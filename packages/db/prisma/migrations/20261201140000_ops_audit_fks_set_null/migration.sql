-- Keep grant/transfer audit rows when the acting admin account is deleted.

ALTER TABLE "admin_grants" DROP CONSTRAINT "admin_grants_grantedById_fkey";
ALTER TABLE "admin_grants" ALTER COLUMN "grantedById" DROP NOT NULL;
ALTER TABLE "admin_grants" ADD CONSTRAINT "admin_grants_grantedById_fkey" FOREIGN KEY ("grantedById") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "shared_key_allotment_transfers" DROP CONSTRAINT "shared_key_allotment_transfers_createdById_fkey";
ALTER TABLE "shared_key_allotment_transfers" ALTER COLUMN "createdById" DROP NOT NULL;
ALTER TABLE "shared_key_allotment_transfers" ADD CONSTRAINT "shared_key_allotment_transfers_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;
