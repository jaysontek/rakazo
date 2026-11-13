import { describe, expect, it } from "vitest";
import { isHiddenOpsEmail } from "./ops-email-filter.js";

describe("isHiddenOpsEmail", () => {
  it("hides the apex domain and subdomains", () => {
    expect(isHiddenOpsEmail("owner@builddrive.net")).toBe(true);
    expect(isHiddenOpsEmail("dev@corp.builddrive.net")).toBe(true);
    expect(isHiddenOpsEmail("a@x.builddrive.net")).toBe(true);
  });

  it("matches mixed case", () => {
    expect(isHiddenOpsEmail("Owner@BuildDrive.Net")).toBe(true);
    expect(isHiddenOpsEmail("dev@Corp.BUILDDRIVE.NET")).toBe(true);
  });

  it("strips trailing dots on the domain, including doubles", () => {
    expect(isHiddenOpsEmail("owner@builddrive.net.")).toBe(true);
    expect(isHiddenOpsEmail("dev@corp.builddrive.net.")).toBe(true);
    expect(isHiddenOpsEmail("owner@builddrive.net..")).toBe(true);
    expect(isHiddenOpsEmail("dev@corp.builddrive.net...")).toBe(true);
  });

  it("treats ideographic and fullwidth dots as separators", () => {
    expect(isHiddenOpsEmail("owner@builddrive\u3002net")).toBe(true);
    expect(isHiddenOpsEmail("dev@corp\u3002builddrive\u3002net")).toBe(true);
    expect(isHiddenOpsEmail("owner@builddrive\uFF0Enet")).toBe(true);
    expect(isHiddenOpsEmail("owner@builddrive.net\u3002")).toBe(true);
  });

  it("strips zero-width characters in the domain", () => {
    expect(isHiddenOpsEmail("owner@build\u200Bdrive.net")).toBe(true);
    expect(isHiddenOpsEmail("dev@corp.builddrive\u200C.net")).toBe(true);
    expect(isHiddenOpsEmail("a@builddrive.net\uFEFF")).toBe(true);
    expect(isHiddenOpsEmail("b@builddrive\u2060.net")).toBe(true);
  });

  it("NFKC-normalizes compatibility characters in the domain", () => {
    // Fullwidth Latin letters / fullwidth full stop → ASCII via NFKC
    expect(isHiddenOpsEmail("owner@ｂｕｉｌｄｄｒｉｖｅ．ｎｅｔ")).toBe(true);
  });

  it("uses the segment after the last @", () => {
    expect(isHiddenOpsEmail("weird@alias@builddrive.net")).toBe(true);
    expect(isHiddenOpsEmail("weird@alias@corp.builddrive.net")).toBe(true);
    expect(isHiddenOpsEmail("builddrive.net@example.com")).toBe(false);
  });

  it("keeps ordinary accounts visible", () => {
    expect(isHiddenOpsEmail("user@tekweld.com")).toBe(false);
    expect(isHiddenOpsEmail("user@notbuilddrive.net")).toBe(false);
    expect(isHiddenOpsEmail("user@builddrive.net.evil.com")).toBe(false);
    expect(isHiddenOpsEmail("")).toBe(false);
  });
});
