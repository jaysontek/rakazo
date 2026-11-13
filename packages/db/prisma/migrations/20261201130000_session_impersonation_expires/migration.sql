-- Additive: previous release never reads impersonationExpiresAt.

ALTER TABLE "session" ADD COLUMN "impersonationExpiresAt" TIMESTAMP(3);
