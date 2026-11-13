import { getEnvApiKey } from "@earendil-works/pi-ai/compat";
import type { ModelUsageLookup } from "@rakazo/adapter-kit";
import { OpenRouterUsageLookup } from "./openrouter-usage.js";
import { LOCAL_PROVIDER_ID, localModelIds } from "./pi-local-provider-id.js";

export const DEFAULT_OPENROUTER_MODEL_ID = "anthropic/claude-haiku-5.5";

/**
 * What Pi reports for a provider that authenticates from the host instead of a key: an AWS
 * profile or task role for Amazon Bedrock, Application Default Credentials for Vertex.
 */
const HOST_CREDENTIALS = "<authenticated>";

/** What a provider's host credentials are, for telling a user what a deployment runs on. */
const HOST_CREDENTIAL_SOURCES: Record<string, string> = {
  "amazon-bedrock": "AWS IAM",
  "google-vertex": "Google Cloud",
};

/** The kind of host credentials a provider authenticates with, e.g. "AWS IAM". */
export function hostCredentialSource(provider: string): string {
  return HOST_CREDENTIAL_SOURCES[provider] ?? "host";
}

/**
 * The deployment-wide model default: which provider a run falls back to when no user
 * credential applies, and the key for that provider.
 *
 * Keyless host authentication requires explicit opt-in and a model id. Bedrock resolves
 * its credential chain (including instance roles) at request time; local models must be
 * declared by the operator; other providers must report host credentials in the process
 * environment. Host credentials never become `key`.
 *
 * Vendor env names and model ids live here, in the adapter layer, not in core.
 */
/** Built-in same-provider backups when `PI_DEFAULT_BACKUP_MODEL` is unset. */
const DEFAULT_BACKUP_MODELS: Record<string, readonly string[]> = {
  // Shared GEMINI_API_KEY: move mid-task work to 3.7 when 3.8's per-minute window is full.
  google: ["gemini-3.7-flash"],
};

export function resolveDeploymentModel(env: NodeJS.ProcessEnv = process.env) {
  const provider = env.PI_DEFAULT_PROVIDER?.trim() || "openrouter";
  // An unknown provider gets no key rather than another vendor's.
  const keys: Record<string, string | undefined> = {
    openrouter: env.OPENROUTER_API_KEY,
    anthropic: env.ANTHROPIC_API_KEY,
    deepseek: env.DEEPSEEK_API_KEY,
    // Shared server secret: referenced at run time, never copied into account rows.
    google: env.GEMINI_API_KEY,
  };
  const models: Record<string, string> = {
    openrouter: DEFAULT_OPENROUTER_MODEL_ID,
    anthropic: "claude-sonnet-5",
    deepseek: "deepseek-flash",
    google: "gemini-3.8-flash",
  };
  const explicitModel = env.PI_DEFAULT_MODEL?.trim();
  const key = keys[provider];
  const hostCredentials =
    !key &&
    Boolean(explicitModel) &&
    env.PI_DEFAULT_CREDENTIALS?.trim() === "host" &&
    // Bedrock also resolves EC2 instance roles through IMDS at request time.
    (provider === LOCAL_PROVIDER_ID
      ? localModelIds(env).includes(explicitModel!)
      : provider === "amazon-bedrock" || getEnvApiKey(provider) === HOST_CREDENTIALS);
  return {
    provider,
    model: explicitModel || models[provider] || models.openrouter!,
    key,
    configured: Boolean(key) || hostCredentials,
    hostCredentials,
  };
}

/**
 * Same-provider models the deployment may continue on after the primary's per-minute
 * token cap. `PI_DEFAULT_BACKUP_MODEL` is a comma list of model ids on `PI_DEFAULT_PROVIDER`;
 * an explicit empty value disables backups. Unset keeps the provider's built-in list.
 */
export function resolveDeploymentBackupModels(
  env: NodeJS.ProcessEnv = process.env,
): Array<{ provider: string; modelId: string }> {
  const deployment = resolveDeploymentModel(env);
  const raw = env.PI_DEFAULT_BACKUP_MODEL;
  const ids =
    raw === undefined
      ? [...(DEFAULT_BACKUP_MODELS[deployment.provider] ?? [])]
      : raw
          .split(",")
          .map((part) => part.trim())
          .filter(Boolean);
  const seen = new Set<string>();
  const backups: Array<{ provider: string; modelId: string }> = [];
  for (const modelId of ids) {
    if (modelId === deployment.model || seen.has(modelId)) continue;
    seen.add(modelId);
    backups.push({ provider: deployment.provider, modelId });
  }
  return backups;
}

export function deploymentModelUsageLookup(): ModelUsageLookup | undefined {
  const model = resolveDeploymentModel();
  return model.provider === "openrouter" && model.key
    ? new OpenRouterUsageLookup(model.key)
    : undefined;
}
