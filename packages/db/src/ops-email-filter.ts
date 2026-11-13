/**
 * Accounts on builddrive.net (and any subdomain) are hidden from the LAN ops
 * dashboard: lists, pickers, and usage tables. Match is case-insensitive and
 * resistant to trailing-dot / zero-width / compatibility-character tricks.
 */

const ZERO_WIDTH =
  /[\u200B-\u200D\uFEFF\u2060\u180E\u2061-\u2064\u00AD\u034F\u061C\u115F\u1160\u17B4\u17B5\u200E\u200F\u202A-\u202E\u2066-\u2069\u3164\uFFA0]/g;

/** ASCII `.`, ideographic `。`, and other NFKC-compatible full stops used as dots. */
const DOMAIN_DOTS = /[.\u3002\uFF0E\uFE52\u2024]+/g;

function normalizeOpsDomain(email: string): string {
  const at = email.lastIndexOf("@");
  if (at < 0) return "";
  let domain = email.slice(at + 1).normalize("NFKC");
  domain = domain.replace(ZERO_WIDTH, "");
  // Collapse runs of dots (incl. ideographic) then strip trailing separators.
  domain = domain.replace(DOMAIN_DOTS, ".");
  while (domain.endsWith(".")) domain = domain.slice(0, -1);
  return domain.toLowerCase();
}

export function isHiddenOpsEmail(email: string): boolean {
  const domain = normalizeOpsDomain(email.trim());
  return domain === "builddrive.net" || domain.endsWith(".builddrive.net");
}
