import type {
  AdapterContext,
  AdapterDescriptor,
  NotificationMessage,
  NotificationProvider,
} from "@rakazo/adapter-kit";
import { isAllowedWebPushEndpoint } from "@rakazo/contracts";
import { getLogger } from "@rakazo/logging";
import { buildWebPushPayload } from "./web-push-payload.js";
import type {
  StoredWebPushSubscription,
  WebPushSubscriptionStore,
} from "./web-push-subscription.js";
import { vapidPublicKeyDigest } from "./web-push-subscription.js";

export type WebPushVapidConfig = {
  publicKey: string;
  privateKey: string;
  subject: string;
};

export type WebPushSendResult = "delivered" | "undeliverable";

/** Expiry stored for a registration's session; null while a replacement is pending. */
export type WebPushSessionExpiresAt = (sessionId: string) => Promise<Date | null>;

type WebPushLibrary = {
  setVapidDetails(subject: string, publicKey: string, privateKey: string): void;
  sendNotification(
    subscription: { endpoint: string; keys: { p256dh: string; auth: string } },
    payload: string,
    options?: { TTL?: number; urgency?: string },
  ): Promise<unknown>;
};

export type WebPushOptions = {
  sessionExpiresAt?: WebPushSessionExpiresAt;
};

export class WebPushProvider implements NotificationProvider {
  private library: Promise<WebPushLibrary> | undefined;
  private readonly sessionExpiresAt?: WebPushSessionExpiresAt;

  constructor(
    private readonly subscriptions: WebPushSubscriptionStore,
    private readonly vapid: WebPushVapidConfig,
    options: WebPushOptions = {},
  ) {
    this.sessionExpiresAt = options.sessionExpiresAt;
  }

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
    for (const row of rows) {
      if (row.vapidDigest !== digest) continue;
      if (await this.sessionStillLive(row)) return true;
    }
    return false;
  }

  async send(message: NotificationMessage, context: AdapterContext): Promise<void> {
    await this.deliver(message, context);
  }

  async deliver(message: NotificationMessage, context: AdapterContext): Promise<WebPushSendResult> {
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
        if (!(await this.sessionStillLive(row))) return;
        if (!isAllowedWebPushEndpoint(row.endpoint)) {
          await this.subscriptions.removeByEndpoint(row.endpoint);
          return;
        }
        try {
          await push.sendNotification({ endpoint: row.endpoint, keys: row.keys }, payload, {
            TTL: 60 * 60 * 12,
            urgency:
              message.kind === "help" || message.kind === "takeover" || message.kind === "failure"
                ? "high"
                : "normal",
          });
          delivered = true;
          await this.subscriptions.recordSuccess(row.id);
        } catch (error) {
          const status = pushStatus(error);
          if (status === 404 || status === 410) {
            await this.subscriptions.removeByEndpoint(row.endpoint);
            return;
          }
          await this.subscriptions.recordFailure(row.id);
          getLogger().warn("web push send failed", {
            status,
            host: endpointHost(row.endpoint),
          });
        }
      }),
    );
    return delivered ? "delivered" : "undeliverable";
  }

  /**
   * A subscription bound to a session is delivered only while that session is
   * still live. A missing or expired session drops the row.
   */
  private async sessionStillLive(row: StoredWebPushSubscription): Promise<boolean> {
    if (!row.sessionId) {
      await this.subscriptions.removeByEndpoint(row.endpoint);
      return false;
    }
    if (!this.sessionExpiresAt) return false;
    let expiresAt: Date | null;
    try {
      expiresAt = await this.sessionExpiresAt(row.sessionId);
    } catch (error) {
      getLogger().error("web push session lookup failed", error);
      return false;
    }
    if (!expiresAt || expiresAt.getTime() <= Date.now()) {
      await this.subscriptions.removeByEndpoint(row.endpoint);
      return false;
    }
    return true;
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

function endpointHost(endpoint: string): string | undefined {
  try {
    return new URL(endpoint).host;
  } catch {
    return undefined;
  }
}

/**
 * Resolve VAPID from env. Missing subject with both keys set warns and disables
 * push. A half-set key pair still throws. Used by API `loadEnv` and the worker.
 */
export function webPushVapidFromEnv(
  source: NodeJS.ProcessEnv,
  log: { warn(message: string): void } = getLogger(),
): WebPushVapidConfig | undefined {
  const publicKey = source.VAPID_PUBLIC_KEY?.trim() || undefined;
  const privateKey = source.VAPID_PRIVATE_KEY?.trim() || undefined;
  const subject = source.VAPID_SUBJECT?.trim() || undefined;
  if (!publicKey && !privateKey && !subject) return undefined;
  if (Boolean(publicKey) !== Boolean(privateKey)) {
    throw new Error(
      "VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY must be set together (or both left unset).",
    );
  }
  if (publicKey && privateKey && !subject) {
    log.warn("VAPID_SUBJECT is unset; Web Push is disabled.");
    return undefined;
  }
  if (!publicKey || !privateKey || !subject) {
    log.warn("Incomplete VAPID configuration; Web Push is disabled.");
    return undefined;
  }
  if (!subject.startsWith("mailto:") && !subject.startsWith("https://")) {
    throw new Error("VAPID_SUBJECT must be a mailto: or https: contact URI.");
  }
  return { publicKey, privateKey, subject };
}
