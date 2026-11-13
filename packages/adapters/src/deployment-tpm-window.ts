import { perMinuteLimitResetAt } from "@rakazo/adapter-kit";

/** Process-local: when the deployment primary last hit a per-minute token cap. */
const limitedUntilByModel = new Map<string, number>();

function modelKey(provider: string, modelId: string): string {
  return `${provider}\0${modelId}`;
}

/** Record that the deployment primary is in a per-minute quota window. */
export function markDeploymentModelTpmLimited(
  provider: string,
  modelId: string,
  error: unknown,
  now = Date.now(),
): void {
  const resetAt = perMinuteLimitResetAt(error, now);
  if (resetAt === undefined) return;
  const key = modelKey(provider, modelId);
  const previous = limitedUntilByModel.get(key) ?? 0;
  if (resetAt > previous) limitedUntilByModel.set(key, resetAt);
}

/** When the deployment primary's per-minute window ends, or undefined if it is clear. */
export function deploymentModelTpmLimitedUntil(
  provider: string,
  modelId: string,
  now = Date.now(),
): number | undefined {
  const key = modelKey(provider, modelId);
  const until = limitedUntilByModel.get(key);
  if (until === undefined) return undefined;
  if (until <= now) {
    limitedUntilByModel.delete(key);
    return undefined;
  }
  return until;
}

/** True while new work should start on a deployment backup instead of this primary. */
export function isDeploymentModelTpmLimited(
  provider: string,
  modelId: string,
  now = Date.now(),
): boolean {
  return deploymentModelTpmLimitedUntil(provider, modelId, now) !== undefined;
}

/** Test helper: drop every recorded window. */
export function clearDeploymentModelTpmWindows(): void {
  limitedUntilByModel.clear();
}
