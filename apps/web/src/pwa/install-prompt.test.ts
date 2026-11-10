// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createInstallPromptController,
  ensureInstallPromptController,
  installPromptMode,
  isIosSafari,
  readInstallDismissed,
  resetInstallPromptControllerForTests,
  writeInstallDismissed,
} from "./install-prompt.js";

describe("installPromptMode", () => {
  it("hides when already installed or standalone", () => {
    expect(
      installPromptMode({
        standalone: true,
        dismissed: false,
        canPrompt: true,
        iosSafari: false,
        installed: false,
      }),
    ).toBe("hidden");
    expect(
      installPromptMode({
        standalone: false,
        dismissed: false,
        canPrompt: true,
        iosSafari: false,
        installed: true,
      }),
    ).toBe("hidden");
  });

  it("prefers the native install prompt when available", () => {
    expect(
      installPromptMode({
        standalone: false,
        dismissed: false,
        canPrompt: true,
        iosSafari: true,
        installed: false,
      }),
    ).toBe("install");
  });

  it("shows iOS instructions when Safari cannot prompt", () => {
    expect(
      installPromptMode({
        standalone: false,
        dismissed: false,
        canPrompt: false,
        iosSafari: true,
        installed: false,
      }),
    ).toBe("ios-instructions");
  });

  it("remembers dismiss", () => {
    expect(
      installPromptMode({
        standalone: false,
        dismissed: true,
        canPrompt: true,
        iosSafari: false,
        installed: false,
      }),
    ).toBe("dismissed");
  });
});

describe("isIosSafari", () => {
  it("detects iPhone Safari, Chrome, and Edge on iOS", () => {
    expect(
      isIosSafari(
        "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
      ),
    ).toBe(true);
    expect(
      isIosSafari(
        "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/120.0.0.0 Mobile/15E148 Safari/604.1",
      ),
    ).toBe(true);
    expect(
      isIosSafari(
        "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) EdgiOS/120.0.0.0 Mobile/15E148 Safari/604.1",
      ),
    ).toBe(true);
  });

  it("detects iPadOS desktop-mode Safari", () => {
    expect(
      isIosSafari(
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15",
        5,
      ),
    ).toBe(true);
    expect(
      isIosSafari(
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15",
        0,
      ),
    ).toBe(false);
  });
});

describe("createInstallPromptController", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("captures beforeinstallprompt and prompts on demand", async () => {
    const storage = new Map<string, string>();
    const listeners = new Map<string, Set<EventListener>>();
    const host = {
      document: {} as Document,
      matchMedia: () => ({ matches: false }) as MediaQueryList,
      navigator: { standalone: false, userAgent: "Chrome" } as Navigator & { standalone?: boolean },
      localStorage: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => storage.set(key, value),
        removeItem: (key: string) => storage.delete(key),
      },
      addEventListener: (type: string, listener: EventListener) => {
        if (!listeners.has(type)) listeners.set(type, new Set());
        listeners.get(type)!.add(listener);
      },
      removeEventListener: (type: string, listener: EventListener) => {
        listeners.get(type)?.delete(listener);
      },
    };
    const controller = createInstallPromptController(host, {
      userAgent: "Chrome",
      storage: host.localStorage,
    });
    expect(controller.getMode()).toBe("hidden");

    const prompt = vi.fn(async () => undefined);
    const event = {
      type: "beforeinstallprompt",
      preventDefault: vi.fn(),
      prompt,
      userChoice: Promise.resolve({ outcome: "accepted" as const }),
    };
    for (const listener of listeners.get("beforeinstallprompt") ?? []) {
      listener(event as unknown as Event);
    }
    expect(controller.getMode()).toBe("install");
    await expect(controller.prompt()).resolves.toBe("accepted");
    expect(prompt).toHaveBeenCalledOnce();
    expect(controller.getMode()).toBe("hidden");
    controller.dispose();
  });

  it("persists dismiss", () => {
    const storage = new Map<string, string>();
    const api = {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    };
    expect(readInstallDismissed(api)).toBe(false);
    writeInstallDismissed(true, api);
    expect(readInstallDismissed(api)).toBe(true);
  });

  it("keeps a beforeinstallprompt that fired before Settings mounts", () => {
    resetInstallPromptControllerForTests();
    const storage = new Map<string, string>();
    const listeners = new Map<string, Set<EventListener>>();
    const host = {
      document: {} as Document,
      matchMedia: () => ({ matches: false }) as MediaQueryList,
      navigator: { standalone: false, userAgent: "Chrome", maxTouchPoints: 0 } as Navigator & {
        standalone?: boolean;
      },
      localStorage: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => storage.set(key, value),
        removeItem: (key: string) => storage.delete(key),
      },
      addEventListener: (type: string, listener: EventListener) => {
        if (!listeners.has(type)) listeners.set(type, new Set());
        listeners.get(type)!.add(listener);
      },
      removeEventListener: (type: string, listener: EventListener) => {
        listeners.get(type)?.delete(listener);
      },
    };

    // App startup captures the event before Settings mounts.
    const startup = ensureInstallPromptController(host);
    expect(startup).not.toBeNull();
    const event = {
      type: "beforeinstallprompt",
      preventDefault: vi.fn(),
      prompt: vi.fn(async () => undefined),
      userChoice: Promise.resolve({ outcome: "accepted" as const }),
    };
    for (const listener of listeners.get("beforeinstallprompt") ?? []) {
      listener(event as unknown as Event);
    }
    expect(startup!.getMode()).toBe("install");

    // Settings mounts later and still sees the deferred prompt on the shared controller.
    const late = ensureInstallPromptController(host);
    expect(late).toBe(startup);
    expect(late!.getMode()).toBe("install");
    resetInstallPromptControllerForTests();
  });
});
