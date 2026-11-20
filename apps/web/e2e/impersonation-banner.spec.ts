import type { Route } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, openBotPanelTab, rpc, signup } from "./helpers";

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
  test("banner clears the sidebar and call dock without page overflow", async ({
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

    // Start the call while writable — the composer call button is disabled under
    // impersonation, and call-session state lives in the page module across SPA
    // remounts (but not full reloads).
    await rpc(page, "voice/connect", { provider: "scripted", apiKey: "fake-call-voice-key" });
    await page.goto("/app");
    await page.waitForURL(/\/app\/[^/]+$/);
    const callButton = page.getByTestId("call-button");
    await expect(callButton).toHaveAttribute("data-voice-ready", "");
    await callButton.click();
    await expect(page.getByTestId("call-view")).toBeVisible();

    await page.route("**/rpc/me", (route) => mockImpersonation(route, "me"));
    await page.route("**/rpc/bootstrap", (route) => mockImpersonation(route, "bootstrap"));
    await page.route("**/rpc/ops/stopImpersonation", async (route) => {
      await route.fulfill({ json: { json: { impersonating: null } } });
    });

    // Refetch the banner's me query without a full reload so the call stays up.
    await page.evaluate(async () => {
      // Vite serves this absolute path in e2e; TypeScript cannot resolve it as a module.
      const { queryClient } = await import(
        /* @vite-ignore */ // @ts-expect-error Vite absolute source URL
        "/src/lib/query.ts"
      );
      await queryClient.invalidateQueries({ queryKey: ["me"] });
    });

    const banner = page.getByTestId("impersonation-banner");
    await expect(banner).toBeVisible();
    await expect(page.getByTestId("impersonation-stop")).toBeVisible();
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

    // Settings dialog: Stop and the section nav must stay hittable above/below the banner.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByTestId("user-menu-trigger").click();
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    const settings = page.getByTestId("user-settings");
    await expect(settings).toBeVisible();
    const settingsHits = await page.evaluate(() => {
      const stop = document.querySelector('[data-testid="impersonation-stop"]') as HTMLElement;
      const nav = document.querySelector('[data-testid="settings-nav"]') as HTMLElement;
      const settingsEl = document.querySelector('[data-testid="user-settings"]') as HTMLElement;
      const stopBox = stop.getBoundingClientRect();
      const navBox = nav.getBoundingClientRect();
      const settingsBox = settingsEl.getBoundingClientRect();
      const bannerBottom =
        document.querySelector('[data-testid="impersonation-banner"]')?.getBoundingClientRect()
          .bottom ?? 0;
      const hitStop = document.elementFromPoint(
        stopBox.left + stopBox.width / 2,
        stopBox.top + stopBox.height / 2,
      );
      const hitNav = document.elementFromPoint(
        navBox.left + Math.min(24, navBox.width / 2),
        navBox.top + Math.min(24, navBox.height / 2),
      );
      return {
        stopHittable: Boolean(hitStop?.closest('[data-testid="impersonation-stop"]')),
        navHittable: Boolean(hitNav?.closest('[data-testid="settings-nav"]')),
        settingsTop: settingsBox.top,
        bannerBottom,
      };
    });
    expect(settingsHits.stopHittable).toBe(true);
    expect(settingsHits.navHittable).toBe(true);
    expect(settingsHits.settingsTop).toBeGreaterThanOrEqual(settingsHits.bannerBottom - 1);
    await page.keyboard.press("Escape");

    // Computer overlay clears the banner; Close and Stop stay hittable.
    await page.setViewportSize({ width: 1440, height: 900 });
    await openBotPanelTab(page, "Computer");
    await page.getByTestId("computer-preview-open").click();
    await expect(page.getByTestId("computer-viewport")).toBeVisible();
    const computerHits = await page.evaluate(() => {
      const stop = document.querySelector('[data-testid="impersonation-stop"]') as HTMLElement;
      const close = document.querySelector('[data-testid="computer-overlay-close"]') as HTMLElement;
      const bannerBottom =
        document.querySelector('[data-testid="impersonation-banner"]')?.getBoundingClientRect()
          .bottom ?? 0;
      const stopBox = stop.getBoundingClientRect();
      const closeBox = close.getBoundingClientRect();
      const hitStop = document.elementFromPoint(
        stopBox.left + stopBox.width / 2,
        stopBox.top + stopBox.height / 2,
      );
      const hitClose = document.elementFromPoint(
        closeBox.left + closeBox.width / 2,
        closeBox.top + closeBox.height / 2,
      );
      return {
        stopHittable: Boolean(hitStop?.closest('[data-testid="impersonation-stop"]')),
        closeHittable: Boolean(hitClose?.closest('[data-testid="computer-overlay-close"]')),
        closeTop: closeBox.top,
        bannerBottom,
      };
    });
    expect(computerHits.stopHittable).toBe(true);
    expect(computerHits.closeHittable).toBe(true);
    expect(computerHits.closeTop).toBeGreaterThanOrEqual(computerHits.bannerBottom - 1);

    await page.setViewportSize({ width: 390, height: 844 });
    const mobileClose = await page.evaluate(() => {
      const close = document.querySelector('[data-testid="computer-overlay-close"]') as HTMLElement;
      const bannerBottom =
        document.querySelector('[data-testid="impersonation-banner"]')?.getBoundingClientRect()
          .bottom ?? 0;
      const closeBox = close.getBoundingClientRect();
      const hitClose = document.elementFromPoint(
        closeBox.left + closeBox.width / 2,
        closeBox.top + closeBox.height / 2,
      );
      return {
        closeHittable: Boolean(hitClose?.closest('[data-testid="computer-overlay-close"]')),
        closeTop: closeBox.top,
        bannerBottom,
      };
    });
    expect(mobileClose.closeHittable).toBe(true);
    expect(mobileClose.closeTop).toBeGreaterThanOrEqual(mobileClose.bannerBottom - 1);
  });
});
