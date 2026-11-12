import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, rpc, signup } from "./helpers";

test("an ongoing call stays in reach on a page outside the shell", async ({ page }, testInfo) => {
  const stamp = Date.now();
  await signup(page, `call-controls-${stamp}@rakazo.test`, "password12", "Call Controls");
  await completeOnboarding(page);
  await rpc(page, "voice/connect", { provider: "scripted", apiKey: "fake-call-voice-key" });
  await page.goto("/app");
  await page.waitForURL(/\/app\/[^/]+$/);
  // Until the voice status loads, the call button opens voice settings instead of calling.
  const callButton = page.getByTestId("call-button");
  await expect(callButton).toHaveAttribute("data-voice-ready", "");

  await callButton.click();
  const call = page.getByTestId("call-view");
  await expect(call).toBeVisible();
  // The thread stays visible under the composer call strip.
  await expect(page.getByTestId("transcript")).toBeVisible();
  await expect(page.getByTestId("composer-bar")).toBeVisible();
  await captureScreenshot(page, testInfo, "call-strip-in-thread");

  await page.getByTestId("user-menu-trigger").click();
  await page.getByRole("button", { name: "Artifacts", exact: true }).click();
  await expect(page).toHaveURL(/\/app\/artifacts$/);
  await expect(page.getByRole("heading", { name: "Artifacts", exact: true })).toBeVisible();
  await expect(call).toBeVisible();
  await captureScreenshot(page, testInfo, "call-strip-artifacts");

  await call.getByRole("button", { name: "Hang up" }).click();
  await expect(call).toBeHidden();
});
