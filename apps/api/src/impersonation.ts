import { ORPCError } from "@orpc/server";
import { isHiddenOpsEmail, runAsSystem, runAsSystemInTransaction } from "@rakazo/db";
import { isAdmin } from "./admins.js";
import type { RouterDeps } from "./router.js";

export const IMPERSONATION_TTL_MS = 30 * 60 * 1000;
export const IMPERSONATION_DENIED_AGGREGATE_MS = 60_000;

type ImpersonationDeps = Pick<RouterDeps, "prisma" | "env">;

type TxClient = {
  session: ImpersonationDeps["prisma"]["session"];
  securityEvent: ImpersonationDeps["prisma"]["securityEvent"];
  pushToken: ImpersonationDeps["prisma"]["pushToken"];
  webPushSubscription: ImpersonationDeps["prisma"]["webPushSubscription"];
  callPushDevice: ImpersonationDeps["prisma"]["callPushDevice"];
  userDevice: ImpersonationDeps["prisma"]["userDevice"];
  $queryRaw: ImpersonationDeps["prisma"]["$queryRaw"];
};

export type ImpersonationAuditType =
  | "ops.impersonation.started"
  | "ops.impersonation.stopped"
  | "ops.impersonation.expired"
  | "ops.impersonation.switched"
  | "ops.impersonation.denied";

export type ImpersonationStopReason = "manual" | "expired" | "switched";

export type ImpersonationAuditMeta = {
  type: ImpersonationAuditType;
  adminUserId: string;
  targetUserId: string;
  impersonationSessionId: string;
  procedure?: string;
  reason?: ImpersonationStopReason | string;
  count?: number;
  previousTargetUserId?: string;
  spaceId?: string | null;
  ip?: string | null;
  userAgent?: string | null;
};

/** Derived id for one impersonation window — no DB column required. */
export function buildImpersonationSessionId(sessionId: string, expiresAt: Date): string {
  return `imp_${sessionId}_${expiresAt.getTime()}`;
}

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
          impersonationSessionId: meta.impersonationSessionId,
          ...(meta.procedure ? { procedure: meta.procedure } : {}),
          ...(meta.reason ? { reason: meta.reason } : {}),
          ...(meta.count != null ? { count: meta.count } : {}),
          ...(meta.previousTargetUserId
            ? { previousTargetUserId: meta.previousTargetUserId }
            : {}),
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
  const now = new Date();
  await Promise.all([
    tx.pushToken.deleteMany({ where: { userId: targetUserId, sessionId } }),
    tx.webPushSubscription.deleteMany({ where: { userId: targetUserId, sessionId } }),
    tx.callPushDevice.deleteMany({ where: { userId: targetUserId, sessionId } }),
    // Durable desktop tokens paired while viewing as the target must not survive stop.
    tx.userDevice.updateMany({
      where: { userId: targetUserId, sessionId, revokedAt: null },
      data: { revokedAt: now, revokedBy: "session" },
    }),
  ]);
}

/** Shared target eligibility checks used by start and switch. */
async function assertImpersonationTarget(
  deps: ImpersonationDeps,
  adminUserId: string,
  targetUserId: string,
): Promise<{ id: string; email: string }> {
  if (adminUserId === targetUserId) {
    throw new ORPCError("BAD_REQUEST", { message: "Cannot impersonate yourself" });
  }
  const target = await deps.prisma.user.findUnique({
    where: { id: targetUserId },
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
  return target;
}

/** HTTP/device session helpers: impersonated sessions are denied unless explicitly opted in. */
export function httpActorFromSession<T>(
  session: { actor: T; impersonatedBy: string | null } | null,
  options?: { allowImpersonation?: boolean },
): T | null {
  if (!session?.actor) return null;
  if (session.impersonatedBy && !options?.allowImpersonation) return null;
  return session.actor;
}

export function deviceSessionFromRequest(
  session: { actor: { userId: string }; sessionId: string; impersonatedBy: string | null } | null,
): { userId: string; sessionId: string } | null {
  if (!session || session.impersonatedBy) return null;
  return { userId: session.actor.userId, sessionId: session.sessionId };
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
): Promise<{ impersonationExpiresAt: Date; impersonationSessionId: string }> {
  if (!(await isAdmin(deps, input.adminUserId))) {
    throw new ORPCError("FORBIDDEN", { message: "Admins only" });
  }
  const target = await assertImpersonationTarget(deps, input.adminUserId, input.targetUserId);
  const session = await deps.prisma.session.findUnique({ where: { id: input.sessionId } });
  if (!session || session.userId !== input.adminUserId) {
    throw new ORPCError("UNAUTHORIZED", { message: "Session mismatch" });
  }
  if (session.impersonatedBy) {
    throw new ORPCError("CONFLICT", { message: "Already impersonating" });
  }
  const impersonationExpiresAt = new Date(Date.now() + IMPERSONATION_TTL_MS);
  const impersonationSessionId = buildImpersonationSessionId(
    input.sessionId,
    impersonationExpiresAt,
  );
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
      impersonationSessionId,
      procedure: "ops.startImpersonation",
      spaceId: input.spaceId,
      ip: input.ip,
      userAgent: input.userAgent,
    });
  });

  return { impersonationExpiresAt, impersonationSessionId };
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
    reason?: ImpersonationStopReason;
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
  const reason = input.reason ?? "manual";
  const auditType: ImpersonationAuditType =
    reason === "expired" ? "ops.impersonation.expired" : "ops.impersonation.stopped";
  const expiresAt = session.impersonationExpiresAt ?? session.expiresAt;
  const impersonationSessionId = buildImpersonationSessionId(input.sessionId, expiresAt);
  const admin = await deps.prisma.user.findUnique({
    where: { id: adminUserId },
    select: { id: true },
  });

  const auditMeta: ImpersonationAuditMeta = {
    type: auditType,
    adminUserId,
    targetUserId,
    impersonationSessionId,
    procedure: auditType === "ops.impersonation.stopped" ? "ops.stopImpersonation" : undefined,
    reason: auditType === "ops.impersonation.stopped" ? reason : undefined,
    spaceId: input.spaceId,
    ip: input.ip,
    userAgent: input.userAgent,
  };

  if (!admin) {
    await deps.prisma.$transaction(async (tx) => {
      const client = tx as unknown as TxClient;
      await clearPushCreatedDuringImpersonation(client, targetUserId, input.sessionId);
      await client.session.delete({ where: { id: input.sessionId } });
      await writeImpersonationAudit(client, auditMeta);
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
    await writeImpersonationAudit(client, auditMeta);
  });
  return { adminUserId, targetUserId, endedSession: false };
}

/**
 * Switch the current impersonation target to another member of `organizationId`.
 * Emits stopped (reason=switched) + switched, then starts a fresh window.
 */
export async function switchImpersonation(
  deps: ImpersonationDeps,
  input: {
    sessionId: string;
    adminUserId: string;
    targetUserId: string;
    organizationId: string;
    spaceId?: string | null;
    ip?: string | null;
    userAgent?: string | null;
  },
): Promise<{ impersonationExpiresAt: Date; impersonationSessionId: string }> {
  if (!(await isAdmin(deps, input.adminUserId))) {
    throw new ORPCError("FORBIDDEN", { message: "Admins only" });
  }
  const session = await deps.prisma.session.findUnique({ where: { id: input.sessionId } });
  if (!session?.impersonatedBy) {
    throw new ORPCError("BAD_REQUEST", { message: "Not impersonating" });
  }
  if (session.impersonatedBy !== input.adminUserId) {
    throw new ORPCError("FORBIDDEN", { message: "Impersonator mismatch" });
  }
  const previousTargetUserId = session.userId;
  const previousExpiresAt = session.impersonationExpiresAt ?? session.expiresAt;
  const previousSessionId = buildImpersonationSessionId(input.sessionId, previousExpiresAt);

  const membership = await deps.prisma.member.findFirst({
    where: { organizationId: input.organizationId, userId: input.targetUserId },
    select: { id: true },
  });
  if (!membership) {
    throw new ORPCError("FORBIDDEN", { message: "Target is not a member of that organization" });
  }

  const target = await assertImpersonationTarget(deps, input.adminUserId, input.targetUserId);

  await stopImpersonation(deps, {
    sessionId: input.sessionId,
    expectedAdminUserId: input.adminUserId,
    spaceId: input.spaceId,
    ip: input.ip,
    userAgent: input.userAgent,
    reason: "switched",
  });

  await runAsSystem("append a security event", () =>
    deps.prisma.securityEvent.create({
      data: {
        type: "ops.impersonation.switched",
        userId: input.adminUserId,
        spaceId: input.spaceId ?? null,
        ip: input.ip ?? null,
        userAgent: input.userAgent ?? null,
        metadata: {
          impersonatedBy: input.adminUserId,
          targetUserId: target.id,
          previousTargetUserId,
          impersonationSessionId: previousSessionId,
          procedure: "ops.switchImpersonation",
          reason: "switched",
        },
      },
    }),
  );

  return startImpersonation(deps, {
    sessionId: input.sessionId,
    adminUserId: input.adminUserId,
    targetUserId: target.id,
    spaceId: input.spaceId,
    ip: input.ip,
    userAgent: input.userAgent,
  });
}

type DeniedBucket = {
  pending: number;
  lastEmittedAt: number;
};

/** In-memory aggregate so a write-spam doesn't flood security_events. */
const deniedByImpersonationSession = new Map<string, DeniedBucket>();

/**
 * Rate-limited auditor for denied procedures while impersonating.
 * At most one `ops.impersonation.denied` event per impersonation session per 60s;
 * metadata includes the suppressed count and the latest procedure path.
 */
export async function recordImpersonationDenied(
  deps: ImpersonationDeps,
  input: {
    adminUserId: string;
    targetUserId: string;
    impersonationSessionId: string;
    procedure: string;
    spaceId?: string | null;
    ip?: string | null;
    userAgent?: string | null;
  },
): Promise<void> {
  const now = Date.now();
  let bucket = deniedByImpersonationSession.get(input.impersonationSessionId);
  if (!bucket) {
    bucket = { pending: 0, lastEmittedAt: 0 };
    deniedByImpersonationSession.set(input.impersonationSessionId, bucket);
  }
  bucket.pending += 1;
  if (bucket.lastEmittedAt > 0 && now - bucket.lastEmittedAt < IMPERSONATION_DENIED_AGGREGATE_MS) {
    return;
  }
  const count = bucket.pending;
  bucket.pending = 0;
  bucket.lastEmittedAt = now;

  await runAsSystem("append a security event", () =>
    deps.prisma.securityEvent.create({
      data: {
        type: "ops.impersonation.denied",
        userId: input.adminUserId,
        spaceId: input.spaceId ?? null,
        ip: input.ip ?? null,
        userAgent: input.userAgent ?? null,
        metadata: {
          impersonatedBy: input.adminUserId,
          targetUserId: input.targetUserId,
          impersonationSessionId: input.impersonationSessionId,
          procedure: input.procedure,
          count,
        },
      },
    }),
  );
}

/** Test helper: clear the denied-event aggregate map. */
export function resetImpersonationDeniedAggregatorForTests(): void {
  deniedByImpersonationSession.clear();
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
      reason: "manual",
      ip: opts?.ip,
      userAgent: opts?.userAgent,
    }).catch(() => undefined);
    return { ok: false, reason: "admin_deleted" };
  }

  const stillAdmin = await isAdmin(deps, adminUserId);
  if (!stillAdmin) {
    await stopImpersonation(deps, {
      sessionId,
      reason: "manual",
      ip: opts?.ip,
      userAgent: opts?.userAgent,
    }).catch(() => undefined);
    return { ok: false, reason: "admin_revoked" };
  }

  const expiresAt = session.impersonationExpiresAt;
  if (expiresAt && expiresAt.getTime() <= Date.now()) {
    await stopImpersonation(deps, {
      sessionId,
      reason: "expired",
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
          impersonationSessionId: meta.impersonationSessionId,
          ...(meta.procedure ? { procedure: meta.procedure } : {}),
          ...(meta.reason ? { reason: meta.reason } : {}),
          ...(meta.count != null ? { count: meta.count } : {}),
          ...(meta.previousTargetUserId
            ? { previousTargetUserId: meta.previousTargetUserId }
            : {}),
        },
      },
    }),
  );
}
