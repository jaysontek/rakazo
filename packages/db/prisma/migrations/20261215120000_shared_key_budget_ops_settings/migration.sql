-- Additive: the previous release never reads these columns or tables.
-- Null columns preserve today's shared-key budget behaviour.

ALTER TABLE "deployment_settings" ADD COLUMN "sharedKeyPeriod" TEXT;
ALTER TABLE "deployment_settings" ADD COLUMN "sharedKeyResetDow" INTEGER;
ALTER TABLE "deployment_settings" ADD COLUMN "sharedKeyResetDom" INTEGER;
ALTER TABLE "deployment_settings" ADD COLUMN "sharedKeyResetMinutes" INTEGER;
ALTER TABLE "deployment_settings" ADD COLUMN "sharedKeyTimezone" TEXT;
ALTER TABLE "deployment_settings" ADD COLUMN "sharedKeyActivePeriodStart" TIMESTAMP(3);
ALTER TABLE "deployment_settings" ADD COLUMN "sharedKeyAutoEnrollMode" TEXT;
ALTER TABLE "deployment_settings" ADD COLUMN "sharedKeyWarningThresholds" JSONB;
ALTER TABLE "deployment_settings" ADD COLUMN "sharedKeyHardStopEnabled" BOOLEAN;
ALTER TABLE "deployment_settings" ADD COLUMN "sharedKeyHoldStaleMinutes" INTEGER;
ALTER TABLE "deployment_settings" ADD COLUMN "sharedKeyPruneInactive" BOOLEAN;

CREATE TABLE "shared_key_member_overrides" (
    "userId" TEXT NOT NULL,
    "weeklyAllotmentUsd" DOUBLE PRECISION NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "shared_key_member_overrides_pkey" PRIMARY KEY ("userId")
);

ALTER TABLE "shared_key_member_overrides" ADD CONSTRAINT "shared_key_member_overrides_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "shared_key_spend_adjustments" (
    "id" TEXT NOT NULL,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "scope" TEXT NOT NULL,
    "userId" TEXT,
    "userIdSnapshot" TEXT,
    "deltaUsd" DOUBLE PRECISION NOT NULL,
    "reason" TEXT NOT NULL,
    "createdById" TEXT,
    "createdByIdSnapshot" TEXT,
    "createdByEmailSnapshot" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "previousTrackedUsd" DOUBLE PRECISION NOT NULL,
    "newTrackedUsd" DOUBLE PRECISION NOT NULL,
    "reversesId" TEXT,

    CONSTRAINT "shared_key_spend_adjustments_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "shared_key_spend_adjustments_reversesId_key" ON "shared_key_spend_adjustments"("reversesId");
CREATE INDEX "shared_key_spend_adjustments_periodStart_scope_userIdSnapshot_idx" ON "shared_key_spend_adjustments"("periodStart", "scope", "userIdSnapshot");
CREATE INDEX "shared_key_spend_adjustments_periodStart_userId_idx" ON "shared_key_spend_adjustments"("periodStart", "userId");
CREATE INDEX "shared_key_spend_adjustments_createdAt_idx" ON "shared_key_spend_adjustments"("createdAt");

-- RESTRICT on user-scoped FKs so deleting a user cannot null the FK and turn a
-- per-user adjustment into a team-wide one. Snapshots keep audit + spend math.
ALTER TABLE "shared_key_spend_adjustments" ADD CONSTRAINT "shared_key_spend_adjustments_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "shared_key_spend_adjustments" ADD CONSTRAINT "shared_key_spend_adjustments_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "shared_key_spend_adjustments" ADD CONSTRAINT "shared_key_spend_adjustments_reversesId_fkey" FOREIGN KEY ("reversesId") REFERENCES "shared_key_spend_adjustments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
