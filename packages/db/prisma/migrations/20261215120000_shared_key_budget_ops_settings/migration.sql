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

    CONSTRAINT "shared_key_spend_adjustments_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "shared_key_spend_adjustments_scope_check" CHECK ("scope" IN ('user', 'team')),
    -- Scope is decided by userIdSnapshot, not the nullable live userId FK (SET NULL on
    -- account delete). A deleted user's per-user row keeps its snapshot and never
    -- becomes team-wide.
    CONSTRAINT "shared_key_spend_adjustments_scope_userIdSnapshot_check" CHECK (
      ("scope" = 'user' AND "userIdSnapshot" IS NOT NULL) OR ("scope" = 'team' AND "userIdSnapshot" IS NULL)
    )
);

CREATE UNIQUE INDEX "shared_key_spend_adjustments_reversesId_key" ON "shared_key_spend_adjustments"("reversesId");
CREATE INDEX "shared_key_spend_adjustments_periodStart_scope_userIdSnapshot_idx" ON "shared_key_spend_adjustments"("periodStart", "scope", "userIdSnapshot");
CREATE INDEX "shared_key_spend_adjustments_periodStart_userId_idx" ON "shared_key_spend_adjustments"("periodStart", "userId");
CREATE INDEX "shared_key_spend_adjustments_createdAt_idx" ON "shared_key_spend_adjustments"("createdAt");

-- SET NULL so account self-deletion can remove the user row after beforeDelete commits.
-- Spend math and scope use scope + userIdSnapshot, never the live userId FK.
ALTER TABLE "shared_key_spend_adjustments" ADD CONSTRAINT "shared_key_spend_adjustments_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "shared_key_spend_adjustments" ADD CONSTRAINT "shared_key_spend_adjustments_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "shared_key_spend_adjustments" ADD CONSTRAINT "shared_key_spend_adjustments_reversesId_fkey" FOREIGN KEY ("reversesId") REFERENCES "shared_key_spend_adjustments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
