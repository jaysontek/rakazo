import { describe, expect, it } from "vitest";
import { isGatedSharedKeyDeployment, parseAdminEmails, signupsOpen } from "./signup-policy.js";

describe("parseAdminEmails", () => {
  it("splits on commas or whitespace and lowercases", () => {
    expect(parseAdminEmails("Ops@Example.com other@example.com,Third@Example.COM")).toEqual([
      "ops@example.com",
      "other@example.com",
      "third@example.com",
    ]);
    expect(parseAdminEmails(undefined)).toEqual([]);
    expect(parseAdminEmails("  ")).toEqual([]);
  });
});

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
