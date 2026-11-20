import { Trans } from "@lingui/react/macro";
import { Button } from "@rakazo/ui-web";
import { useEffect, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { ImpersonationBlockedPage } from "../components/ImpersonationBlockedPage";
import { PageLoading } from "../components/PageLoading";
import { rpc } from "../lib/rpc";
import { useIsImpersonating } from "../lib/use-impersonating";

export function SlackInstallCallbackPage() {
  const navigate = useNavigate();
  const impersonating = useIsImpersonating();
  const [params] = useSearchParams();
  const [failed, setFailed] = useState(false);
  const handled = useRef(false);
  useEffect(() => {
    if (impersonating || handled.current) return;
    handled.current = true;
    const state = params.get("state");
    const code = params.get("code");
    if (!state || !code) {
      setFailed(true);
      return;
    }
    rpc.messaging.installations.complete({ state, code }).then(
      () => navigate("/app?settings=messaging", { replace: true }),
      () => setFailed(true),
    );
  }, [impersonating, navigate, params]);
  if (impersonating) return <ImpersonationBlockedPage />;
  if (!failed) return <PageLoading />;
  return (
    <div className="grid min-h-screen place-items-center bg-background p-6 text-center">
      <div>
        <div className="text-lg text-foreground">
          <Trans>Could not connect</Trans>
        </div>
        <Button type="button" className="mt-5" onClick={() => navigate("/app?settings=messaging")}>
          <Trans>Return to Rakazo</Trans>
        </Button>
      </div>
    </div>
  );
}
