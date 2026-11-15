import { createHash, timingSafeEqual } from "node:crypto";
import type { SecretStore } from "@rakazo/adapter-kit";
import { OPENAI_COMPATIBLE_PROVIDER_ID } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { findModelCredential } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { resolveDeploymentModel } from "./deployment-model.js";
import { hasHostedModelCredits } from "./model-selection.js";
import { LOCAL_PROVIDER_ID } from "./pi-local-provider.js";
import { parseModelSecret } from "./pi-oauth.js";

/**
 * Constant-time compare of API key material via SHA-256 digests.
 * Never log or return the keys. Used when a stored user credential must be
 * recognized as the deployment shared key for the same provider.
 */
export function sharedKeyMaterialMatches(left: string, right: string): boolean {
  const a = createHash("sha256").update(left).digest();
  const b = createHash("sha256").update(right).digest();
  return timingSafeEqual(a, b);
}

/**
 * Whether a resolved model call uses the deployment shared API key (or host credentials for
 * that provider). Personal connections, local models, OpenAI-compatible custom endpoints, and
 * scripted runtimes are never shared-key spend — the budget gate and usage_records.sharedKey
 * must use this same definition.
 *
 * A stored user credential whose key material matches the deployment key for that provider
 * is not an "own" credential — callers must omit ownCredential (or pass false) so this
 * returns true and spend counts against the shared-key budget.
 */
export function isDeploymentSharedKeyUsage(args: {
  ownCredential?: boolean;
  provider: string;
  /** Set for user-connected OpenAI-compatible endpoints. */
  baseUrl?: string | null;
  /** True when the deployment runs the scripted test runtime. */
  scriptedRuntime?: boolean;
}): boolean {
  if (args.ownCredential) return false;
  if (args.provider === LOCAL_PROVIDER_ID) return false;
  if (args.provider === OPENAI_COMPATIBLE_PROVIDER_ID && Boolean(args.baseUrl)) return false;
  if (args.provider === "scripted" && args.scriptedRuntime) return false;
  return true;
}

export type ModelKeyType = "company" | "personal";

export type ModelKeyTypeResult = {
  keyType: ModelKeyType;
  /**
   * Stored credential exists but cannot be used (decrypt failed, empty key, or
   * reconnect-required OAuth). Shown as a hint next to the label — not a third label.
   */
  needsReconnect: boolean;
};

/**
 * Same ownership decision resolveModelKeyMaterial uses for `ownCredential`.
 * Never accepts key material into logs or return values beyond the boolean label.
 */
export function modelKeyTypeFromResolution(args: {
  hostedCredits: boolean;
  /** Credential selected for the provider (findModelCredential ordering). */
  credential: { secretId: string } | null;
  /** spaceId:null secret row was found. */
  secretRow: boolean;
  /** Non-empty key material after decrypt+parse; null if missing, empty, or failed. */
  keyMaterial: string | null;
  deploymentKey: string | undefined;
}): ModelKeyTypeResult {
  if (args.hostedCredits) {
    return { keyType: "company", needsReconnect: false };
  }
  if (!args.credential || !args.secretRow) {
    return { keyType: "company", needsReconnect: false };
  }
  if (!args.keyMaterial) {
    return { keyType: "personal", needsReconnect: true };
  }
  if (
    args.deploymentKey &&
    sharedKeyMaterialMatches(args.keyMaterial, args.deploymentKey)
  ) {
    return { keyType: "company", needsReconnect: false };
  }
  return { keyType: "personal", needsReconnect: false };
}

/** Map the shared label onto resolveModelKeyMaterial's `ownCredential` flag. */
export function ownCredentialFromKeyType(keyType: ModelKeyType): true | undefined {
  return keyType === "personal" ? true : undefined;
}

/**
 * Extract comparable API key material from a stored secret without refreshing OAuth.
 * Returns null for empty, reconnect-required, or unparseable secrets. Never logs the value.
 */
function keyMaterialFromPlaintext(plaintext: string): string | null {
  try {
    const parsed = parseModelSecret(plaintext);
    if (parsed.kind === "api_key") return parsed.key.trim() ? parsed.key : null;
    if (parsed.kind === "openai_compatible") {
      return parsed.apiKey?.trim() ? parsed.apiKey : null;
    }
    if (parsed.kind === "oauth") {
      if (parsed.reconnectRequired) return null;
      const carried = parsed.credential as { apiKey?: unknown };
      return typeof carried.apiKey === "string" && carried.apiKey.trim() ? carried.apiKey : null;
    }
    return null;
  } catch {
    return null;
  }
}

function deploymentKeyForProvider(
  deploymentModelKey: string | undefined,
  provider: string,
): string | undefined {
  if (!deploymentModelKey) return undefined;
  return provider === resolveDeploymentModel().provider ? deploymentModelKey : undefined;
}

async function modelCreditBillingEnabled(
  prisma: Pick<PrismaClient, "deploymentSettings">,
  billingEnabled?: boolean,
): Promise<boolean> {
  if (billingEnabled !== undefined) return billingEnabled;
  return (
    (
      await prisma.deploymentSettings.findUnique({
        where: { id: "default" },
        select: { modelCreditsEnabled: true },
      })
    )?.modelCreditsEnabled === true
  );
}

export type ResolveModelKeyTypeDeps = {
  /** Needs credentials, secrets, deployment settings, and space/org credits reads. */
  prisma: PrismaClient;
  secretStore: Pick<SecretStore, "load">;
  deploymentModelKey?: string;
  /** When set, skips the deployment_settings read. */
  billingEnabled?: boolean;
};

/**
 * Live company|personal label for the key a run would actually use for the deployment
 * provider (or an explicit provider). Reuses findModelCredential ordering, spaceId:null
 * secret lookup, deployment key compare, and the hosted-credits rule. Never returns null,
 * never returns or logs key material.
 */
export async function resolveModelKeyType(
  deps: ResolveModelKeyTypeDeps,
  scope: { userId: string; spaceId: string },
  options: { provider?: string; modelId?: string | null } = {},
): Promise<ModelKeyTypeResult> {
  const provider = options.provider ?? resolveDeploymentModel().provider;
  const deploymentKey = deploymentKeyForProvider(deps.deploymentModelKey, provider);
  const billingEnabled = await modelCreditBillingEnabled(deps.prisma, deps.billingEnabled);
  const hostedCredits =
    billingEnabled && (await hasHostedModelCredits(deps.prisma, scope, provider));
  if (hostedCredits) {
    return modelKeyTypeFromResolution({
      hostedCredits: true,
      credential: null,
      secretRow: false,
      keyMaterial: null,
      deploymentKey,
    });
  }

  const credential = await findModelCredential(
    deps.prisma,
    { userId: scope.userId },
    provider,
    options.modelId,
  );
  if (!credential) {
    return modelKeyTypeFromResolution({
      hostedCredits: false,
      credential: null,
      secretRow: false,
      keyMaterial: null,
      deploymentKey,
    });
  }

  const row = await deps.prisma.secret.findFirst({
    where: { id: credential.secretId, userId: scope.userId, spaceId: null },
    select: { id: true, ciphertext: true },
  });
  if (!row) {
    return modelKeyTypeFromResolution({
      hostedCredits: false,
      credential,
      secretRow: false,
      keyMaterial: null,
      deploymentKey,
    });
  }

  let plaintext: string;
  try {
    plaintext = await deps.secretStore.load(row.ciphertext, row.id);
  } catch {
    return modelKeyTypeFromResolution({
      hostedCredits: false,
      credential,
      secretRow: true,
      keyMaterial: null,
      deploymentKey,
    });
  }

  const keyMaterial = keyMaterialFromPlaintext(plaintext);
  return modelKeyTypeFromResolution({
    hostedCredits: false,
    credential,
    secretRow: true,
    keyMaterial,
    deploymentKey,
  });
}

/**
 * Ops/page wrapper: one unexpected failure never breaks the page, and never yields a
 * blank label. Logs without key material. Falls back to the deployment (company) key
 * a run would use when personal resolution cannot complete.
 */
export async function resolveModelKeyTypeSafe(
  deps: ResolveModelKeyTypeDeps,
  scope: { userId: string; spaceId: string },
  options: { provider?: string; modelId?: string | null } = {},
): Promise<ModelKeyTypeResult> {
  try {
    return await resolveModelKeyType(deps, scope, options);
  } catch (error) {
    getLogger().error("model key type resolution failed", {
      userId: scope.userId,
      provider: options.provider ?? resolveDeploymentModel().provider,
      name: error instanceof Error ? error.name : "unknown",
    });
    return { keyType: "company", needsReconnect: false };
  }
}
