import { describe, expect, it } from "vitest";
import { sameOriginOpenUrl } from "../pwa/service-worker.js";
import { webPushNeedsHomeScreenInstall, webPushSupported } from "./web-push.js";

describe("webPushNeedsHomeScreenInstall", () => {
  it("requires a Home Screen install on iPhone Safari", () => {
    const host = {
      navigator: { standalone: false, maxTouchPoints: 5 } as Navigator & { standalone?: boolean },
      matchMedia: () => ({ matches: false }) as MediaQueryList,
    };
    expect(
      webPushNeedsHomeScreenInstall(
        host,
        "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15",
      ),
    ).toBe(true);
    const installed = {
      ...host,
      navigator: { standalone: true, maxTouchPoints: 5 } as Navigator & { standalone?: boolean },
    };
    expect(
      webPushNeedsHomeScreenInstall(
        installed,
        "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15",
      ),
    ).toBe(false);
  });

  it("does not gate desktop Chrome", () => {
    const host = {
      navigator: { standalone: false, maxTouchPoints: 0 } as Navigator & { standalone?: boolean },
      matchMedia: () => ({ matches: false }) as MediaQueryList,
    };
    expect(webPushNeedsHomeScreenInstall(host, "Mozilla/5.0 (Windows NT 10.0) Chrome/120")).toBe(
      false,
    );
  });
});

describe("webPushSupported", () => {
  it("requires Notification, PushManager and a service worker", () => {
    expect(
      webPushSupported({
        Notification: { permission: "default" },
        PushManager: {},
        navigator: {
          serviceWorker: {} as ServiceWorkerContainer,
          standalone: true,
          maxTouchPoints: 5,
        } as Navigator & { standalone?: boolean },
        matchMedia: () => ({ matches: true }) as MediaQueryList,
      }),
    ).toBe(true);
  });
});

describe("sameOriginOpenUrl", () => {
  it("allows only same-origin URLs", () => {
    expect(sameOriginOpenUrl("https://app.example.com", { url: "/?bot=1" })).toBe(
      "https://app.example.com/?bot=1",
    );
    expect(sameOriginOpenUrl("https://app.example.com", { url: "https://evil.example/x" })).toBe(
      null,
    );
  });
});
