import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  enforceImpersonationSession,
  IMPERSONATION_TTL_MS,
  requireNotImpersonating,
  startImpersonation,
  stopImpersonation,
} from "./impersonation.js";

type UserRow = {
  id: string;
  email: string;
  emailVerified: boolean;
  deactivatedAt: Date | null;
  adminGrant: { userId: string } | null;
};

type SessionRow = {
  id: string;
  userId: string;
  impersonatedBy: string | null;
  impersonationExpiresAt: Date | null;
  expiresAt: Date;
  activeOrganizationId: string | null;
};

type SecurityEvent = {
  type: string;
  userId: string | null;
  metadata: Record<string, unknown>;
};

describe("impersonation", () => {
  const users = new Map<string, UserRow>();
  let session: SessionRow;
  const securityEvents: SecurityEvent[] = [];
  const deletedPush: Array<{ table: string; userId: string; sessionId: string }> = [];

  const prisma = {
    user: {
      findUnique: vi.fn(async ({ where, select }: { where: { id: string }; select?: unknown }) => {
        const user = users.get(where.id) ?? null;
        if (!user) return null;
        if (select && typeof select === "object" && "adminGrant" in (select as object)) {
          return user;
        }
        if (select && typeof select === "object" && Object.keys(select as object).length === 1) {
          return { id: user.id };
        }
        return {
          id: user.id,
          email: user.email,
          emailVerified: user.emailVerified,
          deactivatedAt: user.deactivatedAt,
        };
      }),
    },
    session: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) =>
        where.id === session.id ? { ...session } : null,
      ),
      update: vi.fn(
        async ({
          where,
          data,
        }: {
          where: { id: string };
          data: Partial<SessionRow>;
        }) => {
          if (where.id !== session.id) throw new Error("missing session");
          Object.assign(session, data);
          return session;
        },
      ),
      delete: vi.fn(async ({ where }: { where: { id: string } }) => {
        if (where.id !== session.id) throw new Error("missing session");
        session.impersonatedBy = null;
        session.impersonationExpiresAt = null;
        return session;
      }),
    },
    securityEvent: {
      create: vi.fn(async ({ data }: { data: SecurityEvent }) => {
        securityEvents.push(data);
        return data;
      }),
    },
    pushToken: {
      deleteMany: vi.fn(async ({ where }: { where: { userId: string; sessionId: string } }) => {
        deletedPush.push({ table: "pushToken", ...where });
        return { count: 1 };
      }),
    },
    webPushSubscription: {
      deleteMany: vi.fn(async ({ where }: { where: { userId: string; sessionId: string } }) => {
        deletedPush.push({ table: "webPush", ...where });
        return { count: 1 };
      }),
    },
    callPushDevice: {
      deleteMany: vi.fn(async ({ where }: { where: { userId: string; sessionId: string } }) => {
        deletedPush.push({ table: "callPush", ...where });
        return { count: 1 };
      }),
    },
    userDevice: {
      updateMany: vi.fn(
        async ({
          where,
        }: {
          where: { userId: string; sessionId: string; revokedAt: null };
          data: { revokedAt: Date; revokedBy: string };
        }) => {
          deletedPush.push({ table: "userDevice", userId: where.userId, sessionId: where.sessionId });
          return { count: 1 };
        },
      ),
    },
    $queryRaw: vi.fn(async () => [{ bypass: "off", key: "", login: "test" }]),
    $transaction: vi.fn(async (fn: (tx: typeof prisma) => Promise<unknown>) => fn(prisma)),
  };

  const deps = {
    prisma,
    env: { adminEmails: ["admin@example.test"] as string[] },
  };

  beforeEach(() => {
    users.clear();
    securityEvents.length = 0;
    deletedPush.length = 0;
    deps.env.adminEmails = ["admin@example.test"];
    users.set("admin", {
      id: "admin",
      email: "admin@example.test",
      emailVerified: true,
      deactivatedAt: null,
      adminGrant: null,
    });
    users.set("user", {
      id: "user",
      email: "user@example.test",
      emailVerified: true,
      deactivatedAt: null,
      adminGrant: null,
    });
    users.set("other-admin", {
      id: "other-admin",
      email: "other-admin@example.test",
      emailVerified: true,
      deactivatedAt: null,
      adminGrant: { userId: "other-admin" },
    });
    users.set("hidden-apex", {
      id: "hidden-apex",
      email: "ops@builddrive.net",
      emailVerified: true,
      deactivatedAt: null,
      adminGrant: null,
    });
    users.set("hidden-sub", {
      id: "hidden-sub",
      email: "dev@corp.builddrive.net",
      emailVerified: true,
      deactivatedAt: null,
      adminGrant: null,
    });
    session = {
      id: "session-1",
      userId: "admin",
      impersonatedBy: null,
      impersonationExpiresAt: null,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      activeOrganizationId: "org-1",
    };
  });

  it("refuses to impersonate another admin", async () => {
    await expect(
      startImpersonation(deps as never, {
        sessionId: session.id,
        adminUserId: "admin",
        targetUserId: "other-admin",
      }),
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: "Cannot impersonate an admin",
    });
    expect(session.userId).toBe("admin");
    expect(session.impersonatedBy).toBeNull();
  });

  it("refuses builddrive.net and subdomain targets", async () => {
    await expect(
      startImpersonation(deps as never, {
        sessionId: session.id,
        adminUserId: "admin",
        targetUserId: "hidden-apex",
      }),
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: "Cannot impersonate that account",
    });
    await expect(
      startImpersonation(deps as never, {
        sessionId: session.id,
        adminUserId: "admin",
        targetUserId: "hidden-sub",
      }),
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: "Cannot impersonate that account",
    });
  });

  it("refuses starting while already impersonating", async () => {
    session.impersonatedBy = "admin";
    await expect(
      startImpersonation(deps as never, {
        sessionId: session.id,
        adminUserId: "admin",
        targetUserId: "user",
      }),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      message: "Already impersonating",
    });
    session.userId = "user";
    await expect(requireNotImpersonating(deps as never, session.id)).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: "Not allowed while impersonating",
    });
  });

  it("starts impersonation with a hard TTL and audits in the same transaction", async () => {
    const before = Date.now();
    await startImpersonation(deps as never, {
      sessionId: session.id,
      adminUserId: "admin",
      targetUserId: "user",
      spaceId: "space-1",
    });
    expect(session).toMatchObject({
      userId: "user",
      impersonatedBy: "admin",
      activeOrganizationId: null,
    });
    expect(session.impersonationExpiresAt?.getTime()).toBeGreaterThanOrEqual(before + IMPERSONATION_TTL_MS - 1000);
    expect(session.impersonationExpiresAt?.getTime()).toBeLessThanOrEqual(Date.now() + IMPERSONATION_TTL_MS);
    expect(securityEvents).toEqual([
      expect.objectContaining({
        type: "ops.impersonation.started",
        userId: "admin",
        metadata: expect.objectContaining({
          impersonatedBy: "admin",
          targetUserId: "user",
          procedure: "ops.startImpersonation",
        }),
      }),
    ]);
  });

  it("stop restores the admin, clears push rows, and audits without requiring admin status", async () => {
    session.userId = "user";
    session.impersonatedBy = "admin";
    session.impersonationExpiresAt = new Date(Date.now() + 60_000);
    // Revoke the admin mid-impersonation — stop must still exit.
    users.set("admin", {
      id: "admin",
      email: "admin@example.test",
      emailVerified: true,
      deactivatedAt: null,
      adminGrant: null,
    });
    deps.env.adminEmails = [];

    const stopped = await stopImpersonation(deps as never, {
      sessionId: session.id,
      expectedAdminUserId: "admin",
    });
    expect(stopped).toEqual({ adminUserId: "admin", targetUserId: "user", endedSession: false });
    expect(session).toMatchObject({
      userId: "admin",
      impersonatedBy: null,
      impersonationExpiresAt: null,
      activeOrganizationId: null,
    });
    expect(deletedPush).toEqual(
      expect.arrayContaining([
        { table: "pushToken", userId: "user", sessionId: "session-1" },
        { table: "webPush", userId: "user", sessionId: "session-1" },
        { table: "callPush", userId: "user", sessionId: "session-1" },
        { table: "userDevice", userId: "user", sessionId: "session-1" },
      ]),
    );
    expect(securityEvents).toEqual([
      expect.objectContaining({
        type: "ops.impersonation.stopped",
        metadata: expect.objectContaining({ impersonatedBy: "admin", targetUserId: "user" }),
      }),
    ]);
  });

  it("ends the session when the impersonating admin was deleted", async () => {
    session.userId = "user";
    session.impersonatedBy = "gone-admin";
    session.impersonationExpiresAt = new Date(Date.now() + 60_000);
    const result = await stopImpersonation(deps as never, { sessionId: session.id });
    expect(result.endedSession).toBe(true);
    expect(prisma.session.delete).toHaveBeenCalled();
  });

  it("enforces TTL expiry and emits impersonation-expired", async () => {
    session.userId = "user";
    session.impersonatedBy = "admin";
    session.impersonationExpiresAt = new Date(Date.now() - 1000);
    const result = await enforceImpersonationSession(deps as never, session.id);
    expect(result).toEqual({ ok: false, reason: "expired" });
    expect(securityEvents).toEqual([
      expect.objectContaining({ type: "ops.impersonation.expired" }),
    ]);
    expect(session.impersonatedBy).toBeNull();
  });

  it("ends impersonation when the admin is revoked mid-session", async () => {
    session.userId = "user";
    session.impersonatedBy = "admin";
    session.impersonationExpiresAt = new Date(Date.now() + 60_000);
    deps.env.adminEmails = [];
    const result = await enforceImpersonationSession(deps as never, session.id);
    expect(result).toEqual({ ok: false, reason: "admin_revoked" });
    expect(session.impersonatedBy).toBeNull();
  });

  it("ends impersonation when the admin row is missing", async () => {
    session.userId = "user";
    session.impersonatedBy = "missing";
    session.impersonationExpiresAt = new Date(Date.now() + 60_000);
    const result = await enforceImpersonationSession(deps as never, session.id);
    expect(result).toEqual({ ok: false, reason: "admin_deleted" });
  });
});
