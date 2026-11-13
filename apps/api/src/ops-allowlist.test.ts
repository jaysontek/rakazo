import { describe, expect, it } from "vitest";
import { createOpsAllowlistChecker, parseOpsDashboardAllowlist } from "./ops-allowlist.js";

describe("parseOpsDashboardAllowlist", () => {
  it("returns empty when unset", () => {
    expect(parseOpsDashboardAllowlist(undefined)).toEqual([]);
    expect(parseOpsDashboardAllowlist("")).toEqual([]);
    expect(parseOpsDashboardAllowlist("  ")).toEqual([]);
  });

  it("splits comma and whitespace entries", () => {
    expect(parseOpsDashboardAllowlist("192.168.140.0/24, 100.64.0.0/10 10.0.0.1")).toEqual([
      "192.168.140.0/24",
      "100.64.0.0/10",
      "10.0.0.1",
    ]);
  });
});

describe("createOpsAllowlistChecker", () => {
  it("allows loopback even when the allowlist is empty", () => {
    const checker = createOpsAllowlistChecker([]);
    expect(checker.configured).toBe(false);
    expect(checker.allows("127.0.0.1")).toBe(true);
    expect(checker.allows("::1")).toBe(true);
    expect(checker.allows("192.168.140.10")).toBe(false);
    expect(checker.allows(undefined)).toBe(false);
  });

  it("allows configured CIDRs and rejects others", () => {
    const checker = createOpsAllowlistChecker(["192.168.140.0/24", "100.64.0.0/10"]);
    expect(checker.configured).toBe(true);
    expect(checker.allows("192.168.140.42")).toBe(true);
    expect(checker.allows("100.64.1.2")).toBe(true);
    expect(checker.allows("203.0.113.10")).toBe(false);
  });

  it("rejects hostnames as allowlist entries", () => {
    expect(() => createOpsAllowlistChecker(["proxy.example.test"])).toThrow(
      /OPS_DASHBOARD_ALLOWLIST/,
    );
  });
});
