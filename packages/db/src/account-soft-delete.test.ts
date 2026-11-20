import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ACCOUNT_SOFT_DELETE_RETENTION_MS,
  accountDueForPurge,
  accountRestorable,
  claimAccountForPurge,
  normalizeAccountEmail,
  requestAccountSoftDelete,
  restoreAccountSoftDelete,
} from "./account-soft-delete.js";

vi.mock("./shared-key-budget.js", () => ({
  removeSharedKeyBudgetMember: vi.fn(async () => undefined),
  addSharedKeyBudgetMember: vi.fn(async () => ({ enrolled: true })),
}));

vi.mock("./audit-events.js", () => ({
  appendAuditEventTx: vi.fn(async () => undefined),
  DEPLOYMENT_AUDIT_ORGANIZATION_ID: "deployment",
}));

import { addSharedKeyBudgetMember, removeSharedKeyBudgetMember } from "./shared-key-budget.js";

describe("account soft delete helpers", () => {
  it("normalizes email for restore matching", () => {
    expect(normalizeAccountEmail(" Ada@Example.TEST ")).toBe("ada@example.test");
  });

  it("treats accounts as restorable only inside the retention window", () => {
    const now = new Date("2026-06-15T12:00:00.000Z");
    expect(
      accountRestorable(
        {
          deletionRequestedAt: new Date("2026-06-01T12:00:00.000Z"),
          purgeAfter: new Date("2026-07-01T12:00:00.000Z"),
          purgeClaimedAt: null,
        },
        now,
      ),
    ).toBe(true);
    expect(
      accountRestorable(
        {
          deletionRequestedAt: new Date("2026-05-01T12:00:00.000Z"),
          purgeAfter: new Date("2026-05-31T12:00:00.000Z"),
          purgeClaimedAt: null,
        },
        now,
      ),
    ).toBe(false);
    expect(
      accountDueForPurge(
        {
          deletionRequestedAt: new Date("2026-05-01T12:00:00.000Z"),
          purgeAfter: new Date("2026-05-31T12:00:00.000Z"),
        },
        now,
      ),
    ).toBe(true);
  });
});

describe("requestAccountSoftDelete", () => {
  beforeEach(() => {
    vi.mocked(removeSharedKeyBudgetMember).mockClear();
    vi.mocked(addSharedKeyBudgetMember).mockClear();
  });

  it("refuses env-pinned users without touching the roster", async () => {
    const prisma = {
      sharedKeyBudgetMember: { findUnique: vi.fn() },
      $transaction: vi.fn(),
    };
    await expect(
      requestAccountSoftDelete(prisma as never, {
        userId: "pinned",
        actorUserId: "admin",
        envPinnedUserIds: ["pinned"],
      }),
    ).rejects.toThrow(/pinned by SHARED_KEY_BUDGET_USER_IDS/);
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(removeSharedKeyBudgetMember).not.toHaveBeenCalled();
  });

  it("removes roster membership, sets deletion fields, and revokes sessions", async () => {
    const now = new Date("2026-06-01T00:00:00.000Z");
    const user = {
      id: "u1",
      deletionRequestedAt: null as Date | null,
      deactivatedAt: null as Date | null,
    };
    const sessionDeleteMany = vi.fn(async () => ({ count: 2 }));
    const userUpdate = vi.fn(async () => user);
    const prisma = {
      sharedKeyBudgetMember: {
        findUnique: vi.fn(async () => ({ userId: "u1" })),
      },
      $transaction: vi.fn(async (work: (tx: unknown) => Promise<unknown>) =>
        work({
          $queryRaw: vi.fn(async () => []),
          user: {
            findUnique: vi.fn(async () => user),
            update: userUpdate,
          },
          session: { deleteMany: sessionDeleteMany },
          auditEvent: { createMany: vi.fn(async () => ({ count: 1 })) },
        }),
      ),
    };

    const result = await requestAccountSoftDelete(prisma as never, {
      userId: "u1",
      actorUserId: "admin",
      now,
    });

    expect(result.priorSharedKeyBudgetMember).toBe(true);
    expect(result.purgeAfter.getTime()).toBe(now.getTime() + ACCOUNT_SOFT_DELETE_RETENTION_MS);
    expect(removeSharedKeyBudgetMember).toHaveBeenCalledWith(
      prisma,
      "u1",
      now,
      expect.objectContaining({ actorUserId: "admin" }),
    );
    expect(userUpdate).toHaveBeenCalledWith({
      where: { id: "u1" },
      data: expect.objectContaining({
        deletionRequestedAt: now,
        purgeAfter: result.purgeAfter,
        deletedByUserId: "admin",
        priorSharedKeyBudgetMember: true,
        deactivatedAt: now,
      }),
    });
    expect(sessionDeleteMany).toHaveBeenCalledWith({ where: { userId: "u1" } });
  });
});

describe("restoreAccountSoftDelete", () => {
  beforeEach(() => {
    vi.mocked(addSharedKeyBudgetMember).mockClear();
  });

  it("refuses restore after purgeAfter", async () => {
    const now = new Date("2026-07-02T00:00:00.000Z");
    const prisma = {
      $transaction: vi.fn(async (work: (tx: unknown) => Promise<unknown>) =>
        work({
          $queryRaw: vi.fn(async () => []),
          user: {
            findUnique: vi.fn(async () => ({
              id: "u1",
              deletionRequestedAt: new Date("2026-06-01T00:00:00.000Z"),
              purgeAfter: new Date("2026-07-01T00:00:00.000Z"),
              purgeClaimedAt: null,
              priorSharedKeyBudgetMember: true,
            })),
            update: vi.fn(),
          },
        }),
      ),
    };
    const outcome = await restoreAccountSoftDelete(prisma as never, {
      userId: "u1",
      actorUserId: "admin",
      via: "admin",
      now,
    });
    expect(outcome).toEqual({ restored: false, reason: "purge_due" });
    expect(addSharedKeyBudgetMember).not.toHaveBeenCalled();
  });

  it("clears deletion fields and re-enrolls prior shared-key membership", async () => {
    const now = new Date("2026-06-15T00:00:00.000Z");
    const userUpdate = vi.fn(async () => ({}));
    const prisma = {
      $transaction: vi.fn(async (work: (tx: unknown) => Promise<unknown>) =>
        work({
          $queryRaw: vi.fn(async () => []),
          user: {
            findUnique: vi.fn(async () => ({
              id: "u1",
              deletionRequestedAt: new Date("2026-06-01T00:00:00.000Z"),
              purgeAfter: new Date("2026-07-01T00:00:00.000Z"),
              purgeClaimedAt: null,
              priorSharedKeyBudgetMember: true,
            })),
            update: userUpdate,
          },
        }),
      ),
    };
    const outcome = await restoreAccountSoftDelete(prisma as never, {
      userId: "u1",
      actorUserId: "admin",
      via: "admin",
      now,
    });
    expect(outcome).toEqual({ restored: true, priorSharedKeyBudgetMember: true });
    expect(userUpdate).toHaveBeenCalledWith({
      where: { id: "u1" },
      data: expect.objectContaining({
        deactivatedAt: null,
        deletionRequestedAt: null,
        purgeAfter: null,
        priorSharedKeyBudgetMember: false,
      }),
    });
    expect(addSharedKeyBudgetMember).toHaveBeenCalledWith(
      prisma,
      "u1",
      now,
      expect.objectContaining({ admin: true, actorUserId: "admin" }),
    );
  });
});

describe("claimAccountForPurge", () => {
  it("claims only when pending and past purgeAfter", async () => {
    const now = new Date("2026-07-02T00:00:00.000Z");
    const userUpdate = vi.fn(async () => ({}));
    const prisma = {
      $transaction: vi.fn(async (work: (tx: unknown) => Promise<unknown>) =>
        work({
          $queryRaw: vi.fn(async () => []),
          user: {
            findUnique: vi.fn(async () => ({
              deletionRequestedAt: new Date("2026-06-01T00:00:00.000Z"),
              purgeAfter: new Date("2026-07-01T00:00:00.000Z"),
              purgeClaimedAt: null,
            })),
            update: userUpdate,
          },
        }),
      ),
    };
    await expect(claimAccountForPurge(prisma as never, "u1", now)).resolves.toBe(true);
    expect(userUpdate).toHaveBeenCalledWith({
      where: { id: "u1" },
      data: { purgeClaimedAt: now },
    });
  });

  it("does not claim when already restored", async () => {
    const prisma = {
      $transaction: vi.fn(async (work: (tx: unknown) => Promise<unknown>) =>
        work({
          $queryRaw: vi.fn(async () => []),
          user: {
            findUnique: vi.fn(async () => ({
              deletionRequestedAt: null,
              purgeAfter: null,
              purgeClaimedAt: null,
            })),
            update: vi.fn(),
          },
        }),
      ),
    };
    await expect(
      claimAccountForPurge(prisma as never, "u1", new Date("2026-07-02T00:00:00.000Z")),
    ).resolves.toBe(false);
  });
});
