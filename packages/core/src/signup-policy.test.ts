import { describe, expect, it } from "vitest";
import { isGatedSharedKeyDeployment, signupsOpen } from "./signup-policy.js";

describe("isGatedSharedKeyDeployment", () => {
  it("treats the code default (open signups) as not gated", () => {
    expect(signupsOpen(undefined)).toBe(true);
    expect(
      isGatedSharedKeyDeployment({
        signupsEnabled: undefined,
        signupAllowlist: undefined,
      }),
    ).toBe(false);
  });

  it("gates when signups are disabled, allowlisted, single-account, or directory", () => {
    expect(
      isGatedSharedKeyDeployment({
        signupsEnabled: "false",
        signupAllowlist: undefined,
      }),
    ).toBe(true);
    expect(
      isGatedSharedKeyDeployment({
        signupsEnabled: "true",
        signupAllowlist: "ops@example.com",
      }),
    ).toBe(true);
    expect(
      isGatedSharedKeyDeployment({
        signupsEnabled: "true",
        signupAllowlist: "",
        singleAccount: true,
      }),
    ).toBe(true);
    expect(
      isGatedSharedKeyDeployment({
        signupsEnabled: "true",
        signupAllowlist: "",
        directoryProvisioning: true,
      }),
    ).toBe(true);
  });
});
