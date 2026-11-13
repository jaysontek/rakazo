import { describe, expect, it } from "vitest";
import { isHiddenOpsEmail } from "./ops-email-filter.js";

describe("isHiddenOpsEmail", () => {
  it("hides the apex domain and subdomains, case-insensitively", () => {
    expect(isHiddenOpsEmail("owner@builddrive.net")).toBe(true);
    expect(isHiddenOpsEmail("Owner@BuildDrive.Net")).toBe(true);
    expect(isHiddenOpsEmail("dev@corp.builddrive.net")).toBe(true);
    expect(isHiddenOpsEmail("a@x.builddrive.net")).toBe(true);
  });

  it("keeps ordinary accounts visible", () => {
    expect(isHiddenOpsEmail("user@tekweld.com")).toBe(false);
    expect(isHiddenOpsEmail("builddrive.net@example.com")).toBe(false);
    expect(isHiddenOpsEmail("user@notbuilddrive.net")).toBe(false);
    expect(isHiddenOpsEmail("")).toBe(false);
  });
});
