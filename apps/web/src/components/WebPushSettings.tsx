import { Trans, useLingui } from "@lingui/react/macro";
import { Label, Switch } from "@rakazo/ui-web";
import { useEffect, useId, useState } from "react";
import { desktopBridge } from "../lib/desktop";
import { useSpaceRpc } from "../lib/space-rpc";
import {
  currentWebPushSubscription,
  fetchWebPushStatus,
  subscribeWebPush,
  unsubscribeWebPush,
  webPushNeedsHomeScreenInstall,
  webPushSupported,
} from "../lib/web-push";
import { SettingsGroup, SettingsRow } from "./SettingsRows";

/** Device push for closed tabs. Hidden when VAPID is unset or the platform cannot subscribe. */
export function WebPushSettings() {
  const { t } = useLingui();
  const rpc = useSpaceRpc();
  const id = useId();
  const [available, setAvailable] = useState(false);
  const [publicKey, setPublicKey] = useState<string | undefined>();
  const [subscribed, setSubscribed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const needsInstall = !desktopBridge() && webPushNeedsHomeScreenInstall();
  const supported = !desktopBridge() && webPushSupported();

  useEffect(() => {
    if (desktopBridge()) return;
    let active = true;
    void (async () => {
      try {
        const status = await fetchWebPushStatus(rpc);
        if (!active) return;
        setAvailable(status.available);
        setPublicKey(status.publicKey);
        if (status.available && supported) {
          setSubscribed(Boolean(await currentWebPushSubscription()));
        }
      } catch {
        if (active) setAvailable(false);
      } finally {
        if (active) setReady(true);
      }
    })();
    return () => {
      active = false;
    };
  }, [rpc, supported]);

  if (desktopBridge() || !ready || !available) return null;
  if (!supported && !needsInstall) return null;

  async function toggle(next: boolean) {
    if (busy || needsInstall || !publicKey) return;
    setBusy(true);
    setError(null);
    try {
      if (next) await subscribeWebPush(rpc, publicKey);
      else await unsubscribeWebPush(rpc);
      setSubscribed(next);
    } catch {
      setError(t`Couldn't update notifications`);
      setSubscribed(Boolean(await currentWebPushSubscription().catch(() => null)));
    } finally {
      setBusy(false);
    }
  }

  return (
    <SettingsGroup title={<Trans>Notifications</Trans>} data-testid="web-push-settings">
      <SettingsRow
        label={
          <Label htmlFor={id} className="text-[14px] font-normal text-foreground">
            <Trans>Background alerts</Trans>
          </Label>
        }
        control={
          <Switch
            id={id}
            data-testid="web-push-toggle"
            checked={subscribed}
            disabled={busy || needsInstall || !publicKey}
            onCheckedChange={(checked) => void toggle(checked)}
          />
        }
      >
        {needsInstall ? (
          <p
            className="mt-2 text-[12.5px] text-muted-foreground"
            data-testid="web-push-install-hint"
          >
            <Trans>Install the app first to enable alerts on this device.</Trans>
          </p>
        ) : null}
        {error ? (
          <p role="alert" className="mt-2 text-[12.5px] text-destructive">
            {error}
          </p>
        ) : null}
      </SettingsRow>
    </SettingsGroup>
  );
}
