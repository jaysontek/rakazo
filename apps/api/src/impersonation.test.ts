import { beforeEach, describe, expect, it, vi } from "vitest";
import {
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
  expiresAt: Date;
  activeOrganizationId: string | null;
};

describe("impersonation", () => {
  const users = new Map<string, UserRow>();
  let session: SessionRow;

  const prisma = {
    user: {
      findUnique: vi.fn(async ({ where, select }: { where: { id: string }; select?: unknown }) => {
        const user = users.get(where.id) ?? null;
        if (!user) return null;
        if (select && typeof select === "object" && "adminGrant" in (select as object)) {
          return user;
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
    },
  };

  const deps = {
    prisma,
    env: { adminEmails: ["admin@example.test"] },
  };

  beforeEach(() => {
    users.clear();
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

  it("starts impersonation and stop restores the admin session", async () => {
    await startImpersonation(deps as never, {
      sessionId: session.id,
      adminUserId: "admin",
      targetUserId: "user",
    });
    expect(session).toMatchObject({
      userId: "user",
      impersonatedBy: "admin",
      activeOrganizationId: null,
    });
    expect(session.expiresAt.getTime()).toBeLessThanOrEqual(Date.now() + 30 * 60 * 1000);

    const stopped = await stopImpersonation(deps as never, { sessionId: session.id });
    expect(stopped).toEqual({ adminUserId: "admin", targetUserId: "user" });
    expect(session).toMatchObject({
      userId: "admin",
      impersonatedBy: null,
      activeOrganizationId: null,
    });
  });
});
