import { beforeEach, describe, expect, it, vi } from "vitest";
import { listCompanyKeyUserIds, syncSharedKeyBudgetFromKeys } from "./shared-key-budget-sync.js";

vi.mock("@rakazo/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@rakazo/db")>();
  return {
    ...actual,
    syncSharedKeyBudgetMembers: vi.fn(actual.syncSharedKeyBudgetMembers),
  };
});

vi.mock("./model-key-type.js", () => ({
  classifyGoogleModelKeyType: vi.fn(),
}));

import { syncSharedKeyBudgetMembers } from "@rakazo/db";
import { classifyGoogleModelKeyType } from "./model-key-type.js";

describe("shared-key budget auto-enroll", () => {
  beforeEach(() => {
    vi.mocked(classifyGoogleModelKeyType).mockReset();
    vi.mocked(syncSharedKeyBudgetMembers).mockClear();
  });

  it("treats env deployment key users (no stored credential) as company", async () => {
    vi.mocked(classifyGoogleModelKeyType).mockImplementation(
      async (_prisma, _secrets, userId, deploymentKey) => {
        if (!deploymentKey) return "none";
        if (userId === "env-user") return "company";
        return "personal";
      },
    );
    const prisma = {
      user: { findMany: vi.fn(async () => [{ id: "env-user" }, { id: "other" }]) },
      userModelCredential: { findFirst: vi.fn() },
      secret: { findFirst: vi.fn() },
    };
    await expect(
      listCompanyKeyUserIds(prisma as never, { load: vi.fn() }, "shared-key"),
    ).resolves.toEqual(["env-user"]);
  });

  it("includes stored keys that match the deployment shared key", async () => {
    vi.mocked(classifyGoogleModelKeyType).mockResolvedValueOnce("company");
    const prisma = {
      user: { findMany: vi.fn(async () => [{ id: "stored-match" }]) },
      userModelCredential: { findFirst: vi.fn() },
      secret: { findFirst: vi.fn() },
    };
    await expect(
      listCompanyKeyUserIds(prisma as never, { load: vi.fn() }, "shared-key"),
    ).resolves.toEqual(["stored-match"]);
    expect(classifyGoogleModelKeyType).toHaveBeenCalledWith(
      prisma,
      expect.anything(),
      "stored-match",
      "shared-key",
    );
  });

  it("excludes non-matching personal keys from company enrollment", async () => {
    vi.mocked(classifyGoogleModelKeyType).mockResolvedValue("personal");
    const prisma = {
      user: { findMany: vi.fn(async () => [{ id: "personal" }]) },
      userModelCredential: { findFirst: vi.fn() },
      secret: { findFirst: vi.fn() },
    };
    await expect(
      listCompanyKeyUserIds(prisma as never, { load: vi.fn() }, "shared-key"),
    ).resolves.toEqual([]);
  });

  it("unions company-key users with explicit env-list includes", async () => {
    vi.mocked(classifyGoogleModelKeyType).mockImplementation(async (_p, _s, userId) =>
      userId === "company" ? "company" : "personal",
    );
    const members: Array<{ userId: string }> = [];
    const prisma = {
      user: {
        findMany: vi.fn(async ({ where }: { where?: { id: { in: string[] } } } = {}) => {
          if (where?.id?.in) {
            return where.id.in.map((id) => ({ id }));
          }
          return [{ id: "company" }, { id: "personal" }, { id: "explicit" }];
        }),
      },
      userModelCredential: { findFirst: vi.fn() },
      secret: { findFirst: vi.fn() },
      sharedKeyBudgetMember: {
        findMany: vi.fn(async () => members),
        create: vi.fn(async ({ data }: { data: { userId: string } }) => {
          members.push({ userId: data.userId });
        }),
        delete: vi.fn(async ({ where }: { where: { userId: string } }) => {
          const index = members.findIndex((row) => row.userId === where.userId);
          if (index >= 0) members.splice(index, 1);
        }),
      },
      deploymentSettings: { findUnique: vi.fn(async () => null) },
      sharedKeyWeekAllotment: {
        findMany: vi.fn(async () => []),
        deleteMany: vi.fn(async () => ({ count: 0 })),
        upsert: vi.fn(),
        updateMany: vi.fn(async () => ({ count: 0 })),
      },
      sharedKeyAllotmentTransfer: { findMany: vi.fn(async () => []) },
      usageRecord: { groupBy: vi.fn(async () => []) },
      $queryRaw: vi.fn(async () => []),
      $transaction: async (fn: (tx: unknown) => unknown) => fn(prisma),
    };

    const result = await syncSharedKeyBudgetFromKeys(prisma as never, { load: vi.fn() }, {
      explicitUserIds: ["explicit"],
      deploymentSharedKey: "shared-key",
    });
    expect(result.companyUserIds).toEqual(["company"]);
    expect(result.memberIds.sort()).toEqual(["company", "explicit"]);
    expect(syncSharedKeyBudgetMembers).toHaveBeenCalledWith(
      prisma,
      { explicitUserIds: ["explicit"], companyUserIds: ["company"] },
      expect.any(Date),
    );
  });
});
