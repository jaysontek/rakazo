import { ImpersonationReadOnlyNotice } from "./ImpersonationReadOnlyNotice";

/**
 * Full-page stand-in for routes that would otherwise run setup/install mutations
 * while an admin is viewing as another account.
 */
export function ImpersonationBlockedPage() {
  return (
    <div
      data-testid="impersonation-blocked-page"
      className="grid min-h-full place-items-center bg-background px-6 py-12"
    >
      <ImpersonationReadOnlyNotice />
    </div>
  );
}
