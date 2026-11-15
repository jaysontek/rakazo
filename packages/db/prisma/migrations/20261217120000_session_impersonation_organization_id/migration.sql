-- Additive: previous release never reads impersonationOrganizationId.

ALTER TABLE "session" ADD COLUMN "impersonationOrganizationId" TEXT;
