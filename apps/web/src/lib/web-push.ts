import type { RpcClient } from "./rpc";

export type WebPushHost = {
  Notification?: { permission: NotificationPermission };
  PushManager?: unknown;
  navigator: Navigator & {
    standalone?: boolean;
    serviceWorker?: ServiceWorkerContainer;
  };
  matchMedia?: (query: string) => MediaQueryList;
};

export type WebPushUiState =
  | { kind: "unavailable" }
  | { kind: "needs-install" }
  | { kind: "ready"; subscribed: boolean; busy?: boolean; error?: string };

/** iOS only delivers Web Push from a Home Screen app on 16.4+. */
export function webPushNeedsHomeScreenInstall(
  host: WebPushHost = window,
  userAgent: string = typeof navigator === "undefined" ? "" : navigator.userAgent,
): boolean {
  const ios =
    /iPad|iPhone|iPod/.test(userAgent) ||
    (userAgent.includes("Mac") && host.navigator.maxTouchPoints > 1);
  if (!ios) return false;
  const standalone =
    host.navigator.standalone === true ||
    (typeof host.matchMedia === "function" &&
      host.matchMedia("(display-mode: standalone)").matches);
  return !standalone;
}

export function webPushSupported(host: WebPushHost = window): boolean {
  return Boolean(
    host.Notification &&
      "PushManager" in host &&
      host.navigator.serviceWorker &&
      !webPushNeedsHomeScreenInstall(host),
  );
}

function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const raw = atob((base64 + padding).replace(/-/g, "+").replace(/_/g, "/"));
  const output = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) output[i] = raw.charCodeAt(i);
  return output;
}

function subscriptionJson(subscription: PushSubscription): {
  endpoint: string;
  keys: { p256dh: string; auth: string };
} {
  const json = subscription.toJSON();
  const endpoint = json.endpoint;
  const p256dh = json.keys?.p256dh;
  const auth = json.keys?.auth;
  if (!endpoint || !p256dh || !auth) throw new Error("Incomplete push subscription.");
  return { endpoint, keys: { p256dh, auth } };
}

export async function fetchWebPushStatus(
  rpc: Pick<RpcClient, "notifications">,
  endpoint?: string,
): Promise<{ available: boolean; publicKey?: string; registered?: boolean }> {
  return rpc.notifications.webPushStatus(endpoint ? { endpoint } : undefined);
}

/** True only when the server holds this browser's endpoint for the signed-in user. */
export async function isWebPushRegisteredOnServer(
  rpc: Pick<RpcClient, "notifications">,
  host: WebPushHost = window,
): Promise<boolean> {
  const subscription = await currentWebPushSubscription(host);
  if (!subscription) return false;
  const status = await fetchWebPushStatus(rpc, subscription.endpoint);
  return Boolean(status.available && status.registered);
}

export async function currentWebPushSubscription(
  host: WebPushHost = window,
): Promise<PushSubscription | null> {
  const registration = await host.navigator.serviceWorker?.ready;
  if (!registration?.pushManager) return null;
  return registration.pushManager.getSubscription();
}

/**
 * Subscribe after an explicit gesture. Replaces an existing subscription when
 * the server VAPID key changed or the browser subscription expired.
 */
export async function subscribeWebPush(
  rpc: Pick<RpcClient, "notifications">,
  publicKey: string,
  host: WebPushHost = window,
): Promise<void> {
  if (!host.Notification) throw new Error("Notifications are unavailable.");
  const permission =
    host.Notification.permission === "granted" ? "granted" : await Notification.requestPermission();
  if (permission !== "granted") throw new Error("Notification permission was not granted.");
  const registration = await host.navigator.serviceWorker?.ready;
  if (!registration?.pushManager) throw new Error("Push messaging is unavailable.");
  let subscription = await registration.pushManager.getSubscription();
  const applicationServerKey = urlBase64ToUint8Array(publicKey);
  if (subscription) {
    const currentKey = subscription.options.applicationServerKey;
    const matches =
      currentKey &&
      applicationServerKey.length === currentKey.byteLength &&
      new Uint8Array(currentKey).every((byte, index) => byte === applicationServerKey[index]);
    if (!matches) {
      await subscription.unsubscribe().catch(() => undefined);
      subscription = null;
    }
  }
  subscription ??= await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: applicationServerKey as BufferSource,
  });
  await rpc.notifications.registerWebPush(subscriptionJson(subscription));
}

export async function unsubscribeWebPush(
  rpc: Pick<RpcClient, "notifications">,
  host: WebPushHost = window,
): Promise<void> {
  const subscription = await currentWebPushSubscription(host);
  if (!subscription) return;
  await rpc.notifications.unregisterWebPush({ endpoint: subscription.endpoint });
  await subscription.unsubscribe().catch(() => undefined);
}
