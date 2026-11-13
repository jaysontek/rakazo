import { ORPCError } from "@orpc/server";
import { requireAdmin } from "./admins.js";
import { createOpsAllowlistChecker, parseOpsDashboardAllowlist } from "./ops-allowlist.js";
import type { RouterDeps } from "./router.js";

type OpsAccessDeps = Pick<RouterDeps, "prisma"> & {
  env: Pick<RouterDeps["env"], "adminEmails" | "opsDashboardAllowlist">;
};

/**
 * Admin + LAN gate for the self-hosted operations dashboard.
 * Non-admins and callers outside OPS_DASHBOARD_ALLOWLIST (plus loopback) are rejected
 * with the same FORBIDDEN shape — never leak whether the caller was an admin.
 */
export async function requireOpsDashboardAccess(
  deps: OpsAccessDeps,
  userId: string,
  clientIp: string | undefined,
): Promise<void> {
  // Admin first so missing admin config fails the same way as a non-admin.
  await requireAdmin(deps, userId);

  const entries = deps.env.opsDashboardAllowlist ?? parseOpsDashboardAllowlist(undefined);
  const checker = createOpsAllowlistChecker(entries);
  if (!checker.allows(clientIp)) {
    throw new ORPCError("FORBIDDEN", {
      message: "Operations dashboard is limited to allowed networks",
    });
  }
}
