import { createHmac } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createAuth } from "./index.js";

const secret = "offline-auth-secret-at-least-32-characters";

vi.mock("better-auth/adapters/prisma", async () => {
  const { memoryAdapter } = await import("better-auth/adapters/memory");
  return {
    prismaAdapter: (prisma: { authData: Record<string, { id?: unknown }[]> }) => {
      const factory = memoryAdapter(prisma.authData);
      return (options: Parameters<typeof factory>[0]) => factory(options);
    },
  };
});

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
  });

  it("caps session refresh through a real getSession while impersonating", async () => {
    const now = Date.now();
    const impersonationExpiresAt = new Date(now + 30 * 60_000);
    // Young enough that better-auth defaults (7d expiresIn / 1d updateAge) refresh it.
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
    // Refresh must not push past the impersonation hard cap.
    expect(new Date(stored.expiresAt as Date).getTime()).toBeLessThanOrEqual(
      impersonationExpiresAt.getTime(),
    );
    // And must not adopt a full 7-day extension past the pre-refresh expiry when capped.
    expect(new Date(stored.expiresAt as Date).getTime()).toBeLessThanOrEqual(
      Math.max(currentExpiresAt.getTime(), impersonationExpiresAt.getTime()),
    );
    expect(prisma.session.findUnique).toHaveBeenCalled();
  });

  it("denies non-allowlisted auth paths when the impersonation lookup throws", async () => {
    const token = "lookup-error-token";
    const now = Date.now();
    authData.user!.push({
      id: "target",
      name: "Target",
      email: "target@example.test",
      emailVerified: true,
      createdAt: new Date(now),
      updatedAt: new Date(now),
      deactivatedAt: null,
    });
    authData.session!.push({
      id: "session-err",
      token,
      userId: "target",
      expiresAt: new Date(now + 60 * 60_000),
      createdAt: new Date(now),
      updatedAt: new Date(now),
      impersonatedBy: "admin",
      impersonationExpiresAt: new Date(now + 30 * 60_000),
    });
    authData.account!.push({
      id: "account-1",
      userId: "target",
      providerId: "credential",
      accountId: "target",
      password: "hashed",
      createdAt: new Date(now),
      updatedAt: new Date(now),
    });

    const prisma = {
      authData,
      session: {
        findUnique: vi.fn(async () => {
          throw new Error("db unavailable");
        }),
      },
      user: { findUnique: vi.fn(async () => ({ locale: null })) },
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

    const response = await auth.handler(
      new Request("https://api.example.test/api/auth/change-password", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${signedToken(token)}`,
          origin: "https://app.example.test",
        },
        body: JSON.stringify({
          currentPassword: "offline-password12",
          newPassword: "offline-password99",
        }),
      }),
    );
    expect(response.status).toBeGreaterThanOrEqual(400);
  });
});
