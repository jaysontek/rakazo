import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { canonicalPiProviderId } from "@rakazo/contracts";
import { registerLocalProvider } from "./pi-local-provider.js";
import { applyPiModelCompatibility } from "./pi-model-compat.js";
import { registerOpenAiCompatibleCatalog } from "./pi-openai-compatible-provider.js";
import { minimumWorstCaseModelCallCostUsd } from "./pi-usage.js";

let cachedModels: ReturnType<typeof builtinModels> | undefined;

function catalogModels() {
  cachedModels ??= registerOpenAiCompatibleCatalog(
    registerLocalProvider(applyPiModelCompatibility(builtinModels())),
  );
  return cachedModels;
}

/**
 * Display-only: minimum worst-case USD a call on this provider/model would reserve
 * (empty context + model maxTokens via maximumModelCallCost). Returns undefined when
 * the catalog has no priced model.
 */
export function lookupMinimumWorstCaseCallCostUsd(
  provider: string | null | undefined,
  modelId: string | null | undefined,
): number | undefined {
  if (!provider || !modelId) return undefined;
  const model = catalogModels().getModel(canonicalPiProviderId(provider), modelId);
  if (!model?.cost) return undefined;
  return minimumWorstCaseModelCallCostUsd(model.cost, model.maxTokens);
}
