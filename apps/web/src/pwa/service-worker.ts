export const SKIP_WAITING = "rakazo:skip-waiting";
export const CACHE_PREFIX = "rakazo-shell-";

// Live data, auth callbacks and the screen proxy always go straight to the server.
const BYPASS_PREFIXES = ["/api", "/rpc", "/novnc", "/.well-known", "/health"];
const ACTIVATION_TIMEOUT_MS = 3_000;
const BUILD_ID = /^\d{14}$/;

type ExtendableEvent = { waitUntil(promise: Promise<unknown>): void };
type FetchEvent = ExtendableEvent & {
  request: Request;
  respondWith(response: Promise<Response>): void;
};
type MessageEvent = ExtendableEvent & { data: unknown };

type PushEvent = ExtendableEvent & { data: { json(): unknown; text(): Promise<string> } | null };
type NotificationClickEvent = ExtendableEvent & {
  notification: {
    data?: unknown;
    close(): void;
  };
  action?: string;
};

type WindowClient = {
  url: string;
  focused: boolean;
  focus(): Promise<WindowClient>;
  navigate?(url: string): Promise<WindowClient>;
};

export type ServiceWorkerScope = {
  location: { origin: string };
  caches: CacheStorage;
  clients: {
    matchAll(options: {
      type: "window";
      includeUncontrolled?: boolean;
    }): Promise<readonly WindowClient[]>;
    openWindow?(url: string): Promise<WindowClient | null>;
  };
  registration: {
    waiting: Pick<ServiceWorker, "postMessage" | "addEventListener" | "removeEventListener"> | null;
    showNotification(
      title: string,
      options?: {
        body?: string;
        icon?: string;
        badge?: string;
        tag?: string;
        data?: unknown;
      },
    ): Promise<void>;
  };
  skipWaiting(): Promise<void>;
  fetch(request: Request): Promise<Response>;
  addEventListener(type: "install" | "activate", listener: (event: ExtendableEvent) => void): void;
  addEventListener(type: "fetch", listener: (event: FetchEvent) => void): void;
  addEventListener(type: "message", listener: (event: MessageEvent) => void): void;
  addEventListener(type: "push", listener: (event: PushEvent) => void): void;
  addEventListener(
    type: "notificationclick",
    listener: (event: NotificationClickEvent) => void,
  ): void;
};

export function bypassesServiceWorker(pathname: string): boolean {
  return BYPASS_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

/**
 * Precaches the app shell, serves hashed assets cache-first and falls back to
 * the cached shell for navigations while offline. A new version waits until
 * the next navigation of the last open window, then takes over by reloading
 * that navigation. The previous shell stays cached for tabs still using it.
 */
export function installServiceWorker(
  scope: ServiceWorkerScope,
  precache: readonly string[],
  cacheName: string,
): void {
  const precached = new Set(precache);

  scope.addEventListener("install", (event) => {
    event.waitUntil(
      scope.caches
        .open(cacheName)
        .then((cache) =>
          cache.addAll(
            precache.map(
              (url) => new Request(new URL(url, scope.location.origin), { cache: "no-cache" }),
            ),
          ),
        ),
    );
  });

  scope.addEventListener("activate", (event) => {
    event.waitUntil(
      scope.caches.keys().then((names) => {
        // Keep the newest previous shell for tabs still running its bundle. Names end in the build
        // id, which sorts oldest first; older workers named caches by a content hash instead, so
        // one of those is kept only when no build-named cache exists.
        const previous = names.filter(
          (name) => name.startsWith(CACHE_PREFIX) && name !== cacheName,
        );
        const byBuild = previous
          .filter((name) => BUILD_ID.test(name.slice(CACHE_PREFIX.length)))
          .sort();
        const keep = byBuild.at(-1) ?? previous.at(-1);
        return Promise.all(
          previous.filter((name) => name !== keep).map((name) => scope.caches.delete(name)),
        );
      }),
    );
  });

  scope.addEventListener("message", (event) => {
    if (event.data === SKIP_WAITING) event.waitUntil(scope.skipWaiting());
  });

  scope.addEventListener("fetch", (event) => {
    const { request } = event;
    if (request.method !== "GET") return;
    const url = new URL(request.url);
    if (url.origin !== scope.location.origin || bypassesServiceWorker(url.pathname)) return;
    if (request.mode === "navigate") {
      event.respondWith(navigate(request));
    } else if (precached.has(url.pathname) || url.pathname.startsWith("/assets/")) {
      event.respondWith(cacheFirst(event, url.pathname));
    }
  });

  scope.addEventListener("push", (event) => {
    event.waitUntil(handlePush(event));
  });

  scope.addEventListener("notificationclick", (event) => {
    event.notification.close();
    event.waitUntil(handleNotificationClick(event));
  });

  async function handlePush(event: PushEvent): Promise<void> {
    const payload = readPushPayload(event);
    await scope.registration.showNotification(payload.title, {
      body: payload.body,
      icon: payload.icon,
      badge: payload.badge,
      tag: payload.tag,
      data: payload.data,
    });
  }

  async function handleNotificationClick(event: NotificationClickEvent): Promise<void> {
    const target = sameOriginOpenUrl(scope.location.origin, event.notification.data);
    const windows = await scope.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const client of windows) {
      if (new URL(client.url).origin !== scope.location.origin) continue;
      const focused = await client.focus();
      if (target && typeof focused.navigate === "function") {
        try {
          await focused.navigate(target);
        } catch {
          // Older clients may not support navigate; focusing is enough.
        }
      }
      return;
    }
    if (target) await scope.clients.openWindow?.(target);
  }

  async function navigate(request: Request): Promise<Response> {
    if (await activateWaitingWorker()) {
      return new Response("", { headers: { Refresh: "0" } });
    }
    try {
      return await scope.fetch(request);
    } catch (error) {
      const shell = await (await scope.caches.open(cacheName)).match("/");
      if (shell) return shell;
      throw error;
    }
  }

  async function activateWaitingWorker(): Promise<boolean> {
    const waiting = scope.registration.waiting;
    if (!waiting) return false;
    if ((await scope.clients.matchAll({ type: "window" })).length > 1) return false;
    return new Promise((resolve) => {
      const changed = () => {
        clearTimeout(timer);
        resolve(true);
      };
      const timer = setTimeout(() => {
        waiting.removeEventListener("statechange", changed);
        resolve(false);
      }, ACTIVATION_TIMEOUT_MS);
      waiting.addEventListener("statechange", changed, { once: true });
      waiting.postMessage(SKIP_WAITING);
    });
  }

  async function cacheFirst(event: FetchEvent, pathname: string): Promise<Response> {
    const cache = await scope.caches.open(cacheName);
    const cached = await cache.match(event.request);
    if (cached) return cached;
    for (const name of await scope.caches.keys()) {
      if (!name.startsWith(CACHE_PREFIX) || name === cacheName) continue;
      const previous = await (await scope.caches.open(name)).match(event.request);
      if (previous) return previous;
    }
    const response = await scope.fetch(event.request);
    // A missing chunk can come back as the SPA's HTML; never store that as an asset.
    const html = response.headers.get("content-type")?.includes("text/html") ?? false;
    if (response.ok && !html && pathname.startsWith("/assets/")) {
      event.waitUntil(cache.put(event.request, response.clone()).catch(() => undefined));
    }
    return response;
  }
}

type PushPayload = {
  title: string;
  body: string;
  icon: string;
  badge: string;
  tag?: string;
  data?: { url?: string };
};

export function readPushPayload(event: { data: { json(): unknown } | null }): PushPayload {
  const fallback: PushPayload = {
    title: "Rakazo",
    body: "",
    icon: "/icon-192.png",
    badge: "/icon-192.png",
  };
  if (!event.data) return fallback;
  try {
    const parsed = event.data.json();
    if (!parsed || typeof parsed !== "object") return fallback;
    const record = parsed as Record<string, unknown>;
    return {
      title: typeof record.title === "string" && record.title ? record.title : fallback.title,
      body: typeof record.body === "string" ? record.body : "",
      icon: typeof record.icon === "string" && record.icon ? record.icon : fallback.icon,
      badge: typeof record.badge === "string" && record.badge ? record.badge : fallback.badge,
      tag: typeof record.tag === "string" ? record.tag : undefined,
      data:
        record.data && typeof record.data === "object"
          ? (record.data as { url?: string })
          : undefined,
    };
  } catch {
    return fallback;
  }
}

/** Only same-origin relative or absolute URLs may open from a notification. */
export function sameOriginOpenUrl(origin: string, data: unknown): string | null {
  if (!data || typeof data !== "object") return origin + "/";
  const url = (data as { url?: unknown }).url;
  if (typeof url !== "string" || !url) return origin + "/";
  try {
    const resolved = new URL(url, origin);
    if (resolved.origin !== origin) return null;
    return resolved.href;
  } catch {
    return null;
  }
}
