import { createHash } from "node:crypto";
import type { PrismaClient } from "@rakazo/db";
import { runAsSystem, withTransactionRetry } from "@rakazo/db";
import { canonicalizeWebPushEndpoint } from "./web-push-endpoint.js";

export const MAX_WEB_PUSH_SUBSCRIPTIONS_PER_USER = 20;
export const MAX_WEB_PUSH_ENDPOINT_CHARS = 2048;
export const MAX_WEB_PUSH_KEY_CHARS = 256;
/** Drop a subscription after this many consecutive send failures. */
export const MAX_WEB_PUSH_FAILURES = 5;

export type WebPushSubscriptionKeys = {
  p256dh: string;
  auth: string;
};

export type WebPushSubscriptionInput = {
  endpoint: string;
  keys: WebPushSubscriptionKeys;
};

export type StoredWebPushSubscription = WebPushSubscriptionInput & {
  id: string;
  userId: string;
  sessionId: string;
  vapidDigest: string;
  failureCount: number;
};

export class WebPushSubscriptionValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebPushSubscriptionValidationError";
  }
}

export class WebPushSubscriptionConflictError extends Error {
  constructor() {
    super("Push subscription endpoint is already registered.");
    this.name = "WebPushSubscriptionConflictError";
  }
}

const BASE64URL = /^[A-Za-z0-9_-]+$/;

export function validateWebPushSubscription(input: unknown): WebPushSubscriptionInput {
  if (!input || typeof input !== "object") {
    throw new WebPushSubscriptionValidationError("Subscription is required.");
  }
  const record = input as Record<string, unknown>;
  const rawEndpoint = typeof record.endpoint === "string" ? record.endpoint.trim() : "";
  if (!rawEndpoint || rawEndpoint.length > MAX_WEB_PUSH_ENDPOINT_CHARS) {
    throw new WebPushSubscriptionValidationError("Subscription endpoint is invalid.");
  }
  const endpoint = canonicalizeWebPushEndpoint(rawEndpoint);
  if (!endpoint) {
    throw new WebPushSubscriptionValidationError("Subscription endpoint is not allowed.");
  }
  const keys = record.keys;
  if (!keys || typeof keys !== "object") {
    throw new WebPushSubscriptionValidationError("Subscription keys are required.");
  }
  const keyRecord = keys as Record<string, unknown>;
  const p256dh = typeof keyRecord.p256dh === "string" ? keyRecord.p256dh.trim() : "";
  const auth = typeof keyRecord.auth === "string" ? keyRecord.auth.trim() : "";
  if (
    !p256dh ||
    !auth ||
    p256dh.length > MAX_WEB_PUSH_KEY_CHARS ||
    auth.length > MAX_WEB_PUSH_KEY_CHARS ||
    !BASE64URL.test(p256dh) ||
    !BASE64URL.test(auth)
  ) {
    throw new WebPushSubscriptionValidationError("Subscription keys are invalid.");
  }
  return { endpoint, keys: { p256dh, auth } };
}

export function vapidPublicKeyDigest(publicKey: string): string {
  return createHash("sha256").update(publicKey.trim()).digest("hex");
}

export interface WebPushSubscriptionStore {
  list(userId: string): Promise<StoredWebPushSubscription[]>;
  /** True when this user owns the endpoint (used by settings UI). */
  hasEndpoint(userId: string, endpoint: string): Promise<boolean>;
  save(
    userId: string,
    subscription: WebPushSubscriptionInput,
    vapidDigest: string,
    sessionId: string,
  ): Promise<void>;
  remove(userId: string, endpoint: string): Promise<void>;
  removeByEndpoint(endpoint: string): Promise<void>;
  /**
   * Sign-out deletes rows for `sessionId`. Password / passkey re-auth passes
   * `nextSessionId` to retarget them when that session is still live.
   */
  endSession(userId: string, sessionId: string, nextSessionId?: string): Promise<void>;
  recordSuccess(id: string): Promise<void>;
  /** Increments failureCount; removes the row once it reaches MAX_WEB_PUSH_FAILURES. */
  recordFailure(id: string): Promise<void>;
}

export class PrismaWebPushSubscriptionStore implements WebPushSubscriptionStore {
  constructor(private readonly prisma: PrismaClient) {}

  async list(userId: string): Promise<StoredWebPushSubscription[]> {
    const rows = await runAsSystem("list web push subscriptions", () =>
      this.prisma.webPushSubscription.findMany({
        where: { userId },
        orderBy: { createdAt: "asc" },
      }),
    );
    return rows.map((row) => ({
      id: row.id,
      userId: row.userId,
      sessionId: row.sessionId,
      endpoint: row.endpoint,
      keys: { p256dh: row.p256dh, auth: row.auth },
      vapidDigest: row.vapidDigest,
      failureCount: row.failureCount,
    }));
  }

  async hasEndpoint(userId: string, endpoint: string): Promise<boolean> {
    const canonical = canonicalizeWebPushEndpoint(endpoint.trim());
    if (!canonical) return false;
    const row = await runAsSystem("check web push subscription", () =>
      this.prisma.webPushSubscription.findFirst({
        where: { userId, endpoint: canonical },
        select: { id: true },
      }),
    );
    return Boolean(row);
  }

  async save(
    userId: string,
    subscription: WebPushSubscriptionInput,
    vapidDigest: string,
    sessionId: string,
  ): Promise<void> {
    if (!sessionId.trim()) {
      throw new WebPushSubscriptionValidationError("A signed-in session is required.");
    }
    const validated = validateWebPushSubscription(subscription);
    await runAsSystem("save a web push subscription", () =>
      withTransactionRetry(() =>
        this.prisma.$transaction(async (tx) => {
          // Same key as Expo push tokens so register cannot race a session replace.
          await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`push-user:${userId}`}, 0))::text`;
          const existing = await tx.webPushSubscription.findUnique({
            where: { endpoint: validated.endpoint },
          });
          if (existing) {
            if (
              existing.userId !== userId &&
              (existing.p256dh !== validated.keys.p256dh || existing.auth !== validated.keys.auth)
            ) {
              throw new WebPushSubscriptionConflictError();
            }
            await tx.webPushSubscription.update({
              where: { endpoint: validated.endpoint },
              data: {
                userId,
                sessionId,
                p256dh: validated.keys.p256dh,
                auth: validated.keys.auth,
                vapidDigest,
                failureCount: 0,
                lastSuccessAt: null,
              },
            });
            return;
          }
          const count = await tx.webPushSubscription.count({ where: { userId } });
          if (count >= MAX_WEB_PUSH_SUBSCRIPTIONS_PER_USER) {
            const oldest = await tx.webPushSubscription.findFirst({
              where: { userId },
              orderBy: { createdAt: "asc" },
              select: { id: true },
            });
            if (oldest) await tx.webPushSubscription.delete({ where: { id: oldest.id } });
          }
          await tx.webPushSubscription.create({
            data: {
              userId,
              sessionId,
              endpoint: validated.endpoint,
              p256dh: validated.keys.p256dh,
              auth: validated.keys.auth,
              vapidDigest,
            },
          });
        }),
      ),
    );
  }

  async remove(userId: string, endpoint: string): Promise<void> {
    await runAsSystem("remove a web push subscription", () =>
      this.prisma.webPushSubscription.deleteMany({ where: { userId, endpoint } }),
    );
  }

  async removeByEndpoint(endpoint: string): Promise<void> {
    await runAsSystem("drop an expired web push subscription", () =>
      this.prisma.webPushSubscription.deleteMany({ where: { endpoint } }),
    );
  }

  async endSession(userId: string, sessionId: string, nextSessionId?: string): Promise<void> {
    await runAsSystem("revoke or retarget a session's web push subscriptions", () =>
      withTransactionRetry(() =>
        this.prisma.$transaction(async (tx) => {
          await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`push-user:${userId}`}, 0))::text`;
          const where = { userId, sessionId };
          if (!nextSessionId) {
            await tx.webPushSubscription.deleteMany({ where });
            return;
          }
          const session = await tx.session.findFirst({
            where: { id: nextSessionId, userId, expiresAt: { gt: new Date() } },
            select: { id: true },
          });
          if (!session) {
            await tx.webPushSubscription.deleteMany({ where });
            return;
          }
          await tx.webPushSubscription.updateMany({
            where,
            data: { sessionId: nextSessionId },
          });
        }),
      ),
    );
  }

  async recordSuccess(id: string): Promise<void> {
    await runAsSystem("mark web push success", () =>
      this.prisma.webPushSubscription.updateMany({
        where: { id },
        data: { lastSuccessAt: new Date(), failureCount: 0 },
      }),
    );
  }

  async recordFailure(id: string): Promise<void> {
    await runAsSystem("mark web push failure", async () => {
      const rows = await this.prisma.webPushSubscription.updateMany({
        where: { id },
        data: { failureCount: { increment: 1 } },
      });
      if (rows.count === 0) return;
      const current = await this.prisma.webPushSubscription.findUnique({
        where: { id },
        select: { failureCount: true },
      });
      if ((current?.failureCount ?? 0) >= MAX_WEB_PUSH_FAILURES) {
        await this.prisma.webPushSubscription.deleteMany({ where: { id } });
      }
    });
  }
}
