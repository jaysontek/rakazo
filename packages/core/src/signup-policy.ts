export function parseAllowlist(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * RAKAZO_ADMIN_EMAILS: comma or whitespace separated, lowercased.
 * Shared by API env loading and the worker so both agree on the admin set.
 */
export function parseAdminEmails(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(/[\s,]+/)
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean);
}

export function emailAllowed(email: string, allowlist: string[]): boolean {
  if (allowlist.length === 0) return true;
  const normalized = email.trim().toLowerCase();
  const domain = normalized.split("@")[1];
  return allowlist.some((entry) => {
    if (entry.startsWith("@")) return domain === entry.slice(1);
    return normalized === entry;
  });
}

export const MESSAGING_EMAIL_SUFFIX = "@messaging.invalid";

/** Internal messaging users have no mailbox and cannot authenticate by email. */
export function isMessagingEmail(email: string): boolean {
  return email.trim().toLowerCase().endsWith(MESSAGING_EMAIL_SUFFIX);
}

/** A successful signup with an explicit null token awaits mailbox proof. */
export function signupRequiresEmailVerification(response: unknown): boolean {
  return Boolean(
    response && typeof response === "object" && "token" in response && response.token === null,
  );
}

export function signupsOpen(enabled: string | undefined): boolean {
  if (enabled === undefined) return true;
  return enabled !== "false" && enabled !== "0";
}

export function signupPolicyFromEnv(input: {
  signupsEnabled: string | undefined;
  signupAllowlist: string | undefined;
}): { enabled: boolean; allowlist: string[] } {
  return {
    enabled: signupsOpen(input.signupsEnabled),
    allowlist: parseAllowlist(input.signupAllowlist),
  };
}

/**
 * Deployments that gate who can create accounts. Open signups (the code default)
 * need a stricter shared-key auto-enroll bar; gated deployments keep verified + membership.
 */
export function isGatedSharedKeyDeployment(input: {
  signupsEnabled: string | undefined;
  signupAllowlist: string | undefined;
  singleAccount?: boolean;
  directoryProvisioning?: boolean;
}): boolean {
  if (!signupsOpen(input.signupsEnabled)) return true;
  if (parseAllowlist(input.signupAllowlist).length > 0) return true;
  if (input.singleAccount) return true;
  if (input.directoryProvisioning) return true;
  return false;
}
