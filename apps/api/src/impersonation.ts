import { createHash } from "node:crypto";
import { ORPCError } from "@orpc/server";
import { isHiddenOpsEmail, runAsSystem, runAsSystemInTransaction } from "@rakazo/db";
import { isAdmin } from "./admins.js";
import type { RouterDeps } from "./router.js";

export const IMPERSONATION_TTL_MS = 30 * 60 * 1000;
export const IMPERSONATION_DENIED_AGGREGATE_MS = 60_000;
/** Cap in-memory denied buckets so a long-lived process cannot grow without bound. */
export const IMPERSONATION_DENIED_MAX_BUCKETS = 256;

type ImpersonationDeps = Pick<RouterDeps, "prisma" | "env">;

type TxClient = {
  session: ImpersonationDeps["prisma"]["session"] & {
    updateMany: ImpersonationDeps["prisma"]["session"]["updateMany"];
  };
  securityEvent: ImpersonationDeps["prisma"]["securityEvent"];
  pushToken: ImpersonationDeps["prisma"]["pushToken"];
  webPushSubscription: ImpersonationDeps["prisma"]["webPushSubscription"];
  callPushDevice: ImpersonationDeps["prisma"]["callPushDevice"];
  userDevice: ImpersonationDeps["prisma"]["userDevice"];
  member: ImpersonationDeps["prisma"]["member"];
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
  organizationId?: string | null;
  spaceId?: string | null;
  ip?: string | null;
  userAgent?: string | null;
};

/**
 * Opaque id for one impersonation window — hash of session + expiry so the raw
 * session id never appears in Me / audit metadata.
 */
export function buildImpersonationSessionId(sessionId: string, expiresAt: Date): string {
  const digest = createHash("sha256")
    .update(`imp:${sessionId}:${expiresAt.getTime()}`)
    .digest("hex")
    .slice(0, 32);
  return `imp_${digest}`;
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
          ...(meta.organizationId ? { organizationId: meta.organizationId } : {}),
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

/**
 * Personal orgs are sole-member bootstrap spaces. Impersonation switch scope
 * must be a multi-member organization so the admin cannot pivot across tenants.
 */
export async function assertNonPersonalOrganization(
  deps: ImpersonationDeps,
  organizationId: string,
): Promise<void> {
  // Only need to know whether there is more than one member — stop after two.
  const members = await deps.prisma.member.findMany({
    where: { organizationId },
    select: { userId: true },
    take: 2,
  });
  if (members.length === 0) {
    throw new ORPCError("NOT_FOUND", { message: "Organization not found" });
  }
  const unique = new Set(members.map((row) => row.userId));
  if (unique.size <= 1) {
    throw new ORPCError("FORBIDDEN", { message: "Cannot impersonate within a Personal organization" });
  }
}

async function assertOrganizationMember(
  deps: ImpersonationDeps,
  organizationId: string,
  userId: string,
): Promise<void> {
  const membership = await deps.prisma.member.findFirst({
    where: { organizationId, userId },
    select: { id: true },
  });
  if (!membership) {
    throw new ORPCError("FORBIDDEN", { message: "Target is not a member of that organization" });
  }
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
 * hard cap (session refresh cannot extend it). When `organizationId` is set,
 * it is stored on impersonationOrganizationId as the fixed switch scope
 * (never on activeOrganizationId, which the session may auto-pin later).
 * An unscoped start means teammate switching is denied until stop.
 */
export async function startImpersonation(
  deps: ImpersonationDeps,
  input: {
    sessionId: string;
    adminUserId: string;
    targetUserId: string;
    organizationId?: string | null;
    spaceId?: string | null;
    ip?: string | null;
    userAgent?: string | null;
  },
): Promise<{ impersonationExpiresAt: Date; impersonationSessionId: string }> {
  if (!(await isAdmin(deps, input.adminUserId))) {
    throw new ORPCError("FORBIDDEN", { message: "Admins only" });
  }
  const target = await assertImpersonationTarget(deps, input.adminUserId, input.targetUserId);
  const organizationId = input.organizationId ?? null;
  if (organizationId) {
    await assertNonPersonalOrganization(deps, organizationId);
    await assertOrganizationMember(deps, organizationId, target.id);
  }
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
        impersonationOrganizationId: organizationId,
        // Do not pin activeOrganizationId — that column is for the user's own org
        // switcher and may be auto-updated by later requests.
        activeOrganizationId: null,
      },
    });
    await writeImpersonationAudit(client, {
      type: "ops.impersonation.started",
      adminUserId: input.adminUserId,
      targetUserId: target.id,
      impersonationSessionId,
      procedure: "ops.startImpersonation",
      organizationId,
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
    organizationId: session.impersonationOrganizationId,
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
        impersonationOrganizationId: null,
        activeOrganizationId: null,
      },
    });
    await writeImpersonationAudit(client, auditMeta);
  });
  return { adminUserId, targetUserId, endedSession: false };
}

/**
 * Switch the current impersonation target within the org fixed at start.
 * Preserves the original impersonationExpiresAt (never extends TTL) and runs
 * stop+switch+start audits in a single transaction.
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
  // Scope is fixed at start on impersonationOrganizationId — never activeOrganizationId.
  const scopedOrganizationId = session.impersonationOrganizationId;
  if (!scopedOrganizationId) {
    throw new ORPCError("FORBIDDEN", {
      message: "Impersonation was not started with an organization scope",
    });
  }
  if (input.organizationId !== scopedOrganizationId) {
    throw new ORPCError("FORBIDDEN", { message: "Organization does not match impersonation scope" });
  }
  await assertNonPersonalOrganization(deps, scopedOrganizationId);
  await assertOrganizationMember(deps, scopedOrganizationId, input.targetUserId);
  const target = await assertImpersonationTarget(deps, input.adminUserId, input.targetUserId);

  const previousTargetUserId = session.userId;
  if (previousTargetUserId === target.id) {
    throw new ORPCError("BAD_REQUEST", { message: "Already viewing as that user" });
  }
  const impersonationExpiresAt = session.impersonationExpiresAt;
  if (!impersonationExpiresAt || impersonationExpiresAt.getTime() <= Date.now()) {
    throw new ORPCError("FORBIDDEN", { message: "Impersonation expired" });
  }
  const impersonationSessionId = buildImpersonationSessionId(
    input.sessionId,
    impersonationExpiresAt,
  );
  const expiresAt = new Date(
    Math.min(session.expiresAt.getTime(), impersonationExpiresAt.getTime()),
  );

  await deps.prisma.$transaction(async (tx) => {
    const client = tx as unknown as TxClient;
    await clearPushCreatedDuringImpersonation(client, previousTargetUserId, input.sessionId);
    // Conditional update so a concurrent stop cannot be undone by this switch.
    const switched = await client.session.updateMany({
      where: {
        id: input.sessionId,
        impersonatedBy: input.adminUserId,
        userId: previousTargetUserId,
      },
      data: {
        userId: target.id,
        // Keep the original admin, TTL, and org scope — switch never extends expiry.
        impersonatedBy: input.adminUserId,
        impersonationExpiresAt,
        expiresAt,
        impersonationOrganizationId: scopedOrganizationId,
      },
    });
    if (switched.count === 0) {
      throw new ORPCError("CONFLICT", { message: "Impersonation changed concurrently" });
    }
    await writeImpersonationAudit(client, {
      type: "ops.impersonation.stopped",
      adminUserId: input.adminUserId,
      targetUserId: previousTargetUserId,
      impersonationSessionId,
      procedure: "ops.stopImpersonation",
      reason: "switched",
      organizationId: scopedOrganizationId,
      spaceId: input.spaceId,
      ip: input.ip,
      userAgent: input.userAgent,
    });
    await writeImpersonationAudit(client, {
      type: "ops.impersonation.switched",
      adminUserId: input.adminUserId,
      targetUserId: target.id,
      previousTargetUserId,
      impersonationSessionId,
      procedure: "ops.switchImpersonation",
      reason: "switched",
      organizationId: scopedOrganizationId,
      spaceId: input.spaceId,
      ip: input.ip,
      userAgent: input.userAgent,
    });
    await writeImpersonationAudit(client, {
      type: "ops.impersonation.started",
      adminUserId: input.adminUserId,
      targetUserId: target.id,
      impersonationSessionId,
      procedure: "ops.startImpersonation",
      organizationId: scopedOrganizationId,
      spaceId: input.spaceId,
      ip: input.ip,
      userAgent: input.userAgent,
    });
  });

  return { impersonationExpiresAt, impersonationSessionId };
}

type DeniedBucket = {
  pending: number;
  lastEmittedAt: number;
  touchedAt: number;
};

/** In-memory aggregate keyed by actor so a write-spam doesn't flood security_events. */
const deniedByActor = new Map<string, DeniedBucket>();

function pruneDeniedBuckets(now: number): void {
  for (const [key, bucket] of deniedByActor) {
    if (now - bucket.touchedAt > IMPERSONATION_DENIED_AGGREGATE_MS * 10) {
      deniedByActor.delete(key);
    }
  }
  while (deniedByActor.size > IMPERSONATION_DENIED_MAX_BUCKETS) {
    let oldestKey: string | null = null;
    let oldestTouched = Number.POSITIVE_INFINITY;
    for (const [key, bucket] of deniedByActor) {
      if (bucket.touchedAt < oldestTouched) {
        oldestTouched = bucket.touchedAt;
        oldestKey = key;
      }
    }
    if (!oldestKey) break;
    deniedByActor.delete(oldestKey);
  }
}

/**
 * Rate-limited auditor for denied procedures while impersonating.
 * At most one `ops.impersonation.denied` event per actor per 60s;
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
  pruneDeniedBuckets(now);
  let bucket = deniedByActor.get(input.adminUserId);
  if (!bucket) {
    bucket = { pending: 0, lastEmittedAt: 0, touchedAt: now };
    deniedByActor.set(input.adminUserId, bucket);
  }
  bucket.pending += 1;
  bucket.touchedAt = now;
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
  deniedByActor.clear();
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
          ...(meta.organizationId ? { organizationId: meta.organizationId } : {}),
        },
      },
    }),
  );
}
