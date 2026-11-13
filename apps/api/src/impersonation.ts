import { ORPCError } from "@orpc/server";
import { isHiddenOpsEmail } from "@rakazo/db";
import { isAdmin } from "./admins.js";
import type { RouterDeps } from "./router.js";

export const IMPERSONATION_TTL_MS = 30 * 60 * 1000;

type ImpersonationDeps = Pick<RouterDeps, "prisma" | "env">;

/**
 * Start viewing as another user on the current session. Stores the real admin
 * id in session.impersonatedBy and shortens the session to 30 minutes.
 */
export async function startImpersonation(
  deps: ImpersonationDeps,
  input: { sessionId: string; adminUserId: string; targetUserId: string },
): Promise<void> {
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
  const expiresAt = new Date(
    Math.min(session.expiresAt.getTime(), Date.now() + IMPERSONATION_TTL_MS),
  );
  await deps.prisma.session.update({
    where: { id: input.sessionId },
    data: {
      userId: target.id,
      impersonatedBy: input.adminUserId,
      expiresAt,
      activeOrganizationId: null,
    },
  });
}

/** Exit impersonation and restore the admin's own session user. */
export async function stopImpersonation(
  deps: ImpersonationDeps,
  input: { sessionId: string },
): Promise<{ adminUserId: string; targetUserId: string }> {
  const session = await deps.prisma.session.findUnique({ where: { id: input.sessionId } });
  if (!session?.impersonatedBy) {
    throw new ORPCError("BAD_REQUEST", { message: "Not impersonating" });
  }
  const adminUserId = session.impersonatedBy;
  const targetUserId = session.userId;
  await deps.prisma.session.update({
    where: { id: input.sessionId },
    data: {
      userId: adminUserId,
      impersonatedBy: null,
      activeOrganizationId: null,
    },
  });
  return { adminUserId, targetUserId };
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
