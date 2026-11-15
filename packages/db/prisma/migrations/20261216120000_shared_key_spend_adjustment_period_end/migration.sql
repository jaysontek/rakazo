-- Additive: store period end at write so reverse does not recompute from the current schedule.
ALTER TABLE "shared_key_spend_adjustments" ADD COLUMN "periodEnd" TIMESTAMP(3);
