import { parse as legacyParse } from "node:url";
import { isAllowedWebPushEndpoint } from "@rakazo/contracts";

/**
 * Server-only: browser-safe allowlist plus Node `url.parse` hostname agreement.
 * Returns the canonical href to store and send, or null when rejected.
 */
export function canonicalizeWebPushEndpoint(endpoint: string): string | null {
  if (!isAllowedWebPushEndpoint(endpoint)) return null;
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return null;
  }
  const legacyHost = legacyParse(endpoint).hostname;
  if (!legacyHost || legacyHost !== url.hostname) return null;
  return url.href;
}
