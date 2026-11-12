import { afterEach, describe, expect, it } from "vitest";
import {
  clearDeploymentModelTpmWindows,
  isDeploymentModelTpmLimited,
  markDeploymentModelTpmLimited,
} from "./deployment-tpm-window.js";

afterEach(() => {
  clearDeploymentModelTpmWindows();
});

describe("deployment TPM windows", () => {
  it("blocks the primary until the per-minute window resets, then clears", () => {
    const now = Date.parse("2026-11-12T12:00:00Z");
    markDeploymentModelTpmLimited(
      "google",
      "gemini-3.8-flash",
      {
        status: 429,
        message: "Rate limit reached on tokens per min (TPM): Limit 1. Please try again in 12s.",
      },
      now,
    );
    expect(isDeploymentModelTpmLimited("google", "gemini-3.8-flash", now + 11_000)).toBe(true);
    expect(isDeploymentModelTpmLimited("google", "gemini-3.7-flash", now + 11_000)).toBe(false);
    expect(isDeploymentModelTpmLimited("google", "gemini-3.8-flash", now + 12_000)).toBe(false);
  });

  it("ignores non-TPM failures", () => {
    markDeploymentModelTpmLimited("google", "gemini-3.8-flash", "503 overloaded");
    expect(isDeploymentModelTpmLimited("google", "gemini-3.8-flash")).toBe(false);
  });
});
