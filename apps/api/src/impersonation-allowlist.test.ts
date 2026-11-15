import {
  IMPERSONATION_ALLOWED_OPS,
  IMPERSONATION_PROCEDURE_KIND,
} from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import { isImpersonationAllowedProcedure } from "./impersonation-allowlist.js";

describe("isImpersonationAllowedProcedure", () => {
  it("allows me, health, bootstrap, spendingLimit.get, stop, and switch", () => {
    expect(isImpersonationAllowedProcedure(["me"])).toBe(true);
    expect(isImpersonationAllowedProcedure(["health"])).toBe(true);
    expect(isImpersonationAllowedProcedure(["bootstrap"])).toBe(true);
    expect(isImpersonationAllowedProcedure(["spendingLimit", "get"])).toBe(true);
    expect(isImpersonationAllowedProcedure(["ops", "stopImpersonation"])).toBe(true);
    expect(isImpersonationAllowedProcedure(["ops", "switchImpersonation"])).toBe(true);
  });

  it("allows every classified read and only the stop/switch ops exceptions", () => {
    const allowedOps = new Set<string>(IMPERSONATION_ALLOWED_OPS);
    for (const [path, kind] of Object.entries(IMPERSONATION_PROCEDURE_KIND)) {
      const segments = path.split(".");
      if (kind === "read" || allowedOps.has(path)) {
        expect(isImpersonationAllowedProcedure(segments), path).toBe(true);
      } else {
        expect(isImpersonationAllowedProcedure(segments), path).toBe(false);
      }
    }
  });

  it("allows a sample of read procedures that exist on the contract", () => {
    expect(isImpersonationAllowedProcedure(["usage", "list"])).toBe(true);
    expect(isImpersonationAllowedProcedure(["usage", "summary"])).toBe(true);
    expect(isImpersonationAllowedProcedure(["bots", "list"])).toBe(true);
    expect(isImpersonationAllowedProcedure(["groups", "list"])).toBe(true);
    expect(isImpersonationAllowedProcedure(["threads", "messages"])).toBe(true);
    expect(isImpersonationAllowedProcedure(["accessGrants", "list"])).toBe(true);
    expect(isImpersonationAllowedProcedure(["boards", "list"])).toBe(true);
    expect(isImpersonationAllowedProcedure(["boards", "get"])).toBe(true);
    expect(isImpersonationAllowedProcedure(["boards", "subscribe"])).toBe(true);
    expect(isImpersonationAllowedProcedure(["tickets", "list"])).toBe(true);
    expect(isImpersonationAllowedProcedure(["tickets", "get"])).toBe(true);
    expect(isImpersonationAllowedProcedure(["tickets", "comments"])).toBe(true);
  });

  it("denies board and ticket mutations", () => {
    for (const path of [
      ["boards", "rename"],
      ["tickets", "create"],
      ["tickets", "update"],
      ["tickets", "move"],
      ["tickets", "comment"],
    ] as const) {
      expect(isImpersonationAllowedProcedure(path)).toBe(false);
    }
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

  it("denies sensitive mutations and ops reads by default", () => {
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
      ["ops", "team"],
      ["ops", "organizations"],
      ["ops", "overview"],
      ["preferences", "update"],
    ] as const) {
      expect(isImpersonationAllowedProcedure(path)).toBe(false);
    }
  });
});
