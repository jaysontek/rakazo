import { describe, expect, it } from "vitest";
import { isImpersonationAllowedProcedure } from "./impersonation-allowlist.js";

describe("isImpersonationAllowedProcedure", () => {
  it("allows me, health, and stopImpersonation", () => {
    expect(isImpersonationAllowedProcedure(["me"])).toBe(true);
    expect(isImpersonationAllowedProcedure(["health"])).toBe(true);
    expect(isImpersonationAllowedProcedure(["ops", "stopImpersonation"])).toBe(true);
  });

  it("allows a sample of read procedures that exist on the contract", () => {
    expect(isImpersonationAllowedProcedure(["usage", "list"])).toBe(true);
    expect(isImpersonationAllowedProcedure(["bots", "list"])).toBe(true);
    expect(isImpersonationAllowedProcedure(["threads", "messages"])).toBe(true);
    expect(isImpersonationAllowedProcedure(["accessGrants", "list"])).toBe(true);
  });

  it("does not allow pruned non-contract paths", () => {
    expect(isImpersonationAllowedProcedure(["spaces", "get"])).toBe(false);
    expect(isImpersonationAllowedProcedure(["organizations", "get"])).toBe(false);
    expect(isImpersonationAllowedProcedure(["threads", "list"])).toBe(false);
    expect(isImpersonationAllowedProcedure(["threads", "presence"])).toBe(false);
    expect(isImpersonationAllowedProcedure(["computer", "screen"])).toBe(false);
    expect(isImpersonationAllowedProcedure(["memory", "status"])).toBe(false);
    expect(isImpersonationAllowedProcedure(["models", "status"])).toBe(false);
  });

  it("denies sensitive mutations by default", () => {
    for (const path of [
      ["models", "connect"],
      ["models", "disconnect"],
      ["vault", "put"],
      ["vault", "remove"],
      ["agentSecrets", "put"],
      ["botSecrets", "put"],
      ["paymentWallet", "connect"],
      ["billing", "checkout"],
      ["spendingLimit", "set"],
      ["deployment", "update"],
      ["bots", "rotateWebhookSecret"],
      ["voice", "connect"],
      ["memory", "connectProvider"],
      ["connections", "revoke"],
      ["notifications", "register"],
      ["ops", "startImpersonation"],
      ["ops", "addAdminGrant"],
      ["preferences", "update"],
    ] as const) {
      expect(isImpersonationAllowedProcedure(path)).toBe(false);
    }
  });
});
