import type { QueryClient } from "@tanstack/react-query";
import { authClient } from "./auth";
import { clearImpersonationTeammates } from "./impersonation-teammates";
import { clearSpaceSelection } from "./rpc";

/**
 * Account-agnostic prefs that must survive an impersonation start/stop/switch.
 * Locale and appearance are required; other device-level chrome prefs stay too.
 */
const KEEP_LOCAL_STORAGE_KEYS = new Set([
  "rakazo.uiLocale",
  "rakazo.uiAppearance",
  "rakazo.composerEnterToSend",
  "rakazo.showToolActivity",
  "rakazo.botsSidebarDensity",
  "rakazo.loadRemoteImages",
  "rakazo.responseStreaming",
  "rakazo.installPrompt.dismissed",
  "rakazo.signed-in-before",
  "rakazo:artifacts-view-mode",
  "rakazo:right-panel-width",
]);

function isUserScopedRakazoKey(key: string): boolean {
  if (!(key.startsWith("rakazo:") || key.startsWith("rakazo."))) return false;
  return !KEEP_LOCAL_STORAGE_KEYS.has(key);
}

/** Drop per-user localStorage so the next session cannot inherit admin drafts/space. */
export function clearImpersonationLocalState(): void {
  clearSpaceSelection();
  try {
    const keys: string[] = [];
    for (let index = 0; index < localStorage.length; index++) {
      const key = localStorage.key(index);
      if (key) keys.push(key);
    }
    for (const key of keys) {
      if (isUserScopedRakazoKey(key)) localStorage.removeItem(key);
    }
  } catch {
    // Without storage there is nothing user-scoped to leak.
  }
}

export type HardSwitchImpersonationOptions = {
  queryClient: QueryClient;
  /** Where to land after reload. Defaults to `/app`. */
  target?: string;
  /** Clear the banner teammate list (stop). Leave set when switching members. */
  clearTeammates?: boolean;
  /** Test seam: replace `window.location.assign`. */
  assign?: (url: string) => void;
};

/**
 * Hard boundary between admin and impersonated (or next) identity:
 * clear space/user local state, wipe React Query, re-signal Better Auth, reload.
 */
export function hardSwitchImpersonation({
  queryClient,
  target = "/app",
  clearTeammates = false,
  assign = (url) => window.location.assign(url),
}: HardSwitchImpersonationOptions): void {
  clearImpersonationLocalState();
  if (clearTeammates) clearImpersonationTeammates();
  queryClient.clear();
  authClient.$store.notify("$sessionSignal");
  assign(target);
}
