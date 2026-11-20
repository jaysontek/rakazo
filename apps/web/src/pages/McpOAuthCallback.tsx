import { Trans, useLingui } from "@lingui/react/macro";
import { Button } from "@rakazo/ui-web";
import { useEffect, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { ImpersonationBlockedPage } from "../components/ImpersonationBlockedPage";
import { MCP_OAUTH_CHANNEL } from "../lib/mcp-connect";
import { rpc } from "../lib/rpc";
import { useIsImpersonating } from "../lib/use-impersonating";
import { errorText } from "../lib/user-error";

// The window.open name set by the OAuth popup flow. Providers whose login
// pages send COOP sever window.opener mid-flow, but the window name survives,
// so it is the reliable "we are the popup" marker.
const POPUP_NAME = MCP_OAUTH_CHANNEL;

export function McpOAuthCallbackPage() {
  const { t } = useLingui();
  const impersonating = useIsImpersonating();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const handledState = useRef<string | null>(null);
  useEffect(() => {
    if (impersonating) return;
    const code = params.get("code");
    const state = params.get("state");
    if (!code || !state) {
      setError(params.get("error_description") ?? t`OAuth authorization was cancelled.`);
      return;
    }
    if (handledState.current === state) return;
    handledState.current = state;
    void rpc.mcp.oauth
      .complete({ sessionId: state, code, state })
      .then(() => {
        const channel = new BroadcastChannel(POPUP_NAME);
        channel.postMessage({ type: "mcp-oauth-complete" });
        channel.close();
        if (window.name === POPUP_NAME) {
          setDone(true);
          window.close();
          return;
        }
        navigate("/app?mcp_oauth=connected", { replace: true });
      })
      .catch((err: unknown) => setError(errorText(err, t`Could not complete OAuth`)));
  }, [impersonating, navigate, params, t]);
  if (impersonating) return <ImpersonationBlockedPage />;
  const showReturn = Boolean(error) && window.name !== POPUP_NAME;
  return (
    <div className="grid min-h-screen place-items-center bg-background p-6 text-center">
      <div>
        <div className="text-lg text-foreground">
          {error ? (
            <Trans>OAuth connection failed</Trans>
          ) : done ? (
            <Trans>Connected</Trans>
          ) : (
            <Trans>Finishing MCP connection…</Trans>
          )}
        </div>
        {error ? <p className="mt-2 max-w-md text-sm text-muted-foreground">{error}</p> : null}
        {showReturn ? (
          <Button type="button" className="mt-5" onClick={() => navigate("/app")}>
            <Trans>Return to Rakazo</Trans>
          </Button>
        ) : (
          <p className="mt-2 text-sm text-muted-foreground">
            {error || done ? (
              <Trans>You can close this window.</Trans>
            ) : (
              <Trans>You can close this tab if it does not redirect automatically.</Trans>
            )}
          </p>
        )}
      </div>
    </div>
  );
}
