import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { mountAuditExportRoute } from "./audit-export.js";
import { BILLING_RETURN_PATH } from "./billing.js";
import { mountBillingRoutes } from "./billing-webhook.js";
import { deviceSessionFromRequest, httpActorFromSession } from "./impersonation.js";
import { mountUserDeviceRoutes } from "./user-devices.js";
import { mountVoiceHttpRoutes } from "./voice.js";

const actor = {
  spaceId: "space-1",
  userId: "target",
  email: "target@example.test",
  isDeploymentOwner: false,
};

describe("httpActorFromSession", () => {
  it("returns null for impersonated sessions unless opted in", () => {
    const session = { actor, impersonatedBy: "admin" };
    expect(httpActorFromSession(session)).toBeNull();
    expect(httpActorFromSession(session, { allowImpersonation: true })).toEqual(actor);
    expect(httpActorFromSession({ actor, impersonatedBy: null })).toEqual(actor);
    expect(httpActorFromSession(null)).toBeNull();
  });
});

describe("deviceSessionFromRequest", () => {
  it("refuses every device route while impersonating", () => {
    expect(
      deviceSessionFromRequest({
        actor: { userId: "target" },
        sessionId: "s1",
        impersonatedBy: "admin",
      }),
    ).toBeNull();
    expect(
      deviceSessionFromRequest({
        actor: { userId: "target" },
        sessionId: "s1",
        impersonatedBy: null,
      }),
    ).toEqual({ userId: "target", sessionId: "s1" });
  });
});

describe("HTTP routes deny impersonated sessions", () => {
  const sessionActor = async (request: Request) =>
    httpActorFromSession(
      request.headers.get("x-impersonating")
        ? { actor, impersonatedBy: "admin" }
        : { actor, impersonatedBy: null },
    );

  it("denies account import, voice, billing return, and audit export while impersonating", async () => {
    const app = new Hono();
    app.post("/api/account/import", async (c) => {
      const found = await sessionActor(c.req.raw);
      if (!found) return c.text("Unauthorized", 401);
      return c.text("ok");
    });
    mountVoiceHttpRoutes(app, {} as never, async (c) => sessionActor(c.req.raw));
    mountAuditExportRoute(app, { prisma: {} as never, sessionActor });
    mountBillingRoutes(app, {
      billing: { syncForActor: async () => undefined } as never,
      provider: { parseWebhook: () => "ignored" } as never,
      webOrigin: "https://app.example.test",
      authenticate: sessionActor,
    });

    const headers = { "x-impersonating": "1", "content-type": "application/json" };
    expect((await app.request("/api/account/import", { method: "POST", headers })).status).toBe(
      401,
    );
    expect(
      (await app.request("/api/voice/speak", { method: "POST", headers, body: "{}" })).status,
    ).toBe(401);
    expect(
      (await app.request("/api/voice/transcribe", { method: "POST", headers, body: "{}" })).status,
    ).toBe(401);
    expect((await app.request("/api/audit-events/export", { headers })).status).toBe(401);
    const billing = await app.request(BILLING_RETURN_PATH, { headers });
    expect(billing.status).toBe(303);
    expect(billing.headers.get("location")).toBe("https://app.example.test");
  });

  it("denies device pair while impersonating", async () => {
    const app = new Hono();
    mountUserDeviceRoutes(app, {
      prisma: {
        $transaction: async () => null,
        userDevice: { count: async () => 0, create: async () => ({ id: "d1" }) },
      } as never,
      hub: { authenticate: async () => null } as never,
      devices: { releaseSignedOut: async () => undefined, list: async () => [] } as never,
      forwardSecret: "x".repeat(64),
      session: async (request) =>
        deviceSessionFromRequest(
          request.headers.get("x-impersonating")
            ? { actor: { userId: "target" }, sessionId: "s1", impersonatedBy: "admin" }
            : { actor: { userId: "target" }, sessionId: "s1", impersonatedBy: null },
        ),
      trustedOrigin: () => true,
    });
    const denied = await app.request("/api/devices/pair", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-impersonating": "1",
      },
      body: JSON.stringify({ name: "Laptop", platform: "darwin" }),
    });
    expect(denied.status).toBe(401);
  });
});
