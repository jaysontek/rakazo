import { createHash, timingSafeEqual } from "node:crypto";
import { OPENAI_COMPATIBLE_PROVIDER_ID } from "@rakazo/contracts";
import { LOCAL_PROVIDER_ID } from "./pi-local-provider.js";

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
