-- Additive: the previous release never reads these columns or tables.
ALTER TABLE "deployment_settings" ADD COLUMN "sharedKeyMonthlyBudgetUsd" DOUBLE PRECISION;

ALTER TABLE "usage_records" ADD COLUMN "sharedKey" BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX "usage_records_userId_sharedKey_createdAt_idx" ON "usage_records"("userId", "sharedKey", "createdAt");

CREATE TABLE "shared_key_budget_members" (
    "userId" TEXT NOT NULL,
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "shared_key_budget_members_pkey" PRIMARY KEY ("userId")
);

ALTER TABLE "shared_key_budget_members" ADD CONSTRAINT "shared_key_budget_members_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "shared_key_week_allotments" (
    "weekStart" TIMESTAMP(3) NOT NULL,
    "userId" TEXT NOT NULL,
    "allotmentUsd" DOUBLE PRECISION NOT NULL,
    "reservedUsd" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "shared_key_week_allotments_pkey" PRIMARY KEY ("weekStart","userId")
);

CREATE INDEX "shared_key_week_allotments_userId_weekStart_idx" ON "shared_key_week_allotments"("userId", "weekStart");
