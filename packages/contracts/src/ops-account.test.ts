import { describe, expect, it } from "vitest";
import { OpsAccountSchema } from "./domain.js";

const base = {
  userId: "user_1",
  email: "user@example.test",
  name: "User",
  deactivated: false,
  modelProvider: null,
  modelId: null,
  totalTokens: null,
  totalCostUsd: null,
  sharedKeyCostUsd: 0,
  personalKeyCostUsd: 0,
  sharedKeyBudget: null,
};

describe("OpsAccountSchema keyType", () => {
  it("accepts company and personal", () => {
    expect(OpsAccountSchema.parse({ ...base, keyType: "company" }).keyType).toBe("company");
    expect(OpsAccountSchema.parse({ ...base, keyType: "personal" }).keyType).toBe("personal");
  });

  it("maps legacy none to company for one release", () => {
    expect(OpsAccountSchema.parse({ ...base, keyType: "none" }).keyType).toBe("company");
  });

  it("defaults needsReconnect to false", () => {
    expect(OpsAccountSchema.parse({ ...base, keyType: "company" }).needsReconnect).toBe(false);
  });
});
