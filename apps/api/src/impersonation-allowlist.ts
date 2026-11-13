/**
 * Procedures allowed while a session is impersonating another account.
 * Deny-by-default: anything not listed here is FORBIDDEN.
 *
 * Keep this to reads the support UI needs, plus stopImpersonation.
 * Prefer exact paths — never open a whole mutating namespace.
 * Every entry must exist on `appContract` in `@rakazo/contracts`.
 */
const EXACT = new Set<string>([
  "me",
  "health",
  "ops.stopImpersonation",
  "usage.list",
  "usage.summary",
  "aiConsent.status",
  "spaces.list",
  "organizations.list",
  "models.list",
  "models.credentials",
  "bots.list",
  "bots.listArchived",
  "bots.get",
  "threads.get",
  "threads.messages",
  "threads.subscribe",
  "computer.status",
  "memory.providerConfig",
  "memory.list",
  "artifacts.list",
  "artifacts.get",
  "artifacts.getById",
  "pages.list",
  "pages.get",
  "search.query",
  "runs.list",
  "links.favicon",
  "notifications.subscribe",
  "notifications.subscribeCalls",
  "voice.status",
  "voice.catalog",
  "voice.credentials",
  "messaging.status",
  "messaging.channels.list",
  "messaging.connections.list",
  "messaging.installations.list",
  "mcp.servers.list",
  "mcp.assignments.list",
  "billing.status",
  "accessGrants.list",
  "routines.list",
  "boards.list",
  "boards.get",
]);

export function isImpersonationAllowedProcedure(path: readonly string[]): boolean {
  return EXACT.has(path.join("."));
}
