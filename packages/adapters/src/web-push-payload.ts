import type { NotificationMessage } from "@rakazo/adapter-kit";

/** Keeps the push payload inside typical browser/service limits. */
export const MAX_WEB_PUSH_TITLE_CHARS = 100;
export const MAX_WEB_PUSH_BODY_CHARS = 180;
export const MAX_WEB_PUSH_PAYLOAD_BYTES = 3500;

export type WebPushNotificationPayload = {
  title: string;
  body: string;
  icon: string;
  badge: string;
  tag: string;
  data: {
    url: string;
    kind: NotificationMessage["kind"];
    botId: string;
    threadId: string;
    spaceId: string;
    groupId?: string;
  };
};

function capped(text: string, maxChars: number): string {
  const chars = Array.from(text);
  return chars.length <= maxChars ? text : `${chars.slice(0, maxChars - 1).join("")}…`;
}

/** Same-origin path a notification tap should open. Never an absolute cross-origin URL. */
export function webPushOpenPath(message: NotificationMessage, spaceId: string): string {
  const params = new URLSearchParams();
  if (spaceId) params.set("space", spaceId);
  if (message.groupId) params.set("group", message.groupId);
  else params.set("bot", message.botId);
  params.set("thread", message.threadId);
  return `/?${params.toString()}`;
}

/**
 * Builds the JSON the service worker shows. Content matches the in-browser alert
 * (title/body only; no extra fields beyond navigation ids).
 */
export function buildWebPushPayload(
  message: NotificationMessage,
  spaceId: string,
  options: { icon?: string; badge?: string } = {},
): WebPushNotificationPayload {
  const title = capped(message.title, MAX_WEB_PUSH_TITLE_CHARS);
  let bodyChars = MAX_WEB_PUSH_BODY_CHARS;
  let body = capped(message.body, bodyChars);
  const base = (): WebPushNotificationPayload => ({
    title,
    body,
    icon: options.icon ?? "/icon-192.png",
    badge: options.badge ?? "/icon-192.png",
    tag: message.threadId,
    data: {
      url: webPushOpenPath(message, spaceId),
      kind: message.kind,
      botId: message.botId,
      threadId: message.threadId,
      spaceId,
      ...(message.groupId ? { groupId: message.groupId } : {}),
    },
  });
  let payload = base();
  while (Buffer.byteLength(JSON.stringify(payload), "utf8") > MAX_WEB_PUSH_PAYLOAD_BYTES && bodyChars > 1) {
    bodyChars = Math.floor(bodyChars / 2);
    body = capped(message.body, bodyChars);
    payload = base();
  }
  return payload;
}
