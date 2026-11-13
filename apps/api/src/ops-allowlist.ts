import { BlockList, isIP } from "node:net";

/**
 * Parse OPS_DASHBOARD_ALLOWLIST: comma/whitespace-separated IPs or CIDR ranges.
 * Empty/unset means no LAN ranges are configured (loopback may still be allowed separately).
 */
export function parseOpsDashboardAllowlist(raw: string | undefined): string[] {
  if (!raw?.trim()) return [];
  return [
    ...new Set(
      raw
        .split(/[\s,]+/)
        .map((part) => part.trim())
        .filter(Boolean),
    ),
  ];
}

/** Loopback addresses always accepted for local operator access. */
const LOOPBACK = new Set(["127.0.0.1", "::1"]);

/**
 * Build a checker for ops-dashboard LAN allowlist entries (IPs and CIDRs only).
 * Hostnames are rejected at parse time so misconfiguration fails loudly.
 */
export function createOpsAllowlistChecker(entries: string[]): {
  configured: boolean;
  allows: (ip: string | undefined) => boolean;
} {
  const ranges = new BlockList();
  for (const entry of entries) {
    const [address = "", prefix, extra] = entry.split("/");
    const family = isIP(address);
    const type = family === 6 ? "ipv6" : "ipv4";
    const bits = Number(prefix);
    if (family && prefix === undefined) {
      ranges.addAddress(address, type);
      continue;
    }
    if (
      family &&
      extra === undefined &&
      /^\d+$/.test(prefix ?? "") &&
      bits <= (family === 6 ? 128 : 32)
    ) {
      ranges.addSubnet(address, bits, type);
      continue;
    }
    throw new Error(`OPS_DASHBOARD_ALLOWLIST entry is not an IP or CIDR range: ${entry}`);
  }

  return {
    configured: entries.length > 0,
    allows(ip: string | undefined): boolean {
      if (!ip) return false;
      const normalized = normalizeIp(ip);
      if (!isIP(normalized)) return false;
      if (LOOPBACK.has(normalized)) return true;
      if (entries.length === 0) return false;
      return ranges.check(normalized, isIP(normalized) === 6 ? "ipv6" : "ipv4");
    },
  };
}

function normalizeIp(value: string): string {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(value.trim());
  return (mapped?.[1] ?? value.trim()).toLowerCase();
}
