import { getLogger } from "@rakazo/logging";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebPushProvider, webPushVapidFromEnv } from "./web-push.js";
import type {
  StoredWebPushSubscription,
  WebPushSubscriptionInput,
  WebPushSubscriptionStore,
} from "./web-push-subscription.js";
import { vapidPublicKeyDigest, WebPushSubscriptionConflictError } from "./web-push-subscription.js";

const publicKey = "test-public";
const digest = vapidPublicKeyDigest(publicKey);
const endpoint = "https://fcm.googleapis.com/fcm/send/device-1";

function message() {
  return {
    kind: "completion" as const,
    title: "Hi",
    body: "Body",
    botId: "bot",
    threadId: "thread",
  };
}

function context() {
  return {
    operationId: "notify",
    traceId: "t",
    spaceId: "space",
    userId: "user-1",
    botId: "bot",
    signal: new AbortController().signal,
  };
}

class MemoryStore implements WebPushSubscriptionStore {
  rows = new Map<string, StoredWebPushSubscription>();
  /** Session ids that are treated as live for endSession retargeting. */
  liveSessions = new Set<string>();

  async list(userId: string) {
    return [...this.rows.values()].filter((row) => row.userId === userId);
  }

  async hasEndpoint(userId: string, endpointValue: string) {
    return [...this.rows.values()].some(
      (row) => row.userId === userId && row.endpoint === endpointValue,
    );
  }

  async save(
    userId: string,
    subscription: WebPushSubscriptionInput,
    vapidDigest: string,
    sessionId: string,
  ) {
    const existing = [...this.rows.values()].find((row) => row.endpoint === subscription.endpoint);
    if (
      existing &&
      existing.userId !== userId &&
      (existing.keys.p256dh !== subscription.keys.p256dh ||
        existing.keys.auth !== subscription.keys.auth)
    ) {
      throw new WebPushSubscriptionConflictError();
    }
    const id = existing?.id ?? `sub-${this.rows.size + 1}`;
    this.rows.set(id, {
      id,
      userId,
      sessionId,
      endpoint: subscription.endpoint,
      keys: subscription.keys,
      vapidDigest,
      failureCount: 0,
    });
  }

  async remove(userId: string, endpointValue: string) {
    for (const [id, row] of this.rows) {
      if (row.userId === userId && row.endpoint === endpointValue) this.rows.delete(id);
    }
  }

  async removeByEndpoint(endpointValue: string) {
    for (const [id, row] of this.rows) {
      if (row.endpoint === endpointValue) this.rows.delete(id);
    }
  }

  async endSession(userId: string, sessionId: string, nextSessionId?: string) {
    if (!nextSessionId) {
      for (const [id, row] of this.rows) {
        if (row.userId === userId && row.sessionId === sessionId) this.rows.delete(id);
      }
      return;
    }
    if (!this.liveSessions.has(nextSessionId)) {
      for (const [id, row] of this.rows) {
        if (row.userId === userId && row.sessionId === sessionId) this.rows.delete(id);
      }
      return;
    }
    for (const row of this.rows.values()) {
      if (row.userId === userId && row.sessionId === sessionId) row.sessionId = nextSessionId;
    }
  }

  async recordSuccess(id: string) {
    const row = this.rows.get(id);
    if (row) row.failureCount = 0;
  }

  async recordFailure(id: string) {
    const row = this.rows.get(id);
    if (!row) return;
    row.failureCount += 1;
    if (row.failureCount >= 5) this.rows.delete(id);
  }
}

describe("WebPushProvider", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("deletes expired sessions but keeps rows while a replacement is pending", async () => {
    const store = new MemoryStore();
    await store.save(
      "user-1",
      { endpoint, keys: { p256dh: "abc", auth: "def" } },
      digest,
      "session-gone",
    );
    await store.save(
      "user-1",
      {
        endpoint: "https://fcm.googleapis.com/fcm/send/device-2",
        keys: { p256dh: "abc", auth: "def" },
      },
      digest,
      "session-expired",
    );
    const sendNotification = vi.fn(async () => undefined);
    const provider = new WebPushProvider(
      store,
      { publicKey, privateKey: "private", subject: "mailto:ops@example.com" },
      {
        sessionExpiresAt: async (sessionId) => {
          if (sessionId === "session-gone") return null;
          return new Date(Date.now() - 1_000);
        },
      },
    );
    Object.defineProperty(provider, "library", {
      value: Promise.resolve({
        setVapidDetails: () => undefined,
        sendNotification,
      }),
    });
    await expect(provider.deliver(message(), context())).resolves.toBe("undeliverable");
    expect(sendNotification).not.toHaveBeenCalled();
    // Missing session: keep for afterReplaceSession. Expired: delete.
    expect([...store.rows.values()].map((row) => row.sessionId)).toEqual(["session-gone"]);
    await expect(provider.hasPushRecipient("user-1")).resolves.toBe(false);
  });

  it("retargets subscriptions on session replace and deletes them on session end", async () => {
    const store = new MemoryStore();
    store.liveSessions.add("session-2");
    await store.save(
      "user-1",
      { endpoint, keys: { p256dh: "abc", auth: "def" } },
      digest,
      "session-1",
    );
    await store.endSession("user-1", "session-1", "session-2");
    expect([...store.rows.values()][0]?.sessionId).toBe("session-2");
    await store.endSession("user-1", "session-2");
    expect(store.rows.size).toBe(0);
  });

  it("deletes subscriptions when the replacement session is not live", async () => {
    const store = new MemoryStore();
    await store.save(
      "user-1",
      { endpoint, keys: { p256dh: "abc", auth: "def" } },
      digest,
      "session-1",
    );
    await store.endSession("user-1", "session-1", "session-dead");
    expect(store.rows.size).toBe(0);
  });

  it("deletes disallowed endpoints before sending", async () => {
    const store = new MemoryStore();
    store.rows.set("sub-1", {
      id: "sub-1",
      userId: "user-1",
      sessionId: "session-1",
      endpoint: "https://evil.example/push",
      keys: { p256dh: "abc", auth: "def" },
      vapidDigest: digest,
      failureCount: 0,
    });
    const sendNotification = vi.fn(async () => undefined);
    const provider = new WebPushProvider(
      store,
      { publicKey, privateKey: "private", subject: "mailto:ops@example.com" },
      { sessionExpiresAt: async () => new Date(Date.now() + 60_000) },
    );
    Object.defineProperty(provider, "library", {
      value: Promise.resolve({ setVapidDetails: () => undefined, sendNotification }),
    });
    await expect(provider.deliver(message(), context())).resolves.toBe("undeliverable");
    expect(sendNotification).not.toHaveBeenCalled();
    expect(store.rows.size).toBe(0);
  });

  it("removes a subscription after consecutive send failures", async () => {
    const store = new MemoryStore();
    await store.save(
      "user-1",
      { endpoint, keys: { p256dh: "abc", auth: "def" } },
      digest,
      "session-1",
    );
    const provider = new WebPushProvider(
      store,
      { publicKey, privateKey: "private", subject: "mailto:ops@example.com" },
      { sessionExpiresAt: async () => new Date(Date.now() + 60_000) },
    );
    Object.defineProperty(provider, "library", {
      value: Promise.resolve({
        setVapidDetails: () => undefined,
        sendNotification: vi.fn(async () => {
          throw Object.assign(new Error("boom"), { statusCode: 500 });
        }),
      }),
    });
    for (let i = 0; i < 4; i += 1) {
      await provider.deliver(message(), context());
      expect(store.rows.size).toBe(1);
    }
    await provider.deliver(message(), context());
    expect(store.rows.size).toBe(0);
  });

  it("logs only the status code and endpoint host on failure", async () => {
    const store = new MemoryStore();
    await store.save(
      "user-1",
      { endpoint, keys: { p256dh: "abc", auth: "def" } },
      digest,
      "session-1",
    );
    const warn = vi.spyOn(getLogger(), "warn").mockImplementation(() => undefined);
    const provider = new WebPushProvider(
      store,
      { publicKey, privateKey: "private", subject: "mailto:ops@example.com" },
      { sessionExpiresAt: async () => new Date(Date.now() + 60_000) },
    );
    Object.defineProperty(provider, "library", {
      value: Promise.resolve({
        setVapidDetails: () => undefined,
        sendNotification: vi.fn(async () => {
          throw Object.assign(new Error(`full body ${endpoint}`), {
            statusCode: 502,
            body: "secret-body",
          });
        }),
      }),
    });
    await provider.deliver(message(), context());
    expect(warn).toHaveBeenCalledWith("web push send failed", {
      status: 502,
      host: "fcm.googleapis.com",
    });
    const logged = JSON.stringify(warn.mock.calls);
    expect(logged).not.toContain(endpoint);
    expect(logged).not.toContain("secret-body");
  });

  it("reports no push recipient when VAPID digests do not match", async () => {
    const store = new MemoryStore();
    await store.save(
      "user-1",
      { endpoint, keys: { p256dh: "abc", auth: "def" } },
      "other-digest",
      "session-1",
    );
    const provider = new WebPushProvider(
      store,
      { publicKey, privateKey: "private", subject: "mailto:ops@example.com" },
      { sessionExpiresAt: async () => new Date(Date.now() + 60_000) },
    );
    await expect(provider.hasPushRecipient("user-1")).resolves.toBe(false);
  });
});

describe("webPushVapidFromEnv", () => {
  it("warns and disables push when subject is missing with both keys set", () => {
    const warn = vi.fn();
    expect(
      webPushVapidFromEnv(
        {
          VAPID_PUBLIC_KEY: "pub",
          VAPID_PRIVATE_KEY: "priv",
        },
        { warn },
      ),
    ).toBeUndefined();
    expect(warn).toHaveBeenCalledWith("VAPID_SUBJECT is unset; Web Push is disabled.");
  });

  it("still throws when only one key is set", () => {
    expect(() => webPushVapidFromEnv({ VAPID_PUBLIC_KEY: "pub" })).toThrow(/VAPID_/);
  });
});
