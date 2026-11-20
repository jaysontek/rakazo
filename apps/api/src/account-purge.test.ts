import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { accountPurgeEnabled, accountPurgeReconciler, accountPurgeSweep } from "./account-purge.js";

vi.mock("./account-deletion.js", () => ({
  deleteAccountContent: vi.fn(async () => undefined),
}));

vi.mock("@rakazo/adapters", () => ({
  removePiUserSessions: vi.fn(async () => undefined),
}));

vi.mock("@rakazo/db", async () => {
  const actual = await vi.importActual<typeof import("@rakazo/db")>("@rakazo/db");
  return {
    ...actual,
    listAccountsDueForPurge: vi.fn(async () => [{ id: "u1", purgeAfter: new Date(0) }]),
    claimAccountForPurge: vi.fn(async () => new Date(1)),
    finalizeAccountPurge: vi.fn(async () => true),
    recordAuditEvent: vi.fn(async () => undefined),
    recordSecurityEvent: vi.fn(async () => undefined),
    runAsSystem: async (_label: string, work: () => Promise<unknown>) => work(),
  };
});

import { claimAccountForPurge, finalizeAccountPurge, listAccountsDueForPurge } from "@rakazo/db";
import { deleteAccountContent } from "./account-deletion.js";

describe("accountPurgeEnabled", () => {
  it("is false unless the env value is exactly true", () => {
    expect(accountPurgeEnabled(undefined)).toBe(false);
    expect(accountPurgeEnabled("")).toBe(false);
    expect(accountPurgeEnabled("false")).toBe(false);
    expect(accountPurgeEnabled("TRUE")).toBe(false);
    expect(accountPurgeEnabled("true")).toBe(true);
  });
});

describe("account purge model enumeration guard", () => {
  it("lists every Prisma model with a userId field or User relation as handled or retained", async () => {
    const { ACCOUNT_PURGE_HANDLED_USER_MODELS, ACCOUNT_PURGE_RETAINED_USER_MODELS } = await import(
      "./account-purge.js"
    );
    const schemaPath = fileURLToPath(
      new URL("../../../packages/db/prisma/schema.prisma", import.meta.url),
    );
    const schema = readFileSync(schemaPath, "utf8");
    const models = new Set<string>();
    for (const match of schema.matchAll(/model (\w+) \{([^}]*)\}/g)) {
      const [, name, body] = match;
      if (!name || !body) continue;
      const hasUserId = /^\s*userId\s+/m.test(body);
      const hasUserRel = /^\s*\w+\s+User(\[\])?\b/m.test(body);
      if (hasUserId || hasUserRel) models.add(name);
    }
    const handled = new Set<string>(ACCOUNT_PURGE_HANDLED_USER_MODELS);
    const retained = new Set(Object.keys(ACCOUNT_PURGE_RETAINED_USER_MODELS));
    const missing = [...models].filter((name) => !handled.has(name) && !retained.has(name)).sort();
    expect(missing, `Unhandled user-scoped models: ${missing.join(", ")}`).toEqual([]);
    for (const [name, reason] of Object.entries(ACCOUNT_PURGE_RETAINED_USER_MODELS)) {
      expect(reason.length, `${name} needs a retain reason`).toBeGreaterThan(0);
      expect(models.has(name), `${name} no longer has userId/User`).toBe(true);
    }
  });
});

describe("accountPurgeSweep", () => {
  function deps(failCountFor?: string) {
    const count = (userId?: string) => async () => {
      if (failCountFor && userId === failCountFor) throw new Error("count failed");
      return 0;
    };
    const model = () => ({
      count: vi.fn(async (args?: { where?: { userId?: string } }) => count(args?.where?.userId)()),
    });
    return {
      prisma: {
        session: model(),
        account: model(),
        passkey: model(),
        member: model(),
        bot: model(),
        spaceMember: model(),
        secret: model(),
        usageRecord: model(),
        sharedKeyBudgetMember: model(),
        pushToken: model(),
        webPushSubscription: model(),
        userDevice: model(),
        messagingIdentity: model(),
        artifact: { count: async () => 0 },
        computer: { count: async () => 0 },
      },
      sandbox: {} as never,
      home: {} as never,
      jobs: {} as never,
      artifacts: {} as never,
      dataDir: "/tmp",
      messagingInstallations: {} as never,
      secrets: undefined,
      pushTokens: { remove: vi.fn(async () => undefined) },
    };
  }

  const log = { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() };
  const run = (d: ReturnType<typeof deps>, enabled: boolean) =>
    accountPurgeSweep(d as never, { enabled })(new AbortController().signal);

  beforeEach(async () => {
    vi.mocked(deleteAccountContent).mockReset();
    vi.mocked(claimAccountForPurge).mockReset();
    vi.mocked(claimAccountForPurge).mockResolvedValue(new Date(1));
    vi.mocked(finalizeAccountPurge).mockReset();
    vi.mocked(finalizeAccountPurge).mockResolvedValue(true);
    vi.mocked(listAccountsDueForPurge).mockResolvedValue([{ id: "u1", purgeAfter: new Date(0) }]);
    for (const fn of Object.values(log)) fn.mockClear();
    vi.spyOn(await import("@rakazo/logging"), "getLogger").mockReturnValue(log as never);
  });

  it("dry-runs when the kill switch is off: logs and deletes nothing", async () => {
    await run(deps(), false);

    expect(listAccountsDueForPurge).toHaveBeenCalled();
    expect(claimAccountForPurge).not.toHaveBeenCalled();
    expect(deleteAccountContent).not.toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledWith(
      "account.purge.dry_run",
      expect.objectContaining({ "user.id": "u1", "purge.enabled": false }),
    );
    const bindings = log.info.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(JSON.stringify(bindings)).not.toMatch(/@|email|name/i);
  });

  it("keeps sweeping when one account cannot be counted", async () => {
    vi.mocked(listAccountsDueForPurge).mockResolvedValue([
      { id: "bad", purgeAfter: new Date(0) },
      { id: "u2", purgeAfter: new Date(0) },
    ]);
    await run(deps("bad"), false);
    expect(log.error).toHaveBeenCalledWith("account.purge.failed", expect.any(Error), {
      "user.id": "bad",
    });
    expect(log.info).toHaveBeenCalledWith(
      "account.purge.dry_run",
      expect.objectContaining({ "user.id": "u2" }),
    );
  });

  it("purges for real under the claim when the kill switch is on", async () => {
    const claimedAt = new Date(5);
    vi.mocked(claimAccountForPurge).mockResolvedValue(claimedAt);
    const d = deps();
    await run(d, true);

    expect(claimAccountForPurge).toHaveBeenCalledWith(expect.anything(), "u1");
    expect(deleteAccountContent).toHaveBeenCalledWith(expect.anything(), "u1");
    expect(finalizeAccountPurge).toHaveBeenCalledWith(expect.anything(), "u1", claimedAt);
    expect(d.pushTokens.remove).toHaveBeenCalledWith("u1");
    expect(log.info).toHaveBeenCalledWith("account.purge.completed", { "user.id": "u1" });
  });

  it("skips a fresh claim held by a crashed worker, then resumes once it is taken over", async () => {
    vi.mocked(claimAccountForPurge).mockResolvedValueOnce(null);
    await run(deps(), true);
    expect(deleteAccountContent).not.toHaveBeenCalled();

    const takenOver = new Date(10);
    vi.mocked(claimAccountForPurge).mockResolvedValueOnce(takenOver);
    await run(deps(), true);
    expect(deleteAccountContent).toHaveBeenCalledTimes(1);
    expect(finalizeAccountPurge).toHaveBeenCalledWith(expect.anything(), "u1", takenOver);
  });

  it("retries an account whose finalize failed on a later sweep", async () => {
    vi.mocked(finalizeAccountPurge).mockRejectedValueOnce(new Error("db down"));
    const d = deps();
    await run(d, true);
    expect(log.error).toHaveBeenCalledWith("account.purge.failed", expect.any(Error), {
      "user.id": "u1",
    });
    expect(d.pushTokens.remove).not.toHaveBeenCalled();

    await run(d, true);
    expect(deleteAccountContent).toHaveBeenCalledTimes(2);
    expect(finalizeAccountPurge).toHaveBeenCalledTimes(2);
    expect(d.pushTokens.remove).toHaveBeenCalledWith("u1");
  });

  it("does not finish when a restore or takeover won before finalize", async () => {
    vi.mocked(finalizeAccountPurge).mockResolvedValue(false);
    const d = deps();
    await run(d, true);
    expect(d.pushTokens.remove).not.toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledWith("account.purge.aborted", {
      "user.id": "u1",
      reason: "no_longer_claimed",
    });
  });
});

describe("accountPurgeReconciler", () => {
  it("starts at most one sweep per interval without waiting for it", async () => {
    let release: () => void = () => undefined;
    vi.mocked(listAccountsDueForPurge).mockReset();
    vi.mocked(listAccountsDueForPurge).mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => resolve([]);
        }),
    );
    let clock = 0;
    const reconcile = accountPurgeReconciler({ prisma: {} } as never, {
      enabled: false,
      signal: new AbortController().signal,
      intervalMs: 1000,
      now: () => clock,
    });
    // Returns while the sweep is still waiting on the database.
    await reconcile();
    expect(listAccountsDueForPurge).toHaveBeenCalledTimes(1);
    clock = 5000;
    await reconcile();
    expect(listAccountsDueForPurge).toHaveBeenCalledTimes(1);

    release();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await reconcile();
    expect(listAccountsDueForPurge).toHaveBeenCalledTimes(2);

    release();
    await new Promise((resolve) => setTimeout(resolve, 0));
    clock = 5500;
    await reconcile();
    expect(listAccountsDueForPurge).toHaveBeenCalledTimes(2);
  });
});
