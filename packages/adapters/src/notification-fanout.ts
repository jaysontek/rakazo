import type {
  AdapterContext,
  AdapterDescriptor,
  IncomingCallNotification,
  NotificationMessage,
  NotificationProvider,
} from "@rakazo/adapter-kit";
import { getLogger } from "@rakazo/logging";
import { ExpoPushProvider } from "./expo-push.js";
import { WebPushProvider } from "./web-push.js";

type Deliverable = {
  deliver?(
    message: NotificationMessage,
    context: AdapterContext,
  ): Promise<"delivered" | "undeliverable">;
  hasPushRecipient?(userId: string): Promise<boolean>;
};

/**
 * Sends the same product notification through every configured transport.
 * Expo and Web Push share the notifyRun path so closed tabs still get alerts.
 */
export class FanoutNotificationProvider implements NotificationProvider {
  constructor(private readonly providers: readonly NotificationProvider[]) {}

  describe(): AdapterDescriptor<{ push: boolean; email: boolean }> {
    return {
      id: "notification-fanout",
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: {
        push: this.providers.some((provider) => provider.describe().capabilities.push),
        email: this.providers.some((provider) => provider.describe().capabilities.email),
      },
    };
  }

  async hasPushRecipient(userId: string): Promise<boolean> {
    for (const provider of this.providers) {
      const deliverable = provider as NotificationProvider & Deliverable;
      if (typeof deliverable.hasPushRecipient === "function") {
        if (await deliverable.hasPushRecipient(userId)) return true;
      } else if (!(provider instanceof ExpoPushProvider) && !(provider instanceof WebPushProvider)) {
        return true;
      }
    }
    return false;
  }

  async send(message: NotificationMessage, context: AdapterContext): Promise<void> {
    await this.deliver(message, context);
  }

  async deliver(
    message: NotificationMessage,
    context: AdapterContext,
  ): Promise<"delivered" | "undeliverable"> {
    const results = await Promise.all(
      this.providers.map(async (provider) => {
        try {
          const deliverable = provider as NotificationProvider & Deliverable;
          if (typeof deliverable.deliver === "function") {
            return await deliverable.deliver(message, context);
          }
          await provider.send(message, context);
          return "delivered" as const;
        } catch (error) {
          getLogger().error("notification fanout", error);
          return "failed" as const;
        }
      }),
    );
    if (results.includes("delivered")) return "delivered";
    if (results.every((result) => result === "undeliverable")) return "undeliverable";
    throw new Error("notification delivery failed");
  }

  async incomingCall(userId: string, call: IncomingCallNotification): Promise<void> {
    await Promise.all(
      this.providers.map(async (provider) => {
        try {
          await provider.incomingCall?.(userId, call);
        } catch (error) {
          getLogger().error("notification fanout incoming call", error);
        }
      }),
    );
  }
}

export function composeNotificationProviders(
  ...providers: Array<NotificationProvider | undefined>
): NotificationProvider {
  const active = providers.filter((provider): provider is NotificationProvider => Boolean(provider));
  if (active.length === 0) {
    return {
      describe: () => ({
        id: "notifications-none",
        contractVersion: "1",
        adapterVersion: "0.1.0",
        capabilities: { push: false, email: false },
      }),
      send: async () => undefined,
    };
  }
  if (active.length === 1) return active[0]!;
  return new FanoutNotificationProvider(active);
}
