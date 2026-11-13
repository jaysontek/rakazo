import { ORPCError } from "@orpc/server";
import type { RouterDeps } from "./router.js";

type AdminDeps = Pick<RouterDeps, "prisma"> & { env: Pick<RouterDeps["env"], "adminEmails"> };

/**
 * Effective admin: RAKAZO_ADMIN_EMAILS bootstrap (verified) OR a DB admin grant
 * (verified and not deactivated).
 */
export async function isAdmin(deps: AdminDeps, userId: string): Promise<boolean> {
  const user = await deps.prisma.user.findUnique({
    where: { id: userId },
    select: {
      email: true,
      emailVerified: true,
      deactivatedAt: true,
      adminGrant: { select: { userId: true } },
    },
  });
  if (!user?.emailVerified) return false;
  const envAdmins = deps.env.adminEmails ?? [];
  if (envAdmins.includes(user.email.toLowerCase())) return true;
  return !user.deactivatedAt && user.adminGrant != null;
}

/** True when the user's email is listed in RAKAZO_ADMIN_EMAILS (UI cannot remove these). */
export async function isEnvBootstrapAdmin(deps: AdminDeps, userId: string): Promise<boolean> {
  const envAdmins = deps.env.adminEmails ?? [];
  if (envAdmins.length === 0) return false;
  const user = await deps.prisma.user.findUnique({
    where: { id: userId },
    select: { email: true, emailVerified: true },
  });
  return Boolean(user?.emailVerified && envAdmins.includes(user.email.toLowerCase()));
}

/** The original admin remains the effective administrator while impersonating another account. */
export function effectiveAdminUserId(session: {
  userId: string;
  impersonatedBy?: string | null;
}): string {
  return session.impersonatedBy ?? session.userId;
}

export async function requireAdmin(deps: AdminDeps, userId: string): Promise<void> {
  if (!(await isAdmin(deps, userId))) throw new ORPCError("FORBIDDEN", { message: "Admins only" });
}
