import type { SecretStore } from "@rakazo/adapter-kit";
import { parseModelSecret, sharedKeyMaterialMatches } from "@rakazo/adapters";
import type { PrismaClient } from "@rakazo/db";
import { findNewestUserModelCredential } from "@rakazo/db";

export type ModelKeyType = "company" | "personal" | "none";

export { sharedKeyMaterialMatches };

function keyMaterialFromPlaintext(plaintext: string): string | null {
  try {
    const parsed = parseModelSecret(plaintext);
    if (parsed.kind === "api_key") return parsed.key || null;
    if (parsed.kind === "oauth" && !parsed.reconnectRequired) {
      const oauth = parsed.credential as typeof parsed.credential & { apiKey?: unknown };
      return typeof oauth.apiKey === "string" && oauth.apiKey ? oauth.apiKey : null;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Live classification for ops / usageLimit: company shared key, distinct personal key, or none.
 * Same constant-time compare as resolveModelKeyMaterial — a stored copy of the deployment
 * Google/Gemini key is company, not personal. Never logs or returns key material.
 */
export async function classifyGoogleModelKeyType(
  prisma: Pick<PrismaClient, "userModelCredential" | "secret">,
  secrets: Pick<SecretStore, "load">,
  userId: string,
  deploymentSharedKey: string | null | undefined,
): Promise<ModelKeyType> {
  const credential = await findNewestUserModelCredential(prisma, userId, "google");
  if (!credential) {
    return deploymentSharedKey ? "company" : "none";
  }
  const row = await prisma.secret.findFirst({
    where: { id: credential.secretId, userId },
    select: { id: true, ciphertext: true },
  });
  if (!row) return "personal";
  let plaintext: string;
  try {
    plaintext = await secrets.load(row.ciphertext, row.id);
  } catch {
    return "personal";
  }
  const material = keyMaterialFromPlaintext(plaintext);
  if (!material) return "personal";
  if (deploymentSharedKey && sharedKeyMaterialMatches(material, deploymentSharedKey)) {
    return "company";
  }
  return "personal";
}
