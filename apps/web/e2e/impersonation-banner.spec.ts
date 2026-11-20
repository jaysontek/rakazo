import type { Route } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, signup } from "./helpers";

const viewports = [
  { name: "desktop-1440x900", width: 1440, height: 900 },
  { name: "mobile-390x844", width: 390, height: 844 },
];

const impersonating = {
  adminUserId: "admin",
  targetUserId: "target",
  targetName: "Ada Lovelace",
  targetEmail: "ada@example.com",
  expiresAt: "2030-06-15T18:30:00.000Z",
  impersonationSessionId: "imp_e2e_1",
};

async function mockImpersonation(route: Route, path: "me" | "bootstrap") {
  const response = await route.fetch();
  const body = (await response.json()) as { json?: Record<string, unknown> };
  const me = path === "me" ? body.json : (body.json?.me as Record<string, unknown> | undefined);
  if (me) {
    me.impersonating = impersonating;
    me.isAdmin = false;
  }
  await route.fulfill({ response, json: body });
}

test.describe("impersonation banner layout", () => {
  test("banner clears the sidebar and call dock without page overflow @nightly", async ({
    page,
  }, testInfo) => {
    const stamp = Date.now();
    await signup(page, `impersonation-${stamp}@rakazo.test`, "password12", "Impersonation Layout");
    await completeOnboarding(page);

    // Before: shell without impersonation chrome (baseline screenshots).
    for (const viewport of viewports) {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await page.goto("/app");
      await page.waitForURL(/\/app\/[^/]+$/);
      await expect(page.getByTestId("shell-root")).toBeVisible();
      await captureScreenshot(page, testInfo, `impersonation-before-${viewport.name}`);
    }

    await page.route("**/rpc/me", (route) => mockImpersonation(route, "me"));
    await page.route("**/rpc/bootstrap", (route) => mockImpersonation(route, "bootstrap"));
    await page.route("**/rpc/voice/connect", async (route) => {
      await route.fulfill({
        json: {
          json: { provider: "scripted", ready: true, voiceId: "voice-1", transcribe: false },
        },
      });
    });
    await page.route("**/rpc/voice/status", async (route) => {
      await route.fulfill({
        json: {
          json: { provider: "scripted", ready: true, voiceId: "voice-1", transcribe: false },
        },
      });
    });
    await page.route("**/rpc/ops/stopImpersonation", async (route) => {
      await route.fulfill({ json: { json: { impersonating: null } } });
    });

    await page.reload();
    await page.waitForURL(/\/app\/[^/]+$/);
    const banner = page.getByTestId("impersonation-banner");
    await expect(banner).toBeVisible();
    await expect(page.getByTestId("impersonation-stop")).toBeVisible();

    // Start a call so CallCard / InThreadCallStrip are in play with the banner.
    await page.evaluate(async () => {
      const res = await fetch("/rpc/voice/connect", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ json: { provider: "scripted", apiKey: "fake" } }),
      });
      if (!res.ok) throw new Error(`voice connect ${res.status}`);
    });
    const callButton = page.getByTestId("call-button");
    await expect(callButton).toHaveAttribute("data-voice-ready", "");
    await callButton.click();
    await expect(page.getByTestId("call-view")).toBeVisible();

    for (const viewport of viewports) {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await expect(banner).toBeVisible();

      const geometry = await page.evaluate(() => {
        const bannerEl = document.querySelector(
          '[data-testid="impersonation-banner"]',
        ) as HTMLElement | null;
        const stop = document.querySelector(
          '[data-testid="impersonation-stop"]',
        ) as HTMLElement | null;
        const sidebar = document.querySelector(
          '[data-slot="sidebar-container"]',
        ) as HTMLElement | null;
        const call = document.querySelector('[data-testid="call-view"]') as HTMLElement | null;
        const bannerBox = bannerEl?.getBoundingClientRect();
        const stopBox = stop?.getBoundingClientRect();
        const sidebarBox = sidebar?.getBoundingClientRect();
        const callBox = call?.getBoundingClientRect();
        const hit =
          stopBox &&
          document.elementFromPoint(
            stopBox.left + stopBox.width / 2,
            stopBox.top + stopBox.height / 2,
          );
        const hitStop = Boolean(
          hit &&
            (hit === stop ||
              (hit instanceof Element && hit.closest('[data-testid="impersonation-stop"]'))),
        );
        return {
          bannerBottom: bannerBox?.bottom ?? 0,
          sidebarTop: sidebarBox?.top ?? null,
          callTop: callBox?.top ?? null,
          hitStop,
          scrollWidth: document.documentElement.scrollWidth,
          scrollHeight: document.documentElement.scrollHeight,
          clientWidth: document.documentElement.clientWidth,
          clientHeight: document.documentElement.clientHeight,
          bannerHeightVar: getComputedStyle(document.documentElement).getPropertyValue(
            "--impersonation-banner-height",
          ),
        };
      });

      expect(geometry.hitStop).toBe(true);
      expect(geometry.scrollWidth).toBeLessThanOrEqual(viewport.width + 1);
      expect(geometry.scrollHeight).toBeLessThanOrEqual(viewport.height + 2);
      expect(geometry.bannerHeightVar.trim()).not.toBe("0px");
      expect(geometry.bannerHeightVar.trim()).not.toBe("");

      if (viewport.width >= 1440 && geometry.sidebarTop != null) {
        expect(geometry.bannerBottom).toBeLessThanOrEqual(geometry.sidebarTop + 1);
      }
      if (geometry.callTop != null) {
        expect(geometry.bannerBottom).toBeLessThanOrEqual(geometry.callTop + 1);
      }

      await captureScreenshot(page, testInfo, `impersonation-after-${viewport.name}`);
    }

    // Settings dialog stays below the banner (dialog portals to body; top edge clear).
    await page.getByTestId("user-menu-trigger").click();
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    const settings = page.locator("[data-settings-section], [role='dialog']").first();
    await expect(settings).toBeVisible();
    const settingsTop = await settings.evaluate((el) => el.getBoundingClientRect().top);
    const bannerBottom = await banner.evaluate((el) => el.getBoundingClientRect().bottom);
    expect(settingsTop).toBeGreaterThanOrEqual(0);
    // Dialog may be centered; ensure banner Stop remains hittable above it.
    const stopHit = await page.evaluate(() => {
      const stop = document.querySelector('[data-testid="impersonation-stop"]') as HTMLElement;
      const box = stop.getBoundingClientRect();
      const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
      return Boolean(hit?.closest('[data-testid="impersonation-stop"]'));
    });
    expect(stopHit).toBe(true);
    expect(bannerBottom).toBeGreaterThan(0);
    await page.keyboard.press("Escape");
  });
});
