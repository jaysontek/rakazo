import { parse as legacyParse } from "node:url";
import { ipVersion, isPrivateNetworkHost } from "./network-host.js";

/** Exact push service hosts. */
const WEB_PUSH_EXACT_HOSTS = new Set([
  "fcm.googleapis.com",
  "android.googleapis.com",
  "updates.push.services.mozilla.com",
  "web.push.apple.com",
]);

/**
 * Suffixes that require a subdomain (apex alone is rejected).
 * Example: `db5.notify.windows.com` matches; `notify.windows.com` does not.
 */
const WEB_PUSH_SUBDOMAIN_SUFFIXES = [
  ".push.services.mozilla.com",
  ".notify.windows.com",
  ".push.apple.com",
] as const;

/** Authority may only use these characters (no percent-encoding, quotes, braces, …). */
const SAFE_AUTHORITY = /^[a-z0-9.-]+$/;

export function isAllowedWebPushEndpointHost(hostname: string): boolean {
  const host = hostname.trim().toLowerCase().replace(/\.$/, "");
  if (!host || ipVersion(host) !== 0) return false;
  if (isPrivateNetworkHost(host)) return false;
  if (WEB_PUSH_EXACT_HOSTS.has(host)) return true;
  return WEB_PUSH_SUBDOMAIN_SUFFIXES.some(
    (suffix) => host.endsWith(suffix) && host.length > suffix.length,
  );
}

/**
 * Returns the canonical https href when the endpoint is a known browser push
 * URL that both WHATWG and Node's legacy `url.parse` agree on. Otherwise null.
 *
 * Rejects parser-disagreement tricks (`%2E`, `"`, `{`, `` ` ``, `\`, full-width
 * dots, zero-width characters) that would otherwise pass a WHATWG-only host
 * allowlist while `web-push` sends to a different host.
 */
export function canonicalizeWebPushEndpoint(endpoint: string): string | null {
  if (typeof endpoint !== "string" || !endpoint || endpoint.length > 2048) return null;

  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return null;
  }

  // Callers must send the already-canonical form; we store/send this href.
  if (url.href !== endpoint) return null;
  if (url.protocol !== "https:") return null;
  if (url.username || url.password) return null;
  if (url.port && url.port !== "443") return null;
  if (ipVersion(url.hostname) !== 0) return null;
  if (isPrivateNetworkHost(url.hostname)) return null;

  // Raw authority (before path/query/hash) must be ASCII host labels only.
  const authorityMatch = /^https:\/\/([^/?#]*)/.exec(endpoint);
  if (!authorityMatch) return null;
  const authority = authorityMatch[1] ?? "";
  if (!authority || authority.includes("@")) return null;
  if (/[%\\"{}`\u0080-\uffff]/.test(authority)) return null;
  if (!SAFE_AUTHORITY.test(authority)) return null;
  if (authority !== url.hostname && authority !== `${url.hostname}:443`) return null;

  const legacyHost = legacyParse(endpoint).hostname;
  if (!legacyHost || legacyHost !== url.hostname) return null;

  if (!isAllowedWebPushEndpointHost(url.hostname)) return null;
  return url.href;
}

export function isAllowedWebPushEndpoint(endpoint: string): boolean {
  return canonicalizeWebPushEndpoint(endpoint) !== null;
}
