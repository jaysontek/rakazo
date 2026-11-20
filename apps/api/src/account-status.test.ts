import type * as Db from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import type { AccountStatusDeps } from "./account-status.js";
import { endDeactivatedAccess, setAccountActive } from "./account-status.js";
import { revokeUserDevices } from "./user-devices.js";

vi.mock("@rakazo/db", async (original) => ({
  ...(await original<typeof Db>()),
  cancelDeactivatedAccountRuns: vi.fn(
    async (_prisma: unknown, events: { notify(threadId: string, seq: number): Promise<void> }) => {
      await events.notify("thread-1", 4);
      return 1;
    },
  ),
}));

describe("turning an account back on", () => {
  function depsFor(user: { deactivatedAt: Date | null; deletionRequestedAt: Date | null }) {
    const updateMany = vi.fn(async () => ({ count: 1 }));
    const deps = {
      prisma: {
        user: { findUnique: vi.fn(async () => user), updateMany },
        session: { deleteMany: vi.fn(async () => ({ count: 0 })) },
      },
    } as unknown as AccountStatusDeps;
    return { deps, updateMany };
  }

  it("refuses an account pending deletion and keeps it deactivated", async () => {
    const { deps, updateMany } = depsFor({
      deactivatedAt: new Date("2026-06-01T00:00:00.000Z"),
      deletionRequestedAt: new Date("2026-06-01T00:00:00.000Z"),
    });
    await expect(setAccountActive(deps, "user-1", true, false)).resolves.toBe("unchanged");
    expect(updateMany).not.toHaveBeenCalled();
  });

  it("puts the deactivation back if something cleared it while deletion is pending", async () => {
    const { deps, updateMany } = depsFor({
      deactivatedAt: null,
      deletionRequestedAt: new Date("2026-06-01T00:00:00.000Z"),
    });
    await expect(setAccountActive(deps, "user-1", true, false)).resolves.toBe("unchanged");
    expect(updateMany).toHaveBeenCalledExactlyOnceWith({
      where: { id: "user-1", deactivatedAt: null },
      data: { deactivatedAt: expect.any(Date) },
    });
  });

  it("only reactivates an account that is not pending deletion", async () => {
    const { deps, updateMany } = depsFor({
      deactivatedAt: new Date("2026-06-01T00:00:00.000Z"),
      deletionRequestedAt: null,
    });
    await expect(setAccountActive(deps, "user-1", true, false)).resolves.toBe("changed");
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: "user-1", deactivatedAt: { not: null }, deletionRequestedAt: null },
      data: { deactivatedAt: null },
    });
  });
});

describe("ending a deactivated account's access", () => {
  it("tries every step when one fails, then reports the failure", async () => {
    const calls: string[] = [];
    const step = (name: string, fail = false) =>
      vi.fn(async () => {
        calls.push(name);
        if (fail) throw new Error(`${name} failed`);
        return { count: 0 };
      });
    const deps = {
      prisma: {
        session: { deleteMany: step("sessions", true) },
        webPushSubscription: { deleteMany: step("web pushes") },
        callPushDevice: { deleteMany: step("call pushes") },
        messagingLinkCode: { deleteMany: step("link codes") },
        bot: { updateMany: step("screens") },
        userDevice: { findMany: vi.fn(async () => []) },
      },
      devices: { prisma: { userDevice: { findMany: vi.fn(async () => []) } }, devices: {} },
      pushTokens: { remove: step("pushes") },
      events: { notify: step("notify") },
    } as unknown as AccountStatusDeps;

    await expect(endDeactivatedAccess(deps, "user-1")).rejects.toThrow(AggregateError);
    expect(calls).toEqual([
      "sessions",
      "pushes",
      "web pushes",
      "call pushes",
      "link codes",
      "screens",
      "notify",
    ]);
  });

  it("deletes the account's web push subscriptions", async () => {
    const deleteWebPush = vi.fn(async () => ({ count: 2 }));
    const deps = {
      prisma: {
        session: { deleteMany: vi.fn(async () => ({ count: 0 })) },
        webPushSubscription: { deleteMany: deleteWebPush },
        callPushDevice: { deleteMany: vi.fn(async () => ({ count: 0 })) },
        messagingLinkCode: { deleteMany: vi.fn(async () => ({ count: 0 })) },
        bot: { updateMany: vi.fn(async () => ({ count: 0 })) },
        userDevice: { findMany: vi.fn(async () => []) },
      },
      devices: { prisma: { userDevice: { findMany: vi.fn(async () => []) } }, devices: {} },
      pushTokens: { remove: vi.fn(async () => undefined) },
      events: { notify: vi.fn(async () => undefined) },
    } as unknown as AccountStatusDeps;

    await endDeactivatedAccess(deps, "user-1");
    expect(deleteWebPush).toHaveBeenCalledWith({ where: { userId: "user-1" } });
  });

  it("disconnects the other computers when one fails", async () => {
    const disconnect = vi.fn(async () => undefined);
    const store = {
      prisma: {
        userDevice: {
          findMany: vi.fn(async () => [
            { id: "device-1", sessionId: null },
            { id: "device-2", sessionId: null },
          ]),
          updateMany: vi.fn(async ({ where }: { where: { id: string } }) => {
            if (where.id === "device-1") throw new Error("unavailable");
            return { count: 1 };
          }),
        },
      },
      devices: { disconnect },
    } as unknown as Parameters<typeof revokeUserDevices>[0];

    await expect(revokeUserDevices(store, "user-1")).rejects.toThrow(AggregateError);
    expect(disconnect).toHaveBeenCalledExactlyOnceWith("device-2", "session-ended");
  });
});
