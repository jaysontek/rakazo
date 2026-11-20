import { Trans, useLingui } from "@lingui/react/macro";
import { buttonVariants, NativeSelect, NativeSelectOption } from "@rakazo/ui-web";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  clearImpersonationBannerHeight,
  publishImpersonationBannerHeight,
} from "../lib/impersonation-banner-height";
import { hardSwitchImpersonation } from "../lib/impersonation-switch";
import {
  readImpersonationOrgId,
  readImpersonationTeammates,
  syncImpersonationTeammatesFromServer,
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
  const bannerRef = useRef<HTMLDivElement>(null);
  const me = useQuery({
    queryKey: ["me", "impersonation-banner"],
    queryFn: () => rpc.me(),
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const impersonating = me.data?.impersonating;
  // Server ended or expired the window — drop cached teammates so a later start
  // cannot show the previous team's switcher.
  useEffect(() => {
    if (me.isSuccess) syncImpersonationTeammatesFromServer(impersonating);
  }, [me.isSuccess, impersonating]);
  const teammates = useMemo(
    () => (impersonating ? readImpersonationTeammates() : []),
    [impersonating],
  );
  const organizationId = impersonating ? readImpersonationOrgId() : null;
  const switchable = Boolean(organizationId && teammates.length > 1 && impersonating?.targetUserId);

  useEffect(() => {
    if (!impersonating) {
      clearImpersonationBannerHeight();
      return;
    }
    const el = bannerRef.current;
    if (!el) return;
    // Use bottom (not height) so fixed chrome clears the banner and #root safe-area inset.
    const publish = () => publishImpersonationBannerHeight(el.getBoundingClientRect().bottom);
    publish();
    const observer = new ResizeObserver(publish);
    observer.observe(el);
    return () => {
      observer.disconnect();
      clearImpersonationBannerHeight();
    };
  }, [impersonating, switchable, error]);

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
      ref={bannerRef}
      data-testid="impersonation-banner"
      className="flex shrink-0 flex-col gap-2 border-b border-destructive/40 bg-destructive/10 px-4 py-2 text-sm text-destructive sm:flex-row sm:flex-wrap sm:items-center sm:gap-x-3 sm:gap-y-1"
    >
      <span
        role="status"
        data-testid="impersonation-status"
        className="min-w-0 line-clamp-2 sm:flex-1 sm:truncate sm:line-clamp-none"
      >
        <span className="sm:hidden">
          {targetName ? (
            <Trans>
              Read-only · Viewing as <span translate="no">{targetName}</span>
            </Trans>
          ) : (
            <Trans>
              Read-only · Viewing as <span translate="no">{targetEmail}</span>
            </Trans>
          )}
        </span>
        <span className="hidden sm:inline">
          {targetName ? (
            <Trans>
              Read-only · Viewing as <span translate="no">{targetName}</span> (
              <span translate="no">{targetEmail}</span>) · Ends {endsAt}
            </Trans>
          ) : (
            <Trans>
              Read-only · Viewing as <span translate="no">{targetEmail}</span> · Ends {endsAt}
            </Trans>
          )}
        </span>
      </span>
      <div className="flex w-full min-w-0 items-center gap-2 sm:w-auto sm:contents">
        {switchable ? (
          <div className="flex min-w-0 flex-1 items-center gap-2 text-destructive sm:flex-none">
            <NativeSelect
              size="sm"
              name="impersonation-member"
              data-testid="impersonation-switch"
              aria-label={t`Switch member`}
              disabled={busy}
              value={impersonating.targetUserId}
              onChange={(event) => void switchTo(event.target.value)}
              className="h-10 min-h-10 w-full max-w-none border-destructive/40 bg-background text-foreground sm:h-8 sm:min-h-8 sm:max-w-[14rem]"
            >
              {teammates.map((member) => (
                <NativeSelectOption key={member.userId} value={member.userId}>
                  {member.name || member.email}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </div>
        ) : null}
        {error ? (
          <span role="alert" className="min-w-0 break-words text-destructive">
            {error}
          </span>
        ) : null}
        <button
          type="button"
          className={`${buttonVariants({ variant: "outline", size: "sm" })} h-10 min-h-10 shrink-0 px-4 sm:h-8 sm:min-h-8`}
          disabled={busy}
          aria-busy={busy || undefined}
          data-testid="impersonation-stop"
          onClick={() => void stop()}
        >
          {busy ? <Trans>Working…</Trans> : <Trans>Stop</Trans>}
        </button>
      </div>
    </div>
  );
}
