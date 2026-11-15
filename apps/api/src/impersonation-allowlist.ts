import { isImpersonationAllowedProcedurePath } from "@rakazo/contracts";

/**
 * Procedures allowed while a session is impersonating another account.
 * Deny-by-default: anything not classified as a read (or stop/switch) is FORBIDDEN.
 *
 * Classification lives in `@rakazo/contracts` (`IMPERSONATION_PROCEDURE_KIND`) so the
 * API cannot drift from the contract.
 */
export function isImpersonationAllowedProcedure(path: readonly string[]): boolean {
  return isImpersonationAllowedProcedurePath(path.join("."));
}
