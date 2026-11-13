import { Trans, useLingui } from "@lingui/react/macro";
import { buttonVariants } from "@rakazo/ui-web";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useSpaceQueries } from "../lib/query";
import { rpc } from "../lib/rpc";
import { errorText } from "../lib/user-error";

/** Top-of-app chrome while an admin is viewing as another account. */
export function ImpersonationBanner() {
  const { t } = useLingui();
  const navigate = useNavigate();
  const queries = useSpaceQueries();
  const queryClient = useQueryClient();
  const me = useQuery(queries.me.queryOptions());
  const [stopping, setStopping] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const impersonating = me.data?.impersonating;
  if (!impersonating) return null;

  const targetName = impersonating.targetName;
  const targetEmail = impersonating.targetEmail;

  async function stop() {
    setStopping(true);
    setError(null);
    try {
      const next = await rpc.ops.stopImpersonation();
      queryClient.setQueryData(queries.me.queryKey(), next);
      await queryClient.invalidateQueries();
      navigate("/app", { replace: true });
    } catch (err) {
      setError(errorText(err, t`Could not stop impersonation`));
      setStopping(false);
    }
  }

  return (
    <div
      role="status"
      data-testid="impersonation-banner"
      className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-warning/40 bg-warning/10 px-4 py-2 text-sm text-warning"
    >
      <span className="min-w-0 flex-1 truncate">
        {targetName ? (
          <Trans>
            Viewing as {targetName} ({targetEmail})
          </Trans>
        ) : (
          <Trans>Viewing as {targetEmail}</Trans>
        )}
      </span>
      {error ? (
        <span role="alert" className="text-destructive">
          {error}
        </span>
      ) : null}
      <button
        type="button"
        className={buttonVariants({ variant: "outline", size: "sm" })}
        disabled={stopping}
        onClick={() => void stop()}
      >
        {stopping ? <Trans>Stopping…</Trans> : <Trans>Stop</Trans>}
      </button>
    </div>
  );
}
