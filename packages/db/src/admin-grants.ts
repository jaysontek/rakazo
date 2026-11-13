import type { PrismaClient } from "./client.js";
import { Prisma } from "./client.js";
import { isHiddenOpsEmail } from "./ops-email-filter.js";

type GrantPrisma = Pick<PrismaClient, "adminGrant" | "user" | "$transaction" | "$executeRaw">;

export type AdminGrantRow = {
  userId: string;
  email: string;
  name: string;
  grantedById: string | null;
  grantedByEmail: string | null;
  createdAt: string;
  /** True when the email is also listed in RAKAZO_ADMIN_EMAILS (not removable in UI). */
  envBootstrap: boolean;
};

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export async function userHasAdminGrant(
  prisma: Pick<GrantPrisma, "adminGrant">,
  userId: string,
): Promise<boolean> {
  const row = await prisma.adminGrant.findUnique({ where: { userId }, select: { userId: true } });
  return row != null;
}

export async function listAdminGrants(
  prisma: GrantPrisma,
  envEmails: readonly string[] = [],
): Promise<AdminGrantRow[]> {
  const env = new Set(envEmails.map(normalizeEmail));
  const rows = await prisma.adminGrant.findMany({
    orderBy: { createdAt: "asc" },
    include: {
      user: { select: { email: true, name: true } },
      grantedBy: { select: { email: true } },
    },
  });
  return rows.map((row) => ({
    userId: row.userId,
    email: row.user.email,
    name: row.user.name,
    grantedById: row.grantedById,
    grantedByEmail: row.grantedBy?.email ?? null,
    createdAt: row.createdAt.toISOString(),
    envBootstrap: env.has(normalizeEmail(row.user.email)),
  }));
}

/**
 * Grant /admin/ops to a verified, active user. Rejects unknown, unverified, or
 * deactivated accounts. Idempotent when the grant already exists.
 */
export async function addAdminGrant(
  prisma: GrantPrisma,
  input: { userId: string; grantedById: string },
  envEmails: readonly string[],
): Promise<AdminGrantRow> {
  const user = await prisma.user.findUnique({
    where: { id: input.userId },
    select: { id: true, email: true, name: true, emailVerified: true, deactivatedAt: true },
  });
  if (!user) throw new Error("User not found");
  if (!user.emailVerified) throw new Error("User email is not verified");
  if (user.deactivatedAt) throw new Error("User is deactivated");
  if (isHiddenOpsEmail(user.email)) throw new Error("Cannot grant admin to a hidden ops account");
  if (envEmails.map(normalizeEmail).includes(normalizeEmail(user.email))) {
    throw new Error("User is already an env bootstrap admin");
  }
  await prisma.adminGrant.upsert({
    where: { userId: user.id },
    create: { userId: user.id, grantedById: input.grantedById },
    update: {},
  });
  const found = (await listAdminGrants(prisma)).find((grant) => grant.userId === user.id);
  if (!found) throw new Error("Grant not found after create");
  return found;
}

function isActiveVerified(user: {
  emailVerified: boolean;
  deactivatedAt: Date | null;
}): boolean {
  return user.emailVerified && user.deactivatedAt == null;
}

/**
 * Effective admins match `isAdmin`: verified env-email users count even when
 * deactivated; DB grants require verified and not deactivated.
 */
async function countEffectiveAdmins(
  prisma: Pick<GrantPrisma, "adminGrant" | "user">,
  envEmails: readonly string[],
  exceptUserId: string,
): Promise<number> {
  const env = new Set(envEmails.map(normalizeEmail));
  const ids = new Set<string>();

  if (env.size > 0) {
    const candidates = await prisma.user.findMany({
      where: { emailVerified: true },
      select: { id: true, email: true, emailVerified: true, deactivatedAt: true },
    });
    for (const user of candidates) {
      // Same as isAdmin: env bootstrap stays effective while deactivated.
      if (user.emailVerified && env.has(normalizeEmail(user.email))) {
        ids.add(user.id);
      }
    }
  }

  const grants = await prisma.adminGrant.findMany({
    where: { userId: { not: exceptUserId } },
    include: {
      user: { select: { id: true, email: true, emailVerified: true, deactivatedAt: true } },
    },
  });
  for (const grant of grants) {
    if (isActiveVerified(grant.user)) ids.add(grant.user.id);
  }

  return ids.size;
}

/**
 * Remove a DB admin grant. Env bootstrap admins (RAKAZO_ADMIN_EMAILS) cannot be
 * removed from the UI even if they also have a DB row.
 */
export async function removeAdminGrant(
  prisma: GrantPrisma,
  userId: string,
  envEmails: readonly string[],
  actorUserId?: string,
): Promise<void> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { email: true },
  });
  if (!user) throw new Error("User not found");
  // Hidden ops may still have a grant from before filtering; allow revoke, refuse add.
  if (actorUserId != null && userId === actorUserId) {
    throw new Error("Cannot revoke your own admin grant");
  }
  const env = new Set(envEmails.map(normalizeEmail));
  if (env.has(normalizeEmail(user.email))) {
    throw new Error("Cannot remove an env bootstrap admin");
  }
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw(
      Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${"admin-grants"}, 0))`,
    );
    const remaining = await countEffectiveAdmins(tx, envEmails, userId);
    if (remaining === 0) {
      throw new Error("Cannot remove the last admin");
    }
    await tx.adminGrant.deleteMany({ where: { userId } });
  });
}
