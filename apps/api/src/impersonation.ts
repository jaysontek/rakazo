import { ORPCError } from "@orpc/server";
import { isHiddenOpsEmail, runAsSystem, runAsSystemInTransaction } from "@rakazo/db";
import { isAdmin } from "./admins.js";
import type { RouterDeps } from "./router.js";

export const IMPERSONATION_TTL_MS = 30 * 60 * 1000;

type ImpersonationDeps = Pick<RouterDeps, "prisma" | "env">;

type TxClient = {
  session: ImpersonationDeps["prisma"]["session"];
  securityEvent: ImpersonationDeps["prisma"]["securityEvent"];
  pushToken: ImpersonationDeps["prisma"]["pushToken"];
  webPushSubscription: ImpersonationDeps["prisma"]["webPushSubscription"];
  callPushDevice: ImpersonationDeps["prisma"]["callPushDevice"];
  $queryRaw: ImpersonationDeps["prisma"]["$queryRaw"];
};

export type ImpersonationAuditMeta = {
  type: "ops.impersonation.started" | "ops.impersonation.stopped" | "ops.impersonation.expired";
  adminUserId: string;
  targetUserId: string;
  procedure?: string;
  spaceId?: string | null;
  ip?: string | null;
  userAgent?: string | null;
};

async function writeImpersonationAudit(tx: TxClient, meta: ImpersonationAuditMeta): Promise<void> {
  await runAsSystemInTransaction(tx, "append a security event", () =>
    tx.securityEvent.create({
      data: {
        type: meta.type,
        userId: meta.adminUserId,
        spaceId: meta.spaceId ?? null,
        ip: meta.ip ?? null,
        userAgent: meta.userAgent ?? null,
        metadata: {
          impersonatedBy: meta.adminUserId,
          targetUserId: meta.targetUserId,
          ...(meta.procedure ? { procedure: meta.procedure } : {}),
        },
      },
    }),
  );
}

async function clearPushCreatedDuringImpersonation(
  tx: TxClient,
  targetUserId: string,
  sessionId: string,
): Promise<void> {
  await Promise.all([
    tx.pushToken.deleteMany({ where: { userId: targetUserId, sessionId } }),
    tx.webPushSubscription.deleteMany({ where: { userId: targetUserId, sessionId } }),
    tx.callPushDevice.deleteMany({ where: { userId: targetUserId, sessionId } }),
  ]);
}

/**
 * Start viewing as another user on the current session. Stores the real admin
 * id in session.impersonatedBy and sets an independent impersonationExpiresAt
 * hard cap (session refresh cannot extend it).
 */
export async function startImpersonation(
  deps: ImpersonationDeps,
  input: {
    sessionId: string;
    adminUserId: string;
    targetUserId: string;
    spaceId?: string | null;
    ip?: string | null;
    userAgent?: string | null;
  },
): Promise<{ impersonationExpiresAt: Date }> {
  if (!(await isAdmin(deps, input.adminUserId))) {
    throw new ORPCError("FORBIDDEN", { message: "Admins only" });
  }
  if (input.adminUserId === input.targetUserId) {
    throw new ORPCError("BAD_REQUEST", { message: "Cannot impersonate yourself" });
  }
  const target = await deps.prisma.user.findUnique({
    where: { id: input.targetUserId },
    select: { id: true, email: true, emailVerified: true, deactivatedAt: true },
  });
  if (!target || !target.emailVerified || target.deactivatedAt) {
    throw new ORPCError("NOT_FOUND", { message: "User not found" });
  }
  if (isHiddenOpsEmail(target.email)) {
    throw new ORPCError("FORBIDDEN", { message: "Cannot impersonate that account" });
  }
  if (await isAdmin(deps, target.id)) {
    throw new ORPCError("FORBIDDEN", { message: "Cannot impersonate an admin" });
  }
  const session = await deps.prisma.session.findUnique({ where: { id: input.sessionId } });
  if (!session || session.userId !== input.adminUserId) {
    throw new ORPCError("UNAUTHORIZED", { message: "Session mismatch" });
  }
  if (session.impersonatedBy) {
    throw new ORPCError("CONFLICT", { message: "Already impersonating" });
  }
  const impersonationExpiresAt = new Date(Date.now() + IMPERSONATION_TTL_MS);
  const expiresAt = new Date(
    Math.min(session.expiresAt.getTime(), impersonationExpiresAt.getTime()),
  );

  await deps.prisma.$transaction(async (tx) => {
    const client = tx as unknown as TxClient;
    await client.session.update({
      where: { id: input.sessionId },
      data: {
        userId: target.id,
        impersonatedBy: input.adminUserId,
        impersonationExpiresAt,
        expiresAt,
        activeOrganizationId: null,
      },
    });
    await writeImpersonationAudit(client, {
      type: "ops.impersonation.started",
      adminUserId: input.adminUserId,
      targetUserId: target.id,
      procedure: "ops.startImpersonation",
      spaceId: input.spaceId,
      ip: input.ip,
      userAgent: input.userAgent,
    });
  });

  return { impersonationExpiresAt };
}

/**
 * Exit impersonation and restore the admin's own session user.
 * Always allowed when impersonatedBy is set — does not re-check admin status —
 * so a revoked admin can still leave the target account. If the admin row is
 * gone, the session is deleted instead of restoring a missing user.
 */
export async function stopImpersonation(
  deps: ImpersonationDeps,
  input: {
    sessionId: string;
    /** When set, must equal session.impersonatedBy (caller is the real admin). */
    expectedAdminUserId?: string;
    spaceId?: string | null;
    ip?: string | null;
    userAgent?: string | null;
    auditType?: "ops.impersonation.stopped" | "ops.impersonation.expired";
  },
): Promise<{ adminUserId: string; targetUserId: string; endedSession: boolean }> {
  const session = await deps.prisma.session.findUnique({ where: { id: input.sessionId } });
  if (!session?.impersonatedBy) {
    throw new ORPCError("BAD_REQUEST", { message: "Not impersonating" });
  }
  const adminUserId = session.impersonatedBy;
  if (input.expectedAdminUserId != null && input.expectedAdminUserId !== adminUserId) {
    throw new ORPCError("FORBIDDEN", { message: "Impersonator mismatch" });
  }
  const targetUserId = session.userId;
  const admin = await deps.prisma.user.findUnique({
    where: { id: adminUserId },
    select: { id: true },
  });
  const auditType = input.auditType ?? "ops.impersonation.stopped";

  if (!admin) {
    await deps.prisma.$transaction(async (tx) => {
      const client = tx as unknown as TxClient;
      await clearPushCreatedDuringImpersonation(client, targetUserId, input.sessionId);
      await client.session.delete({ where: { id: input.sessionId } });
      await writeImpersonationAudit(client, {
        type: auditType,
        adminUserId,
        targetUserId,
        procedure: auditType === "ops.impersonation.stopped" ? "ops.stopImpersonation" : undefined,
        spaceId: input.spaceId,
        ip: input.ip,
        userAgent: input.userAgent,
      });
    });
    return { adminUserId, targetUserId, endedSession: true };
  }

  await deps.prisma.$transaction(async (tx) => {
    const client = tx as unknown as TxClient;
    await clearPushCreatedDuringImpersonation(client, targetUserId, input.sessionId);
    await client.session.update({
      where: { id: input.sessionId },
      data: {
        userId: adminUserId,
        impersonatedBy: null,
        impersonationExpiresAt: null,
        activeOrganizationId: null,
      },
    });
    await writeImpersonationAudit(client, {
      type: auditType,
      adminUserId,
      targetUserId,
      procedure: auditType === "ops.impersonation.stopped" ? "ops.stopImpersonation" : undefined,
      spaceId: input.spaceId,
      ip: input.ip,
      userAgent: input.userAgent,
    });
  });
  return { adminUserId, targetUserId, endedSession: false };
}

export async function requireNotImpersonating(
  deps: ImpersonationDeps,
  sessionId: string | undefined,
): Promise<void> {
  if (!sessionId) return;
  const session = await deps.prisma.session.findUnique({
    where: { id: sessionId },
    select: { impersonatedBy: true },
  });
  if (session?.impersonatedBy) {
    throw new ORPCError("FORBIDDEN", { message: "Not allowed while impersonating" });
  }
}

export type ImpersonationEnforcement =
  | { ok: true; impersonatedBy: string | null; impersonationExpiresAt: Date | null }
  | { ok: false; reason: "expired" | "admin_revoked" | "admin_deleted" };

/**
 * Re-check impersonation on every authenticated request: TTL hard cap and that
 * the original admin is still an effective admin. Ends the impersonated session
 * (and emits audit) when either check fails.
 */
export async function enforceImpersonationSession(
  deps: ImpersonationDeps,
  sessionId: string,
  opts?: { ip?: string | null; userAgent?: string | null },
): Promise<ImpersonationEnforcement> {
  const session = await deps.prisma.session.findUnique({
    where: { id: sessionId },
    select: {
      userId: true,
      impersonatedBy: true,
      impersonationExpiresAt: true,
    },
  });
  if (!session?.impersonatedBy) {
    return { ok: true, impersonatedBy: null, impersonationExpiresAt: null };
  }

  const adminUserId = session.impersonatedBy;
  const admin = await deps.prisma.user.findUnique({
    where: { id: adminUserId },
    select: { id: true },
  });
  if (!admin) {
    await stopImpersonation(deps, {
      sessionId,
      auditType: "ops.impersonation.stopped",
      ip: opts?.ip,
      userAgent: opts?.userAgent,
    }).catch(() => undefined);
    return { ok: false, reason: "admin_deleted" };
  }

  const stillAdmin = await isAdmin(deps, adminUserId);
  if (!stillAdmin) {
    await stopImpersonation(deps, {
      sessionId,
      auditType: "ops.impersonation.stopped",
      ip: opts?.ip,
      userAgent: opts?.userAgent,
    }).catch(() => undefined);
    return { ok: false, reason: "admin_revoked" };
  }

  const expiresAt = session.impersonationExpiresAt;
  if (expiresAt && expiresAt.getTime() <= Date.now()) {
    await stopImpersonation(deps, {
      sessionId,
      auditType: "ops.impersonation.expired",
      ip: opts?.ip,
      userAgent: opts?.userAgent,
    }).catch(() => undefined);
    return { ok: false, reason: "expired" };
  }

  return {
    ok: true,
    impersonatedBy: adminUserId,
    impersonationExpiresAt: expiresAt,
  };
}

/** For unit tests that need a system write without a transaction. */
export async function recordImpersonationAuditStandalone(
  prisma: ImpersonationDeps["prisma"],
  meta: ImpersonationAuditMeta,
): Promise<void> {
  await runAsSystem("append a security event", () =>
    prisma.securityEvent.create({
      data: {
        type: meta.type,
        userId: meta.adminUserId,
        spaceId: meta.spaceId ?? null,
        ip: meta.ip ?? null,
        userAgent: meta.userAgent ?? null,
        metadata: {
          impersonatedBy: meta.adminUserId,
          targetUserId: meta.targetUserId,
          ...(meta.procedure ? { procedure: meta.procedure } : {}),
        },
      },
    }),
  );
}
