import { createRouterClient } from "@orpc/server";
import type { Actor } from "@rakazo/contracts";
import { describe, expect, it, vi } from "vitest";
import type { RouterDeps } from "./router.js";
import { createRouter } from "./router.js";

const actor = {
  spaceId: "space-1",
  userId: "user-1",
  email: "user@rakazo.test",
  isDeploymentOwner: false,
} satisfies Actor;

const subscription = {
  endpoint: "https://fcm.googleapis.com/fcm/send/device-1",
  keys: {
    p256dh: "BPUBLICkeyExampleValueThatIsBase64urlEncodedXX",
    auth: "tBHItJI5svbpez7KI4CCXg",
  },
};

function setup(options: { withPush?: boolean; sessionId?: string | null } = {}) {
  const withPush = options.withPush !== false;
  const save = vi.fn(async () => undefined);
  const remove = vi.fn(async () => undefined);
  const hasEndpoint = vi.fn(async () => false);
  const endSession = vi.fn(async () => undefined);
  const deps = {
    prisma: {},
    pushTokens: {
      load: async () => undefined,
      save: async () => undefined,
      importLegacy: async () => false,
      remove: async () => undefined,
      endSession: async () => undefined,
    },
    webPushSubscriptions: withPush
      ? { save, remove, list: async () => [], hasEndpoint, endSession }
      : undefined,
    webPush: withPush
      ? {
          publicKey: () => "test-public-key",
          vapidDigest: () => "digest",
        }
      : undefined,
    env: {
      webOrigin: "http://127.0.0.1:5173",
      screenProxySecret: "fake-test-secret",
      sandboxProvider: "fake",
    },
    dataDir: "/tmp/rakazo-router-test",
  } as unknown as RouterDeps;
  const sessionId = options.sessionId === undefined ? "session-1" : options.sessionId;
  const client = createRouterClient(createRouter(deps), {
    context: { actor, ...(sessionId ? { sessionId } : {}) } as never,
  }).notifications;
  const anonymous = createRouterClient(createRouter(deps), {
    context: {} as never,
  }).notifications;
  return { client, anonymous, save, remove, hasEndpoint };
}

describe("web push notification routes", () => {
  it("requires a signed-in user", async () => {
    const { anonymous } = setup();
    await expect(anonymous.webPushStatus()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(anonymous.registerWebPush(subscription)).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
  });

  it("requires a session when registering", async () => {
    const { client, save } = setup({ sessionId: null });
    await expect(client.registerWebPush(subscription)).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
    expect(save).not.toHaveBeenCalled();
  });

  it("reports unavailable when VAPID is unset", async () => {
    const { client } = setup({ withPush: false });
    await expect(client.webPushStatus()).resolves.toEqual({ available: false });
    await expect(client.registerWebPush(subscription)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("saves a subscription for the signed-in session", async () => {
    const { client, save, hasEndpoint } = setup();
    await expect(client.webPushStatus()).resolves.toEqual({
      available: true,
      publicKey: "test-public-key",
    });
    await expect(client.webPushStatus({ endpoint: subscription.endpoint })).resolves.toEqual({
      available: true,
      publicKey: "test-public-key",
      registered: false,
    });
    expect(hasEndpoint).toHaveBeenCalledWith("user-1", subscription.endpoint);
    await expect(client.registerWebPush(subscription)).resolves.toEqual({ ok: true });
    expect(save).toHaveBeenCalledWith("user-1", subscription, "digest", "session-1");
  });

  it("rejects an invalid subscription payload", async () => {
    const { client, save } = setup();
    await expect(
      client.registerWebPush({
        endpoint: "http://insecure.example/push",
        keys: subscription.keys,
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(save).not.toHaveBeenCalled();
  });

  it("rejects SSRF-shaped endpoints at the contract boundary", async () => {
    const { client, save } = setup();
    await expect(
      client.registerWebPush({
        endpoint: "https://169.254.169.254/latest",
        keys: subscription.keys,
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(save).not.toHaveBeenCalled();
  });

  it("deletes only the caller's endpoint", async () => {
    const { client, remove } = setup();
    await expect(client.unregisterWebPush({ endpoint: subscription.endpoint })).resolves.toEqual({
      ok: true,
    });
    expect(remove).toHaveBeenCalledWith("user-1", subscription.endpoint);
  });
});

describe("web push 410 cleanup", () => {
  it("removes a subscription when the push service returns 410", async () => {
    const removeByEndpoint = vi.fn(async () => undefined);
    const { WebPushProvider, vapidPublicKeyDigest } = await import("@rakazo/adapters");
    const publicKey = "test-public";
    const store = {
      list: async () => [
        {
          id: "sub-1",
          userId: "user-1",
          sessionId: "session-1",
          endpoint: "https://fcm.googleapis.com/fcm/send/gone",
          keys: { p256dh: "abc", auth: "def" },
          vapidDigest: vapidPublicKeyDigest(publicKey),
          failureCount: 0,
        },
      ],
      hasEndpoint: async () => true,
      save: async () => undefined,
      remove: async () => undefined,
      removeByEndpoint,
      endSession: async () => undefined,
      recordSuccess: async () => undefined,
      recordFailure: async () => undefined,
    };
    const provider = new WebPushProvider(
      store,
      {
        publicKey,
        privateKey: "private",
        subject: "mailto:ops@example.com",
      },
      { sessionExpiresAt: async () => new Date(Date.now() + 60_000) },
    );
    const sendNotification = vi.fn(async () => {
      throw Object.assign(new Error("Gone"), { statusCode: 410 });
    });
    Object.defineProperty(provider, "library", {
      value: Promise.resolve({
        setVapidDetails: () => undefined,
        sendNotification,
      }),
      writable: true,
    });
    await expect(
      provider.deliver(
        {
          kind: "completion",
          title: "Hi",
          body: "Body",
          botId: "bot",
          threadId: "thread",
        },
        {
          operationId: "notify",
          traceId: "t",
          spaceId: "space",
          userId: "user-1",
          botId: "bot",
          signal: new AbortController().signal,
        },
      ),
    ).resolves.toBe("undeliverable");
    expect(removeByEndpoint).toHaveBeenCalledWith("https://fcm.googleapis.com/fcm/send/gone");
  });
});
