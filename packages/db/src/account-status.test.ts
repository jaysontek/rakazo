import { describe, expect, it, vi } from "vitest";
import { accountDeactivated } from "./account-status.js";

function db(user: { deactivatedAt: Date | null; deletionRequestedAt: Date | null } | null) {
  return { user: { findUnique: vi.fn(async () => user) } } as never;
}

describe("accountDeactivated", () => {
  it("counts an account pending deletion as off even if deactivatedAt was cleared", async () => {
    await expect(
      accountDeactivated(db({ deactivatedAt: null, deletionRequestedAt: new Date() }), "u1"),
    ).resolves.toBe(true);
  });

  it("counts a deactivated account as off", async () => {
    await expect(
      accountDeactivated(db({ deactivatedAt: new Date(), deletionRequestedAt: null }), "u1"),
    ).resolves.toBe(true);
  });

  it("counts an active or missing account as on", async () => {
    await expect(
      accountDeactivated(db({ deactivatedAt: null, deletionRequestedAt: null }), "u1"),
    ).resolves.toBe(false);
    await expect(accountDeactivated(db(null), "u1")).resolves.toBe(false);
  });
});
