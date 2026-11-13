-- Additive: previous release never reads these.

CREATE TABLE "admin_grants" (
    "userId" TEXT NOT NULL,
    "grantedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "admin_grants_pkey" PRIMARY KEY ("userId")
);

ALTER TABLE "admin_grants" ADD CONSTRAINT "admin_grants_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "admin_grants" ADD CONSTRAINT "admin_grants_grantedById_fkey" FOREIGN KEY ("grantedById") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "session" ADD COLUMN "impersonatedBy" TEXT;

CREATE TABLE "shared_key_allotment_transfers" (
    "id" TEXT NOT NULL,
    "weekStart" TIMESTAMP(3) NOT NULL,
    "fromUserId" TEXT NOT NULL,
    "toUserId" TEXT NOT NULL,
    "amountUsd" DOUBLE PRECISION NOT NULL,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reversedAt" TIMESTAMP(3),
    "reverseNote" TEXT,

    CONSTRAINT "shared_key_allotment_transfers_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "shared_key_allotment_transfers_weekStart_idx" ON "shared_key_allotment_transfers"("weekStart");
CREATE INDEX "shared_key_allotment_transfers_fromUserId_idx" ON "shared_key_allotment_transfers"("fromUserId");
CREATE INDEX "shared_key_allotment_transfers_toUserId_idx" ON "shared_key_allotment_transfers"("toUserId");

ALTER TABLE "shared_key_allotment_transfers" ADD CONSTRAINT "shared_key_allotment_transfers_fromUserId_fkey" FOREIGN KEY ("fromUserId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "shared_key_allotment_transfers" ADD CONSTRAINT "shared_key_allotment_transfers_toUserId_fkey" FOREIGN KEY ("toUserId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "shared_key_allotment_transfers" ADD CONSTRAINT "shared_key_allotment_transfers_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
