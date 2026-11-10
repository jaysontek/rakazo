import { createHash } from "node:crypto";
import type { PrismaClient } from "@rakazo/db";
import { runAsSystem } from "@rakazo/db";

export const MAX_WEB_PUSH_SUBSCRIPTIONS_PER_USER = 20;
export const MAX_WEB_PUSH_ENDPOINT_CHARS = 2048;
export const MAX_WEB_PUSH_KEY_CHARS = 256;

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
  vapidDigest: string;
  failureCount: number;
};

export class WebPushSubscriptionValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebPushSubscriptionValidationError";
  }
}

const BASE64URL = /^[A-Za-z0-9_-]+$/;

export function validateWebPushSubscription(
  input: unknown,
): WebPushSubscriptionInput {
  if (!input || typeof input !== "object") {
    throw new WebPushSubscriptionValidationError("Subscription is required.");
  }
  const record = input as Record<string, unknown>;
  const endpoint = typeof record.endpoint === "string" ? record.endpoint.trim() : "";
  if (!endpoint || endpoint.length > MAX_WEB_PUSH_ENDPOINT_CHARS) {
    throw new WebPushSubscriptionValidationError("Subscription endpoint is invalid.");
  }
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new WebPushSubscriptionValidationError("Subscription endpoint is invalid.");
  }
  if (url.protocol !== "https:") {
    throw new WebPushSubscriptionValidationError("Subscription endpoint must be HTTPS.");
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
  save(
    userId: string,
    subscription: WebPushSubscriptionInput,
    vapidDigest: string,
  ): Promise<void>;
  remove(userId: string, endpoint: string): Promise<void>;
  removeByEndpoint(endpoint: string): Promise<void>;
  recordSuccess(id: string): Promise<void>;
  recordFailure(id: string): Promise<void>;
}

export class PrismaWebPushSubscriptionStore implements WebPushSubscriptionStore {
  constructor(private readonly prisma: PrismaClient) {}

  async list(userId: string): Promise<StoredWebPushSubscription[]> {
    const rows = await runAsSystem("list web push subscriptions", () =>
      this.prisma.webPushSubscription.findMany({ where: { userId }, orderBy: { createdAt: "asc" } }),
    );
    return rows.map((row) => ({
      id: row.id,
      userId: row.userId,
      endpoint: row.endpoint,
      keys: { p256dh: row.p256dh, auth: row.auth },
      vapidDigest: row.vapidDigest,
      failureCount: row.failureCount,
    }));
  }

  async save(
    userId: string,
    subscription: WebPushSubscriptionInput,
    vapidDigest: string,
  ): Promise<void> {
    const validated = validateWebPushSubscription(subscription);
    await runAsSystem("save a web push subscription", async () => {
      await this.prisma.$transaction(async (tx) => {
        const existing = await tx.webPushSubscription.findUnique({
          where: { endpoint: validated.endpoint },
        });
        if (existing) {
          await tx.webPushSubscription.update({
            where: { endpoint: validated.endpoint },
            data: {
              userId,
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
            endpoint: validated.endpoint,
            p256dh: validated.keys.p256dh,
            auth: validated.keys.auth,
            vapidDigest,
          },
        });
      });
    });
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

  async recordSuccess(id: string): Promise<void> {
    await runAsSystem("mark web push success", () =>
      this.prisma.webPushSubscription.updateMany({
        where: { id },
        data: { lastSuccessAt: new Date(), failureCount: 0 },
      }),
    );
  }

  async recordFailure(id: string): Promise<void> {
    await runAsSystem("mark web push failure", () =>
      this.prisma.webPushSubscription.updateMany({
        where: { id },
        data: { failureCount: { increment: 1 } },
      }),
    );
  }
}
