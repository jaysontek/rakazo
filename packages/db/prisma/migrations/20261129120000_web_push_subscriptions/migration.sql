-- Additive: previous API/worker releases never read or write these.
CREATE TABLE "web_push_subscriptions" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "endpoint" TEXT NOT NULL,
    "p256dh" TEXT NOT NULL,
    "auth" TEXT NOT NULL,
    "vapidDigest" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSuccessAt" TIMESTAMP(3),
    "failureCount" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "web_push_subscriptions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "web_push_subscriptions_endpoint_key" ON "web_push_subscriptions"("endpoint");
CREATE INDEX "web_push_subscriptions_userId_idx" ON "web_push_subscriptions"("userId");

ALTER TABLE "web_push_subscriptions" ADD CONSTRAINT "web_push_subscriptions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "web_push_subscriptions" ENABLE ROW LEVEL SECURITY;
CREATE POLICY web_push_subscriptions_tenant ON "web_push_subscriptions"
  USING ("userId" = NULLIF(current_setting('app.user_id', true), ''));
CREATE POLICY web_push_subscriptions_system ON "web_push_subscriptions"
  USING ((SELECT app_rls_bypass()));
