import type {
  AdapterContext,
  AdapterDescriptor,
  NotificationMessage,
  NotificationProvider,
} from "@rakazo/adapter-kit";
import { getLogger } from "@rakazo/logging";
import { buildWebPushPayload } from "./web-push-payload.js";
import type { WebPushSubscriptionStore } from "./web-push-subscription.js";
import { vapidPublicKeyDigest } from "./web-push-subscription.js";

export type WebPushVapidConfig = {
  publicKey: string;
  privateKey: string;
  subject: string;
};

export type WebPushSendResult = "delivered" | "undeliverable";

type WebPushLibrary = {
  setVapidDetails(subject: string, publicKey: string, privateKey: string): void;
  sendNotification(
    subscription: { endpoint: string; keys: { p256dh: string; auth: string } },
    payload: string,
    options?: { TTL?: number; urgency?: string },
  ): Promise<unknown>;
};

export class WebPushProvider implements NotificationProvider {
  private library: Promise<WebPushLibrary> | undefined;

  constructor(
    private readonly subscriptions: WebPushSubscriptionStore,
    private readonly vapid: WebPushVapidConfig,
  ) {}

  describe(): AdapterDescriptor<{ push: boolean; email: boolean }> {
    return {
      id: "web-push",
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: { push: true, email: false },
    };
  }

  publicKey(): string {
    return this.vapid.publicKey;
  }

  vapidDigest(): string {
    return vapidPublicKeyDigest(this.vapid.publicKey);
  }

  async hasPushRecipient(userId: string): Promise<boolean> {
    const rows = await this.subscriptions.list(userId);
    const digest = this.vapidDigest();
    return rows.some((row) => row.vapidDigest === digest);
  }

  async send(message: NotificationMessage, context: AdapterContext): Promise<void> {
    await this.deliver(message, context);
  }

  async deliver(
    message: NotificationMessage,
    context: AdapterContext,
  ): Promise<WebPushSendResult> {
    const digest = this.vapidDigest();
    const rows = (await this.subscriptions.list(context.userId)).filter(
      (row) => row.vapidDigest === digest,
    );
    if (rows.length === 0) return "undeliverable";
    const payload = JSON.stringify(buildWebPushPayload(message, context.spaceId));
    const push = await this.loadLibrary();
    let delivered = false;
    await Promise.all(
      rows.map(async (row) => {
        try {
          await push.sendNotification(
            { endpoint: row.endpoint, keys: row.keys },
            payload,
            {
              TTL: 60 * 60 * 12,
              urgency:
                message.kind === "help" || message.kind === "takeover" || message.kind === "failure"
                  ? "high"
                  : "normal",
            },
          );
          delivered = true;
          await this.subscriptions.recordSuccess(row.id);
        } catch (error) {
          const status = pushStatus(error);
          if (status === 404 || status === 410) {
            await this.subscriptions.removeByEndpoint(row.endpoint);
            return;
          }
          await this.subscriptions.recordFailure(row.id);
          getLogger().warn("web push send failed", { status, error });
        }
      }),
    );
    return delivered ? "delivered" : "undeliverable";
  }

  private loadLibrary(): Promise<WebPushLibrary> {
    this.library ??= (async () => {
      const mod = (await import("web-push")) as { default?: WebPushLibrary } & WebPushLibrary;
      const push = mod.default ?? mod;
      push.setVapidDetails(this.vapid.subject, this.vapid.publicKey, this.vapid.privateKey);
      return push;
    })();
    return this.library;
  }
}

function pushStatus(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;
  const statusCode = (error as { statusCode?: unknown }).statusCode;
  return typeof statusCode === "number" ? statusCode : undefined;
}

/** Resolve VAPID from env; returns undefined when unset so push stays disabled. */
export function webPushVapidFromEnv(
  source: NodeJS.ProcessEnv,
): WebPushVapidConfig | undefined {
  const publicKey = source.VAPID_PUBLIC_KEY?.trim();
  const privateKey = source.VAPID_PRIVATE_KEY?.trim();
  const subject = source.VAPID_SUBJECT?.trim();
  if (!publicKey && !privateKey && !subject) return undefined;
  if (!publicKey || !privateKey || !subject) {
    throw new Error(
      "VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, and VAPID_SUBJECT must be set together (or all left unset).",
    );
  }
  if (!subject.startsWith("mailto:") && !subject.startsWith("https://")) {
    throw new Error("VAPID_SUBJECT must be a mailto: or https: contact URI.");
  }
  return { publicKey, privateKey, subject };
}
