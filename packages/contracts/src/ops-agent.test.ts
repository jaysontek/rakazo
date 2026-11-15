import { describe, expect, it } from "vitest";
import { OpsAgentSchema } from "./domain.js";

const base = {
  id: "bot_1",
  name: "Helper",
  createdAt: "2026-01-01T00:00:00.000Z",
  lastActiveAt: null,
  status: "active" as const,
  owner: {
    id: "user_1",
    name: "User",
    email: "user@example.test",
    deactivated: false,
  },
};

describe("OpsAgentSchema", () => {
  it("accepts owner rows and orphan rows", () => {
    expect(OpsAgentSchema.parse({ ...base, keyType: "company" }).owner?.id).toBe("user_1");
    expect(OpsAgentSchema.parse({ ...base, owner: null, keyType: "company" }).owner).toBeNull();
  });

  it("maps legacy none keyType to company", () => {
    expect(OpsAgentSchema.parse({ ...base, keyType: "none" }).keyType).toBe("company");
  });

  it("defaults needsReconnect to false", () => {
    expect(OpsAgentSchema.parse({ ...base, keyType: "personal" }).needsReconnect).toBe(false);
  });
});
