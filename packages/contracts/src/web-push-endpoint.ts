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

/** One DNS label: 1–63 chars, alphanumeric ends, hyphens only in the middle (RFC 1123). */
const RFC1123_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export function isRfc1123Hostname(hostname: string): boolean {
  if (!hostname || hostname.startsWith(".") || hostname.endsWith(".") || hostname.includes("..")) {
    return false;
  }
  return hostname.split(".").every((label) => RFC1123_LABEL.test(label));
}

export function isAllowedWebPushEndpointHost(hostname: string): boolean {
  const host = hostname.trim().toLowerCase().replace(/\.$/, "");
  if (!host || ipVersion(host) !== 0) return false;
  if (!isRfc1123Hostname(host)) return false;
  if (isPrivateNetworkHost(host)) return false;
  if (WEB_PUSH_EXACT_HOSTS.has(host)) return true;
  return WEB_PUSH_SUBDOMAIN_SUFFIXES.some(
    (suffix) => host.endsWith(suffix) && host.length > suffix.length,
  );
}

/**
 * Browser-safe push endpoint check for the RPC contract (no Node builtins).
 * Requires a canonical WHATWG href, a safe ASCII authority, RFC 1123 labels,
 * and a known push host. Server adapters also require legacy `url.parse`
 * hostname agreement before store/send.
 */
export function isAllowedWebPushEndpoint(endpoint: string): boolean {
  if (typeof endpoint !== "string" || !endpoint || endpoint.length > 2048) return false;

  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }

  if (url.href !== endpoint) return false;
  if (url.protocol !== "https:") return false;
  if (url.username || url.password) return false;
  if (url.port && url.port !== "443") return false;
  if (ipVersion(url.hostname) !== 0) return false;
  if (isPrivateNetworkHost(url.hostname)) return false;
  if (!isRfc1123Hostname(url.hostname)) return false;

  const authorityMatch = /^https:\/\/([^/?#]*)/.exec(endpoint);
  if (!authorityMatch) return false;
  const authority = authorityMatch[1] ?? "";
  if (!authority || authority.includes("@")) return false;
  if (/[%\\"{}`\u0080-\uffff]/.test(authority)) return false;
  if (!SAFE_AUTHORITY.test(authority)) return false;
  if (authority !== url.hostname && authority !== `${url.hostname}:443`) return false;

  return isAllowedWebPushEndpointHost(url.hostname);
}
