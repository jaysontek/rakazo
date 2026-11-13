import { OPENAI_COMPATIBLE_PROVIDER_ID } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import { LOCAL_PROVIDER_ID } from "./pi-local-provider.js";
import { isDeploymentSharedKeyUsage, sharedKeyMaterialMatches } from "./shared-key-usage.js";
import { SharedKeyWeeklyBudgetExceededRunError } from "./shared-key-budget-observer.js";
import { isTerminalModelSetupError } from "./run-model.js";

describe("sharedKeyMaterialMatches", () => {
  it("matches equal key material without exposing it", () => {
    expect(sharedKeyMaterialMatches("company-key", "company-key")).toBe(true);
    expect(sharedKeyMaterialMatches("company-key", "personal-key")).toBe(false);
  });
});

describe("isDeploymentSharedKeyUsage", () => {
  it("is true for the deployment shared API key", () => {
    expect(
      isDeploymentSharedKeyUsage({ ownCredential: false, provider: "openrouter" }),
    ).toBe(true);
    expect(
      isDeploymentSharedKeyUsage({ ownCredential: false, provider: "google" }),
    ).toBe(true);
    // Stored credential whose material matched the deployment key omits ownCredential.
    expect(isDeploymentSharedKeyUsage({ provider: "google" })).toBe(true);
  });

  it("is false for personal connections", () => {
    expect(
      isDeploymentSharedKeyUsage({ ownCredential: true, provider: "openrouter" }),
    ).toBe(false);
  });

  it("is false for local, OpenAI-compatible, and scripted usage", () => {
    expect(
      isDeploymentSharedKeyUsage({ ownCredential: false, provider: LOCAL_PROVIDER_ID }),
    ).toBe(false);
    expect(
      isDeploymentSharedKeyUsage({
        ownCredential: false,
        provider: OPENAI_COMPATIBLE_PROVIDER_ID,
        baseUrl: "http://127.0.0.1:11434/v1",
      }),
    ).toBe(false);
    expect(
      isDeploymentSharedKeyUsage({
        ownCredential: false,
        provider: "scripted",
        scriptedRuntime: true,
      }),
    ).toBe(false);
  });
});

describe("shared-key budget vs personal-key backup", () => {
  it("does not treat weekly budget exhaustion as a terminal setup error", () => {
    expect(isTerminalModelSetupError(new SharedKeyWeeklyBudgetExceededRunError())).toBe(false);
  });
});
