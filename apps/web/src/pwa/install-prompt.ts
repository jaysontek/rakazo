import { isStandalone } from "./standalone.js";

export type BeforeInstallPromptEventLike = Event & {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};

export type InstallPromptHost = Pick<
  Window,
  "addEventListener" | "removeEventListener" | "matchMedia" | "document"
> & {
  navigator: Navigator & { standalone?: boolean };
  localStorage?: Pick<Storage, "getItem" | "setItem" | "removeItem">;
};

export type InstallPromptMode =
  | "hidden"
  | "install"
  | "ios-instructions"
  | "dismissed";

const DISMISS_KEY = "rakazo.installPrompt.dismissed";

export function isIosSafari(userAgent: string): boolean {
  const ua = userAgent;
  const iOS = /iPad|iPhone|iPod/.test(ua) || (ua.includes("Mac") && ua.includes("Mobile"));
  const webkit = /WebKit/.test(ua);
  const notOther = !/CriOS|FxiOS|EdgiOS|OPiOS|Chrome|Firefox|Edg/.test(ua);
  return iOS && webkit && notOther;
}

export function installPromptMode(input: {
  standalone: boolean;
  dismissed: boolean;
  canPrompt: boolean;
  iosSafari: boolean;
  installed: boolean;
}): InstallPromptMode {
  if (input.standalone || input.installed) return "hidden";
  if (input.dismissed) return "dismissed";
  if (input.canPrompt) return "install";
  if (input.iosSafari) return "ios-instructions";
  return "hidden";
}

export function readInstallDismissed(
  storage: Pick<Storage, "getItem"> | null | undefined = typeof localStorage === "undefined"
    ? undefined
    : localStorage,
): boolean {
  try {
    return storage?.getItem(DISMISS_KEY) === "1";
  } catch {
    return false;
  }
}

export function writeInstallDismissed(
  dismissed: boolean,
  storage: Pick<Storage, "setItem" | "removeItem"> | null | undefined = typeof localStorage ===
  "undefined"
    ? undefined
    : localStorage,
): void {
  try {
    if (!storage) return;
    if (dismissed) storage.setItem(DISMISS_KEY, "1");
    else storage.removeItem(DISMISS_KEY);
  } catch {
    // Private mode may refuse storage.
  }
}

export type InstallPromptController = {
  getMode(): InstallPromptMode;
  subscribe(listener: () => void): () => void;
  prompt(): Promise<"accepted" | "dismissed" | "unavailable">;
  dismiss(): void;
  dispose(): void;
};

/**
 * Captures `beforeinstallprompt` and tracks install/dismiss state for settings UI.
 */
export function createInstallPromptController(
  target: InstallPromptHost = window,
  options: { userAgent?: string; storage?: Pick<Storage, "getItem" | "setItem" | "removeItem"> } = {},
): InstallPromptController {
  const storage = options.storage ?? target.localStorage;
  const userAgent =
    options.userAgent ??
    ("userAgent" in target.navigator ? target.navigator.userAgent : "");
  let deferred: BeforeInstallPromptEventLike | null = null;
  let installed = false;
  let dismissed = readInstallDismissed(storage);
  const listeners = new Set<() => void>();

  const notify = () => {
    for (const listener of listeners) listener();
  };

  const onBeforeInstall = (event: Event) => {
    event.preventDefault();
    deferred = event as BeforeInstallPromptEventLike;
    notify();
  };
  const onInstalled = () => {
    installed = true;
    deferred = null;
    notify();
  };

  target.addEventListener("beforeinstallprompt", onBeforeInstall);
  target.addEventListener("appinstalled", onInstalled);

  return {
    getMode() {
      return installPromptMode({
        standalone: isStandalone(target),
        dismissed,
        canPrompt: Boolean(deferred),
        iosSafari: isIosSafari(userAgent),
        installed,
      });
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async prompt() {
      if (!deferred) return "unavailable";
      const event = deferred;
      deferred = null;
      try {
        await event.prompt();
        const { outcome } = await event.userChoice;
        if (outcome === "accepted") installed = true;
        notify();
        return outcome;
      } catch {
        notify();
        return "unavailable";
      }
    },
    dismiss() {
      dismissed = true;
      writeInstallDismissed(true, storage);
      notify();
    },
    dispose() {
      target.removeEventListener("beforeinstallprompt", onBeforeInstall);
      target.removeEventListener("appinstalled", onInstalled);
      listeners.clear();
    },
  };
}
