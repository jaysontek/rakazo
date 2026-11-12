import { OPENAI_COMPATIBLE_PROVIDER_ID } from "@rakazo/contracts";
import { LOCAL_PROVIDER_ID } from "./pi-local-provider.js";

/**
 * Whether a resolved model call uses the deployment shared API key (or host credentials for
 * that provider). Personal connections, local models, OpenAI-compatible custom endpoints, and
 * scripted runtimes are never shared-key spend — the budget gate and usage_records.sharedKey
 * must use this same definition.
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
