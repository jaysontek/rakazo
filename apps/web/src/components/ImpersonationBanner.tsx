import { Trans, useLingui } from "@lingui/react/macro";
import {
  buttonVariants,
  NativeSelect,
  NativeSelectOption,
} from "@rakazo/ui-web";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { hardSwitchImpersonation } from "../lib/impersonation-switch";
import {
  readImpersonationOrgId,
  readImpersonationTeammates,
} from "../lib/impersonation-teammates";
import { rpc } from "../lib/rpc";
import { errorText } from "../lib/user-error";

function formatExpiry(expiresAt: string, locale: string): string {
  const date = new Date(expiresAt);
  if (Number.isNaN(date.getTime())) return expiresAt;
  return date.toLocaleString(locale, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/** Top-of-app chrome while an admin is viewing as another account (read-only). */
export function ImpersonationBanner() {
  const { t, i18n } = useLingui();
  const queryClient = useQueryClient();
  const me = useQuery({
    queryKey: ["me", "impersonation-banner"],
    queryFn: () => rpc.me(),
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const impersonating = me.data?.impersonating;
  const teammates = useMemo(
    () => (impersonating ? readImpersonationTeammates() : []),
    [impersonating],
  );
  const organizationId = impersonating ? readImpersonationOrgId() : null;
  const switchable = Boolean(
    organizationId && teammates.length > 1 && impersonating?.targetUserId,
  );

  if (!impersonating) return null;

  const targetName = impersonating.targetName;
  const targetEmail = impersonating.targetEmail;
  const endsAt = formatExpiry(impersonating.expiresAt, i18n.locale || "en");

  async function stop() {
    setBusy(true);
    setError(null);
    try {
      await rpc.ops.stopImpersonation();
      hardSwitchImpersonation({
        queryClient,
        target: "/admin/ops",
        clearTeammates: true,
      });
    } catch (err) {
      setError(errorText(err, t`Could not stop impersonation`));
      setBusy(false);
    }
  }

  const currentTargetUserId = impersonating.targetUserId;

  async function switchTo(userId: string) {
    if (!organizationId || !userId || userId === currentTargetUserId) return;
    setBusy(true);
    setError(null);
    try {
      await rpc.ops.switchImpersonation({ userId, organizationId });
      hardSwitchImpersonation({ queryClient, target: "/app" });
    } catch (err) {
      setError(errorText(err, t`Could not switch impersonation`));
      setBusy(false);
    }
  }

  return (
    <div
      role="status"
      data-testid="impersonation-banner"
      className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-destructive/40 bg-destructive/10 px-4 py-2 text-sm text-destructive"
    >
      <span className="min-w-0 flex-1 truncate">
        {targetName ? (
          <Trans>
            Read-only · Viewing as {targetName} ({targetEmail}) · Ends {endsAt}
          </Trans>
        ) : (
          <Trans>
            Read-only · Viewing as {targetEmail} · Ends {endsAt}
          </Trans>
        )}
      </span>
      {switchable ? (
        <label className="flex items-center gap-2 text-destructive">
          <span className="sr-only">
            <Trans>Switch member</Trans>
          </span>
          <NativeSelect
            size="sm"
            data-testid="impersonation-switch"
            aria-label={t`Switch member`}
            disabled={busy}
            value={impersonating.targetUserId}
            onChange={(event) => void switchTo(event.target.value)}
            className="max-w-[14rem] border-destructive/40 bg-background text-foreground"
          >
            {teammates.map((member) => (
              <NativeSelectOption key={member.userId} value={member.userId}>
                {member.name || member.email}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </label>
      ) : null}
      {error ? (
        <span role="alert" className="text-destructive">
          {error}
        </span>
      ) : null}
      <button
        type="button"
        className={buttonVariants({ variant: "outline", size: "sm" })}
        disabled={busy}
        data-testid="impersonation-stop"
        onClick={() => void stop()}
      >
        {busy ? <Trans>Stopping…</Trans> : <Trans>Stop</Trans>}
      </button>
    </div>
  );
}
