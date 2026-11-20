import { Trans } from "@lingui/react/macro";
import { useImpersonating } from "../lib/use-impersonating";

/** Short notice above mutation panels while an admin is viewing as another account. */
export function ImpersonationReadOnlyNotice() {
  const impersonating = useImpersonating();
  if (!impersonating) return null;
  const name = impersonating.targetName || impersonating.targetEmail;
  return (
    <p
      data-testid="impersonation-read-only-notice"
      className="mb-3 min-w-0 break-words text-sm text-muted-foreground"
    >
      <Trans>
        Read-only while viewing as <span translate="no">{name}</span>
      </Trans>
    </p>
  );
}
