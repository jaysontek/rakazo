-- Additive: previous release ignores these columns (defaults keep old rows valid).
ALTER TABLE "shared_key_week_allotments" ADD COLUMN "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "shared_key_week_allotments" ADD COLUMN "preJoinSpendUsd" DOUBLE PRECISION NOT NULL DEFAULT 0;
-- Existing current-week rows were created at week open, not at migration time — treat
-- them as week-start joiners so the mid-week pro-rate does not suddenly apply.
UPDATE "shared_key_week_allotments" SET "joinedAt" = "weekStart";
