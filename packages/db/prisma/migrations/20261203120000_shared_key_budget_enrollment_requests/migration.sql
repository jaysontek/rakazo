-- Additive: previous release ignores this table.
CREATE TABLE "shared_key_budget_enrollment_requests" (
    "weekStart" TIMESTAMP(3) NOT NULL,
    "userId" TEXT NOT NULL,
    "firstHitAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastHitAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "shared_key_budget_enrollment_requests_pkey" PRIMARY KEY ("weekStart","userId")
);

CREATE INDEX "shared_key_budget_enrollment_requests_weekStart_idx" ON "shared_key_budget_enrollment_requests"("weekStart");

ALTER TABLE "shared_key_budget_enrollment_requests" ADD CONSTRAINT "shared_key_budget_enrollment_requests_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
