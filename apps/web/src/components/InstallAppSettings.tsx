import { Trans } from "@lingui/react/macro";
import { Button } from "@rakazo/ui-web";
import { useEffect, useState, useSyncExternalStore } from "react";
import { desktopBridge } from "../lib/desktop";
import type { InstallPromptController, InstallPromptMode } from "../pwa/install-prompt";
import { ensureInstallPromptController } from "../pwa/install-prompt";
import { SettingsGroup, SettingsRow } from "./SettingsRows";

function installController(): InstallPromptController | null {
  if (typeof window === "undefined" || desktopBridge()) return null;
  return ensureInstallPromptController();
}

function useInstallPromptMode(): InstallPromptMode {
  const controller = installController();
  return useSyncExternalStore(
    (listener) => controller?.subscribe(listener) ?? (() => undefined),
    () => controller?.getMode() ?? "hidden",
    () => "hidden",
  );
}

/** Browser-only install affordance for General settings. Hidden when installed or on desktop. */
export function InstallAppSettings() {
  const mode = useInstallPromptMode();
  const [busy, setBusy] = useState(false);
  const [visible, setVisible] = useState(mode === "install" || mode === "ios-instructions");

  useEffect(() => {
    if (mode === "install" || mode === "ios-instructions") setVisible(true);
    if (mode === "hidden") setVisible(false);
  }, [mode]);

  if (!visible || mode === "hidden" || mode === "dismissed") return null;

  async function install() {
    const controller = installController();
    if (!controller || busy) return;
    setBusy(true);
    try {
      await controller.prompt();
    } finally {
      setBusy(false);
    }
  }

  function dismiss() {
    installController()?.dismiss();
    setVisible(false);
  }

  return (
    <SettingsGroup title={<Trans>App</Trans>} data-testid="install-app-settings">
      <SettingsRow
        label={
          mode === "ios-instructions" ? (
            <Trans>Add to Home Screen</Trans>
          ) : (
            <Trans>Install app</Trans>
          )
        }
        control={
          <div className="flex items-center gap-2">
            {mode === "install" ? (
              <Button
                size="sm"
                data-testid="install-app-button"
                disabled={busy}
                onClick={() => void install()}
              >
                <Trans>Install</Trans>
              </Button>
            ) : null}
            <Button
              size="sm"
              variant="ghost"
              data-testid="install-app-dismiss"
              aria-label="Dismiss"
              onClick={dismiss}
            >
              <Trans>Dismiss</Trans>
            </Button>
          </div>
        }
      >
        {mode === "ios-instructions" ? (
          <p className="mt-2 text-[12.5px] text-muted-foreground" data-testid="install-ios-hint">
            <Trans>Share → Add to Home Screen</Trans>
          </p>
        ) : null}
      </SettingsRow>
    </SettingsGroup>
  );
}
