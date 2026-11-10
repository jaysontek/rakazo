import { ipVersion, isPrivateNetworkHost } from "./network-host.js";

/** Known browser push service hosts (exact or one subdomain under a listed suffix). */
const WEB_PUSH_ENDPOINT_HOSTS = [
  "fcm.googleapis.com",
  ".googleapis.com",
  "updates.push.services.mozilla.com",
  ".push.services.mozilla.com",
  ".notify.windows.com",
  "web.push.apple.com",
  ".push.apple.com",
] as const;

export function isAllowedWebPushEndpointHost(hostname: string): boolean {
  const host = hostname.trim().toLowerCase().replace(/\.$/, "");
  if (!host || ipVersion(host) !== 0) return false;
  if (isPrivateNetworkHost(host)) return false;
  return WEB_PUSH_ENDPOINT_HOSTS.some(
    (allowed) =>
      (allowed.startsWith(".") && (host.endsWith(allowed) || host === allowed.slice(1))) ||
      host === allowed,
  );
}

/**
 * HTTPS push endpoints only: no userinfo, no non-443 ports, no IP literals,
 * host must be a known push service. Defense in depth also rejects private hosts.
 */
export function isAllowedWebPushEndpoint(endpoint: string): boolean {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  if (url.protocol !== "https:") return false;
  if (url.username || url.password) return false;
  if (url.port && url.port !== "443") return false;
  if (ipVersion(url.hostname) !== 0) return false;
  if (isPrivateNetworkHost(url.hostname)) return false;
  return isAllowedWebPushEndpointHost(url.hostname);
}
