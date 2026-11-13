import { createHmac } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const hooks = vi.hoisted(() => {
  const sessionForAuthHook = vi.fn();
  return {
    sessionForAuthHook,
    real: null as null | ((...args: never[]) => Promise<unknown>),
  };
});

vi.mock("./account-security.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./account-security.js")>();
  hooks.real = actual.sessionForAuthHook as never;
  hooks.sessionForAuthHook.mockImplementation(actual.sessionForAuthHook as never);
  return {
    ...actual,
    sessionForAuthHook: (...args: never[]) => hooks.sessionForAuthHook(...args),
  };
});

vi.mock("better-auth/adapters/prisma", async () => {
  const { memoryAdapter } = await import("better-auth/adapters/memory");
  return {
    prismaAdapter: (prisma: { authData: Record<string, { id?: unknown }[]> }) => {
      const factory = memoryAdapter(prisma.authData);
      return (options: Parameters<typeof factory>[0]) => factory(options);
    },
  };
});

import { createAuth } from "./index.js";

const secret = "offline-auth-secret-at-least-32-characters";

function signedToken(token: string) {
  return `${token}.${createHmac("sha256", secret).update(token).digest("base64")}`;
}

describe("impersonation auth hooks", () => {
  const authData: Record<string, Record<string, unknown>[]> = {
    user: [],
    account: [],
    session: [],
    verification: [],
  };

  beforeEach(() => {
    for (const rows of Object.values(authData)) rows.length = 0;
    hooks.sessionForAuthHook.mockReset();
    if (hooks.real) hooks.sessionForAuthHook.mockImplementation(hooks.real as never);
  });

  it("caps session refresh through a real getSession while impersonating", async () => {
    const now = Date.now();
    const impersonationExpiresAt = new Date(now + 30 * 60_000);
    const currentExpiresAt = new Date(now + 2 * 24 * 60 * 60_000);
    const token = "impersonation-session-token";
    authData.user!.push({
      id: "target",
      name: "Target",
      email: "target@example.test",
      emailVerified: true,
      createdAt: new Date(now - 60_000),
      updatedAt: new Date(now - 60_000),
      deactivatedAt: null,
    });
    authData.session!.push({
      id: "session-1",
      token,
      userId: "target",
      expiresAt: currentExpiresAt,
      createdAt: new Date(now - 60_000),
      updatedAt: new Date(now - 60_000),
      impersonatedBy: "admin",
      impersonationExpiresAt,
    });

    const prisma = {
      authData,
      session: {
        findUnique: vi.fn(async ({ where }: { where: { id?: string; token?: string } }) => {
          const row = authData.session!.find(
            (session) => session.id === where.id || session.token === where.token,
          );
          return row ? { ...row } : null;
        }),
      },
      user: {
        findUnique: vi.fn(async () => ({ locale: null })),
      },
      spaceMember: { findFirst: vi.fn(async () => ({ spaceId: "space-1", userId: "target" })) },
      $executeRaw: vi.fn(async () => 0),
      $transaction: vi.fn(async (run: (tx: unknown) => Promise<unknown>) => run(prisma)),
    };

    const auth = createAuth(prisma as never, {
      secret,
      baseURL: "https://api.example.test",
      webOrigin: "https://app.example.test",
      signupsEnabled: "true",
      signupAllowlist: "",
    });

    const result = await auth.api.getSession({
      headers: new Headers({ authorization: `Bearer ${signedToken(token)}` }),
    });
    expect(result?.user.id).toBe("target");
    const stored = authData.session!.find((row) => row.id === "session-1")!;
    expect(new Date(stored.expiresAt as Date).getTime()).toBeLessThanOrEqual(
      impersonationExpiresAt.getTime(),
    );
    expect(prisma.session.findUnique).toHaveBeenCalled();
  });

  it("denies passkey and link-social when sessionForAuthHook throws with a bearer", async () => {
    hooks.sessionForAuthHook.mockRejectedValue(new Error("session lookup failed"));
    const prisma = {
      authData,
      session: { findUnique: vi.fn(async () => null) },
      user: { findUnique: vi.fn(async () => ({ locale: null })) },
      spaceMember: { findFirst: vi.fn(async () => null) },
      $executeRaw: vi.fn(async () => 0),
      $transaction: vi.fn(async (run: (tx: unknown) => Promise<unknown>) => run(prisma)),
    };
    const auth = createAuth(prisma as never, {
      secret,
      baseURL: "https://api.example.test",
      webOrigin: "https://app.example.test",
      signupsEnabled: "true",
      signupAllowlist: "",
    });
    const headers = {
      "content-type": "application/json",
      authorization: `Bearer ${signedToken("any-session-token")}`,
      origin: "https://app.example.test",
    };
    const passkey = await auth.handler(
      new Request("https://api.example.test/api/auth/passkey/generate-register-options", {
        method: "GET",
        headers,
      }),
    );
    expect(passkey.status).toBe(403);

    const link = await auth.handler(
      new Request("https://api.example.test/api/auth/link-social", {
        method: "POST",
        headers,
        body: JSON.stringify({
          provider: "oidc",
          callbackURL: "https://app.example.test/app",
        }),
      }),
    );
    expect(link.status).toBe(403);
  });

});
