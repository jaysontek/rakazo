import type { SecretStore } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { syncSharedKeyBudgetMembers } from "@rakazo/db";
import { classifyGoogleModelKeyType } from "./model-key-type.js";

/**
 * User ids whose live Google/Gemini key resolves as the deployment company key
 * (env shared key, or a stored credential that matches it). Never returns key material.
 */
export async function listCompanyKeyUserIds(
  prisma: Pick<PrismaClient, "user" | "userModelCredential" | "secret">,
  secrets: Pick<SecretStore, "load">,
  deploymentSharedKey: string | null | undefined,
): Promise<string[]> {
  const users = await prisma.user.findMany({ select: { id: true } });
  if (users.length === 0) return [];
  const company: string[] = [];
  for (const user of users) {
    const type = await classifyGoogleModelKeyType(
      prisma,
      secrets,
      user.id,
      deploymentSharedKey,
    );
    if (type === "company") company.push(user.id);
  }
  return company;
}

/**
 * Roster = company-key users ∪ explicit SHARED_KEY_BUDGET_USER_IDS.
 * Personal-key users stay off unless explicitly listed. Additive for existing
 * company-key members; removes anyone who is neither company nor explicit.
 */
export async function syncSharedKeyBudgetFromKeys(
  prisma: PrismaClient,
  secrets: Pick<SecretStore, "load">,
  options: {
    explicitUserIds: string[];
    deploymentSharedKey: string | null | undefined;
    now?: Date;
  },
): Promise<{ companyUserIds: string[]; memberIds: string[] }> {
  const companyUserIds = await listCompanyKeyUserIds(
    prisma,
    secrets,
    options.deploymentSharedKey,
  );
  await syncSharedKeyBudgetMembers(
    prisma,
    { explicitUserIds: options.explicitUserIds, companyUserIds },
    options.now ?? new Date(),
  );
  const members = await prisma.sharedKeyBudgetMember.findMany({ select: { userId: true } });
  return { companyUserIds, memberIds: members.map((row) => row.userId) };
}
