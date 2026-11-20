import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  ACCOUNT_PURGE_HANDLED_USER_RELATIONS,
  accountPurgeEnabled,
  accountPurgeSweep,
} from "./account-purge.js";

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
    claimAccountForPurge: vi.fn(async () => true),
    assertStillClaimedForPurge: vi.fn(async () => true),
    personalOrganizationIds: vi.fn(async () => []),
    recordAuditEvent: vi.fn(async () => undefined),
    recordSecurityEvent: vi.fn(async () => undefined),
    runAsSystem: async (_label: string, work: () => Promise<unknown>) => work(),
  };
});

import {
  assertStillClaimedForPurge,
  claimAccountForPurge,
  listAccountsDueForPurge,
} from "@rakazo/db";
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
  it("lists every Prisma model with a User relation", () => {
    const schemaPath = fileURLToPath(
      new URL("../../../packages/db/prisma/schema.prisma", import.meta.url),
    );
    const schema = readFileSync(schemaPath, "utf8");
    const userBlock = schema.match(/model User \{([\s\S]*?)\n\}/);
    expect(userBlock).toBeTruthy();
    const relationModels = new Set<string>();
    for (const line of userBlock![1]!.split("\n")) {
      const match = /^\s*(\w+)\s+(\w+)(\[\])?/.exec(line);
      if (!match) continue;
      const [, , type, isList] = match;
      if (
        !type ||
        ["String", "Boolean", "DateTime", "Int", "Float", "BigInt", "Bytes", "Json"].includes(type)
      ) {
        continue;
      }
      // Skip the self-relation field names; User is already in the handled list.
      if (type === "User" && !isList) continue;
      relationModels.add(type);
    }
    const missing = [...relationModels].filter(
      (name) =>
        !ACCOUNT_PURGE_HANDLED_USER_RELATIONS.includes(
          name as (typeof ACCOUNT_PURGE_HANDLED_USER_RELATIONS)[number],
        ),
    );
    expect(missing, `Unhandled User relations: ${missing.join(", ")}`).toEqual([]);
  });
});

describe("accountPurgeSweep", () => {
  function deps() {
    const counts = {
      session: 1,
      account: 0,
      passkey: 0,
      member: 0,
      bot: 0,
      spaceMember: 0,
      secret: 0,
      usageRecord: 0,
      sharedKeyBudgetMember: 0,
      pushToken: 0,
      webPushSubscription: 0,
      userDevice: 0,
      messagingIdentity: 0,
    };
    return {
      prisma: {
        session: {
          count: async () => counts.session,
          deleteMany: vi.fn(async () => ({ count: 0 })),
        },
        account: { count: async () => counts.account },
        passkey: {
          count: async () => counts.passkey,
          deleteMany: vi.fn(async () => ({ count: 0 })),
        },
        member: { count: async () => counts.member },
        bot: { count: async () => counts.bot },
        spaceMember: { count: async () => counts.spaceMember },
        secret: { count: async () => counts.secret },
        usageRecord: { count: async () => counts.usageRecord },
        sharedKeyBudgetMember: { count: async () => counts.sharedKeyBudgetMember },
        pushToken: { count: async () => counts.pushToken },
        webPushSubscription: { count: async () => counts.webPushSubscription },
        userDevice: { count: async () => counts.userDevice },
        messagingIdentity: {
          count: async () => counts.messagingIdentity,
          deleteMany: vi.fn(async () => ({ count: 0 })),
        },
        artifact: { count: async () => 0 },
        computer: { count: async () => 0 },
        organization: { deleteMany: vi.fn(async () => ({ count: 0 })) },
        user: {
          findUnique: vi.fn(async () => ({
            deletionRequestedAt: new Date(0),
            purgeAfter: new Date(0),
            purgeClaimedAt: new Date(),
          })),
          deleteMany: vi.fn(async () => ({ count: 1 })),
        },
        $transaction: vi.fn(async (work: (tx: unknown) => Promise<unknown>) =>
          work({
            $queryRaw: vi.fn(async () => []),
            user: {
              findUnique: vi.fn(async () => ({
                deletionRequestedAt: new Date(0),
                purgeAfter: new Date(0),
                purgeClaimedAt: new Date(),
              })),
              deleteMany: vi.fn(async () => ({ count: 1 })),
            },
            messagingIdentity: { deleteMany: vi.fn(async () => ({ count: 0 })) },
            passkey: { deleteMany: vi.fn(async () => ({ count: 0 })) },
            session: { deleteMany: vi.fn(async () => ({ count: 0 })) },
            organization: { deleteMany: vi.fn(async () => ({ count: 0 })) },
          }),
        ),
        $queryRaw: vi.fn(async () => []),
      },
      sandbox: {} as never,
      home: {} as never,
      jobs: {} as never,
      artifacts: {} as never,
      dataDir: "/tmp",
      messagingInstallations: {} as never,
      secrets: undefined,
    };
  }

  it("dry-runs when the kill switch is off: logs and deletes nothing", async () => {
    vi.mocked(deleteAccountContent).mockClear();
    vi.mocked(claimAccountForPurge).mockClear();
    const info = vi.fn();
    vi.spyOn(await import("@rakazo/logging"), "getLogger").mockReturnValue({
      info,
      error: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
    } as never);

    await accountPurgeSweep(deps() as never, { enabled: false })(new AbortController().signal);

    expect(listAccountsDueForPurge).toHaveBeenCalled();
    expect(claimAccountForPurge).not.toHaveBeenCalled();
    expect(deleteAccountContent).not.toHaveBeenCalled();
    expect(info).toHaveBeenCalledWith(
      "account.purge.dry_run",
      expect.objectContaining({
        "user.id": "u1",
        "purge.enabled": false,
      }),
    );
    const bindings = info.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(JSON.stringify(bindings)).not.toMatch(/@|email|name/i);
  });

  it("purges for real when the kill switch is on", async () => {
    vi.mocked(deleteAccountContent).mockClear();
    vi.mocked(claimAccountForPurge).mockResolvedValue(true);
    vi.mocked(assertStillClaimedForPurge).mockResolvedValue(true);
    vi.spyOn(await import("@rakazo/logging"), "getLogger").mockReturnValue({
      info: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
    } as never);

    await accountPurgeSweep(deps() as never, { enabled: true })(new AbortController().signal);

    expect(claimAccountForPurge).toHaveBeenCalledWith(expect.anything(), "u1");
    expect(deleteAccountContent).toHaveBeenCalledWith(expect.anything(), "u1");
    expect(assertStillClaimedForPurge).toHaveBeenCalledWith(expect.anything(), "u1");
  });
});
