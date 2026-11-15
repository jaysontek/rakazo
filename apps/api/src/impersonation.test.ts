import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildImpersonationSessionId,
  enforceImpersonationSession,
  IMPERSONATION_TTL_MS,
  recordImpersonationDenied,
  requireNotImpersonating,
  resetImpersonationDeniedAggregatorForTests,
  startImpersonation,
  stopImpersonation,
  switchImpersonation,
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
  impersonationOrganizationId: string | null;
};

type SecurityEvent = {
  type: string;
  userId: string | null;
  metadata: Record<string, unknown>;
};

type MemberRow = { id: string; organizationId: string; userId: string };

describe("impersonation", () => {
  const users = new Map<string, UserRow>();
  const members: MemberRow[] = [];
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
        async ({ where, data }: { where: { id: string }; data: Partial<SessionRow> }) => {
          if (where.id !== session.id) throw new Error("missing session");
          Object.assign(session, data);
          return session;
        },
      ),
      updateMany: vi.fn(
        async ({
          where,
          data,
        }: {
          where: { id: string; impersonatedBy?: string; userId?: string };
          data: Partial<SessionRow>;
        }) => {
          if (where.id !== session.id) return { count: 0 };
          if (where.impersonatedBy != null && session.impersonatedBy !== where.impersonatedBy) {
            return { count: 0 };
          }
          if (where.userId != null && session.userId !== where.userId) {
            return { count: 0 };
          }
          Object.assign(session, data);
          return { count: 1 };
        },
      ),
      delete: vi.fn(async ({ where }: { where: { id: string } }) => {
        if (where.id !== session.id) throw new Error("missing session");
        session.impersonatedBy = null;
        session.impersonationExpiresAt = null;
        session.impersonationOrganizationId = null;
        return session;
      }),
    },
    member: {
      findFirst: vi.fn(
        async ({ where }: { where: { organizationId: string; userId: string } }) =>
          members.find(
            (row) => row.organizationId === where.organizationId && row.userId === where.userId,
          ) ?? null,
      ),
      findMany: vi.fn(
        async ({ where, take }: { where: { organizationId: string }; take?: number }) => {
          const rows = members
            .filter((row) => row.organizationId === where.organizationId)
            .map((row) => ({ userId: row.userId }));
          return take != null ? rows.slice(0, take) : rows;
        },
      ),
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
          deletedPush.push({
            table: "userDevice",
            userId: where.userId,
            sessionId: where.sessionId,
          });
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
    members.length = 0;
    securityEvents.length = 0;
    deletedPush.length = 0;
    resetImpersonationDeniedAggregatorForTests();
    vi.clearAllMocks();
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
    users.set("user-2", {
      id: "user-2",
      email: "user-2@example.test",
      emailVerified: true,
      deactivatedAt: null,
      adminGrant: null,
    });
    users.set("outsider", {
      id: "outsider",
      email: "outsider@example.test",
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
    members.push(
      { id: "m1", organizationId: "org-1", userId: "user" },
      { id: "m2", organizationId: "org-1", userId: "user-2" },
    );
    session = {
      id: "session-1",
      userId: "admin",
      impersonatedBy: null,
      impersonationExpiresAt: null,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      activeOrganizationId: "org-1",
      impersonationOrganizationId: null,
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

  it("starts impersonation with a hard TTL, hashed session id, and audits in the same transaction", async () => {
    const before = Date.now();
    const result = await startImpersonation(deps as never, {
      sessionId: session.id,
      adminUserId: "admin",
      targetUserId: "user",
      spaceId: "space-1",
    });
    expect(session).toMatchObject({
      userId: "user",
      impersonatedBy: "admin",
      activeOrganizationId: null,
      impersonationOrganizationId: null,
    });
    expect(session.impersonationExpiresAt?.getTime()).toBeGreaterThanOrEqual(
      before + IMPERSONATION_TTL_MS - 1000,
    );
    expect(session.impersonationExpiresAt?.getTime()).toBeLessThanOrEqual(
      Date.now() + IMPERSONATION_TTL_MS,
    );
    expect(result.impersonationSessionId).toBe(
      buildImpersonationSessionId(session.id, session.impersonationExpiresAt!),
    );
    expect(result.impersonationSessionId).toMatch(/^imp_[a-f0-9]{32}$/);
    expect(result.impersonationSessionId).not.toContain(session.id);
    expect(securityEvents).toEqual([
      expect.objectContaining({
        type: "ops.impersonation.started",
        userId: "admin",
        metadata: expect.objectContaining({
          impersonatedBy: "admin",
          targetUserId: "user",
          procedure: "ops.startImpersonation",
          impersonationSessionId: result.impersonationSessionId,
        }),
      }),
    ]);
  });

  it("stores organization scope on start and rejects Personal orgs", async () => {
    await startImpersonation(deps as never, {
      sessionId: session.id,
      adminUserId: "admin",
      targetUserId: "user",
      organizationId: "org-1",
    });
    expect(session.impersonationOrganizationId).toBe("org-1");
    expect(session.activeOrganizationId).toBeNull();

    session.userId = "admin";
    session.impersonatedBy = null;
    session.impersonationExpiresAt = null;
    session.impersonationOrganizationId = null;
    members.push({ id: "m-personal", organizationId: "personal-1", userId: "user" });
    await expect(
      startImpersonation(deps as never, {
        sessionId: session.id,
        adminUserId: "admin",
        targetUserId: "user",
        organizationId: "personal-1",
      }),
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: "Cannot impersonate within a Personal organization",
    });
  });

  it("stop restores the admin, clears push rows, and audits without requiring admin status", async () => {
    session.userId = "user";
    session.impersonatedBy = "admin";
    session.impersonationExpiresAt = new Date(Date.now() + 60_000);
    const sessionId = buildImpersonationSessionId(session.id, session.impersonationExpiresAt);
    deps.env.adminEmails = [];

    const stopped = await stopImpersonation(deps as never, {
      sessionId: session.id,
      expectedAdminUserId: "admin",
      reason: "manual",
    });
    expect(stopped).toEqual({ adminUserId: "admin", targetUserId: "user", endedSession: false });
    expect(session).toMatchObject({
      userId: "admin",
      impersonatedBy: null,
      impersonationExpiresAt: null,
      impersonationOrganizationId: null,
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
        metadata: expect.objectContaining({
          impersonatedBy: "admin",
          targetUserId: "user",
          reason: "manual",
          impersonationSessionId: sessionId,
        }),
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
      expect.objectContaining({
        type: "ops.impersonation.expired",
        metadata: expect.objectContaining({
          impersonationSessionId: expect.stringMatching(/^imp_[a-f0-9]{32}$/),
        }),
      }),
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

  it("switches to another org member, preserves TTL, and emits stopped + switched + started", async () => {
    const originalExpiry = new Date(Date.now() + 60_000);
    session.userId = "user";
    session.impersonatedBy = "admin";
    session.impersonationExpiresAt = originalExpiry;
    session.impersonationOrganizationId = "org-1";
    // activeOrganizationId may auto-pin to something else; switch must ignore it.
    session.activeOrganizationId = "other-org";
    const previousSessionId = buildImpersonationSessionId(session.id, originalExpiry);

    const result = await switchImpersonation(deps as never, {
      sessionId: session.id,
      adminUserId: "admin",
      targetUserId: "user-2",
      organizationId: "org-1",
    });

    expect(session).toMatchObject({
      userId: "user-2",
      impersonatedBy: "admin",
      impersonationOrganizationId: "org-1",
    });
    expect(session.impersonationExpiresAt?.getTime()).toBe(originalExpiry.getTime());
    expect(result.impersonationExpiresAt.getTime()).toBe(originalExpiry.getTime());
    expect(result.impersonationSessionId).toBe(previousSessionId);
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(securityEvents.map((event) => event.type)).toEqual([
      "ops.impersonation.stopped",
      "ops.impersonation.switched",
      "ops.impersonation.started",
    ]);
    expect(securityEvents[0]?.metadata).toMatchObject({
      reason: "switched",
      targetUserId: "user",
      impersonationSessionId: previousSessionId,
    });
    expect(securityEvents[1]?.metadata).toMatchObject({
      previousTargetUserId: "user",
      targetUserId: "user-2",
      procedure: "ops.switchImpersonation",
    });
  });

  it("A→B→A switch never extends the original expiry", async () => {
    const originalExpiry = new Date(Date.now() + 90_000);
    session.userId = "user";
    session.impersonatedBy = "admin";
    session.impersonationExpiresAt = originalExpiry;
    session.impersonationOrganizationId = "org-1";

    await switchImpersonation(deps as never, {
      sessionId: session.id,
      adminUserId: "admin",
      targetUserId: "user-2",
      organizationId: "org-1",
    });
    expect(session.userId).toBe("user-2");
    expect(session.impersonationExpiresAt?.getTime()).toBe(originalExpiry.getTime());

    await switchImpersonation(deps as never, {
      sessionId: session.id,
      adminUserId: "admin",
      targetUserId: "user",
      organizationId: "org-1",
    });
    expect(session.userId).toBe("user");
    expect(session.impersonationExpiresAt?.getTime()).toBe(originalExpiry.getTime());
  });

  it("refuses switch when a concurrent stop already cleared impersonation", async () => {
    session.userId = "user";
    session.impersonatedBy = "admin";
    session.impersonationExpiresAt = new Date(Date.now() + 60_000);
    session.impersonationOrganizationId = "org-1";
    prisma.session.updateMany.mockImplementationOnce(async () => ({ count: 0 }));
    await expect(
      switchImpersonation(deps as never, {
        sessionId: session.id,
        adminUserId: "admin",
        targetUserId: "user-2",
        organizationId: "org-1",
      }),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      message: "Impersonation changed concurrently",
    });
    expect(prisma.session.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: session.id,
          impersonatedBy: "admin",
          userId: "user",
        },
      }),
    );
  });

  it("limits personal-org membership lookup to two rows", async () => {
    await startImpersonation(deps as never, {
      sessionId: session.id,
      adminUserId: "admin",
      targetUserId: "user",
      organizationId: "org-1",
    });
    expect(prisma.member.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { organizationId: "org-1" },
        take: 2,
      }),
    );
  });

  it("refuses switch when the target is outside the organization", async () => {
    session.userId = "user";
    session.impersonatedBy = "admin";
    session.impersonationExpiresAt = new Date(Date.now() + 60_000);
    session.impersonationOrganizationId = "org-1";
    await expect(
      switchImpersonation(deps as never, {
        sessionId: session.id,
        adminUserId: "admin",
        targetUserId: "outsider",
        organizationId: "org-1",
      }),
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: "Target is not a member of that organization",
    });
    expect(session.userId).toBe("user");
  });

  it("refuses switch when caller organizationId does not match the fixed scope", async () => {
    session.userId = "user";
    session.impersonatedBy = "admin";
    session.impersonationExpiresAt = new Date(Date.now() + 60_000);
    session.impersonationOrganizationId = "org-1";
    members.push(
      { id: "m3", organizationId: "org-2", userId: "user" },
      { id: "m4", organizationId: "org-2", userId: "user-2" },
    );
    await expect(
      switchImpersonation(deps as never, {
        sessionId: session.id,
        adminUserId: "admin",
        targetUserId: "user-2",
        organizationId: "org-2",
      }),
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: "Organization does not match impersonation scope",
    });
  });

  it("refuses switch when impersonation has no organization scope", async () => {
    // Unscoped start (accounts list): switching is denied.
    await startImpersonation(deps as never, {
      sessionId: session.id,
      adminUserId: "admin",
      targetUserId: "user",
    });
    expect(session.impersonationOrganizationId).toBeNull();
    await expect(
      switchImpersonation(deps as never, {
        sessionId: session.id,
        adminUserId: "admin",
        targetUserId: "user-2",
        organizationId: "org-1",
      }),
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: "Impersonation was not started with an organization scope",
    });
  });

  it("refuses switch for unscoped start even when activeOrganizationId is later pinned", async () => {
    // Unscoped start leaves impersonationOrganizationId null; a later auto-pin of
    // activeOrganizationId must not unstick switch (scope uses only the former).
    await startImpersonation(deps as never, {
      sessionId: session.id,
      adminUserId: "admin",
      targetUserId: "user",
    });
    expect(session.impersonationOrganizationId).toBeNull();
    session.activeOrganizationId = "org-1";
    await expect(
      switchImpersonation(deps as never, {
        sessionId: session.id,
        adminUserId: "admin",
        targetUserId: "user-2",
        organizationId: "org-1",
      }),
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: "Impersonation was not started with an organization scope",
    });
  });

  it("clears impersonationOrganizationId on stop and expiry", async () => {
    session.userId = "user";
    session.impersonatedBy = "admin";
    session.impersonationExpiresAt = new Date(Date.now() + 60_000);
    session.impersonationOrganizationId = "org-1";
    await stopImpersonation(deps as never, {
      sessionId: session.id,
      expectedAdminUserId: "admin",
      reason: "manual",
    });
    expect(session.impersonationOrganizationId).toBeNull();

    session.userId = "user";
    session.impersonatedBy = "admin";
    session.impersonationExpiresAt = new Date(Date.now() - 1000);
    session.impersonationOrganizationId = "org-1";
    await enforceImpersonationSession(deps as never, session.id);
    expect(session.impersonationOrganizationId).toBeNull();
  });

  it("refuses switch for a non-admin", async () => {
    session.userId = "user";
    session.impersonatedBy = "admin";
    session.impersonationExpiresAt = new Date(Date.now() + 60_000);
    session.impersonationOrganizationId = "org-1";
    deps.env.adminEmails = [];
    await expect(
      switchImpersonation(deps as never, {
        sessionId: session.id,
        adminUserId: "admin",
        targetUserId: "user-2",
        organizationId: "org-1",
      }),
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: "Admins only",
    });
  });

  it("aggregates denied-write audits to one event per actor per minute", async () => {
    const impersonationSessionId = "imp_abcdef0123456789abcdef0123456789";
    await recordImpersonationDenied(deps as never, {
      adminUserId: "admin",
      targetUserId: "user",
      impersonationSessionId,
      procedure: "bots.create",
    });
    await recordImpersonationDenied(deps as never, {
      adminUserId: "admin",
      targetUserId: "user",
      impersonationSessionId,
      procedure: "bots.update",
    });
    await recordImpersonationDenied(deps as never, {
      adminUserId: "admin",
      targetUserId: "user",
      impersonationSessionId,
      procedure: "vault.put",
    });
    expect(securityEvents).toHaveLength(1);
    expect(securityEvents[0]).toMatchObject({
      type: "ops.impersonation.denied",
      userId: "admin",
      metadata: expect.objectContaining({
        procedure: "bots.create",
        count: 1,
        impersonationSessionId,
      }),
    });
  });
});
