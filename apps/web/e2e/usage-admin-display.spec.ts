import { expect, test } from "@playwright/test";
import { captureScreenshot } from "./helpers";

const viewports = [
  { name: "desktop-1440x900", width: 1440, height: 900 },
  { name: "mobile-390x844", width: 390, height: 844 },
] as const;

for (const viewport of viewports) {
  test(`admin ops display @ ${viewport.name}`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.goto("/e2e/fixtures/admin-ops.html?theme=light");
    await expect(page.getByTestId("ops-dashboard")).toBeVisible();

    // No dead WindowChrome spacer above the header on web.
    const gap = await page.evaluate(() => {
      const chrome = document.querySelector('[aria-hidden="true"].h-3');
      if (!chrome) return 0;
      return (chrome as HTMLElement).offsetHeight;
    });
    expect(gap).toBe(0);

    // Every account row/card exposes a model (badge or em dash).
    if (viewport.width >= 768) {
      const modelCells = page.locator("table tbody tr td:nth-child(3)");
      await expect(modelCells.first()).toBeVisible();
      const count = await modelCells.count();
      expect(count).toBeGreaterThan(0);
      for (let i = 0; i < count; i += 1) {
        const text = (await modelCells.nth(i).innerText()).trim();
        expect(text.length).toBeGreaterThan(0);
      }
    } else {
      await expect(page.locator("ul.grid li").first()).toBeVisible();
    }

    // No page-level horizontal overflow at 390.
    if (viewport.width === 390) {
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
      );
      expect(overflow).toBe(false);
    }

    // Percent includes reserved for Alex (12.5 + 0.5 of 25 → 52%).
    await expect(page.getByText("52%", { exact: true }).locator("visible=true").first()).toBeVisible();
    await expect(page.getByText("+$0.50 held").locator("visible=true").first()).toBeVisible();

    await captureScreenshot(page, testInfo, `admin-ops-${viewport.name}`);
  });

  test(`usage settings + popover @ ${viewport.name}`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });

    await page.goto("/e2e/fixtures/usage-display.html?theme=light&view=settings");
    await expect(page.getByTestId("usage-settings")).toBeVisible();
    await expect(page.getByTestId("shared-key-usage-blocked")).toBeVisible();
    await expect(page.getByTestId("shared-key-usage-meter")).not.toContainText("$");
    if (viewport.width < 640) {
      await expect(page.getByTestId("usage-models-compact")).toBeVisible();
    }
    const settingsOverflow = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
    );
    expect(settingsOverflow).toBe(false);
    await captureScreenshot(page, testInfo, `usage-settings-${viewport.name}`);

    await page.goto("/e2e/fixtures/usage-display.html?theme=light&view=popover");
    await expect(page.getByTestId("shared-key-usage-meter")).toBeVisible();
    await expect(page.getByTestId("shared-key-usage-blocked")).toBeVisible();
    await captureScreenshot(page, testInfo, `usage-popover-${viewport.name}`);
  });
}
