import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ACCOUNT_PURGE_CLAIM_TIMEOUT_MS,
  ACCOUNT_SOFT_DELETE_RETENTION_MS,
  accountDueForPurge,
  accountRestorable,
  claimAccountForPurge,
  finalizeAccountPurge,
  findSoftDeletedUserByEmail,
  listAccountsDueForPurge,
  normalizeAccountEmail,
  requestAccountSoftDelete,
  restoreAccountSoftDelete,
  retryRestoredAccountBudgetReenroll,
} from "./account-soft-delete.js";

vi.mock("./shared-key-budget.js", () => ({
  SHARED_KEY_BUDGET_MEMBERS_LOCK: "members",
  lockSharedKeyBudget: vi.fn(async () => undefined),
  removeSharedKeyBudgetMemberTx: vi.fn(async () => true),
  addSharedKeyBudgetMemberTx: vi.fn(async () => ({ enrolled: true })),
}));

vi.mock("./audit-events.js", () => ({
  appendAuditEventTx: vi.fn(async () => undefined),
  DEPLOYMENT_AUDIT_ORGANIZATION_ID: "deployment",
}));

vi.mock("./spaces.js", () => ({
  personalOrganizationIds: vi.fn(async () => ["org-personal"]),
}));

import { appendAuditEventTx } from "./audit-events.js";
import {
  addSharedKeyBudgetMemberTx,
  lockSharedKeyBudget,
  removeSharedKeyBudgetMemberTx,
} from "./shared-key-budget.js";
import { personalOrganizationIds } from "./spaces.js";

type FakeUser = Record<string, unknown> | null;

/** One transaction client whose user row is `user`; extra models override defaults. */
function fakeTx(user: FakeUser, extra: Record<string, unknown> = {}) {
  const tx = {
    $queryRaw: vi.fn(async () => []),
    user: {
      findUnique: vi.fn(async () => user),
      update: vi.fn(async () => ({})),
      deleteMany: vi.fn(async () => ({ count: 1 })),
    },
    session: { deleteMany: vi.fn(async () => ({ count: 0 })) },
    sharedKeyBudgetMember: { findUnique: vi.fn(async () => null) },
    scimUser: { findMany: vi.fn(async () => []) },
    scimIdentityTombstone: { count: vi.fn(async () => 0) },
    messagingIdentity: { deleteMany: vi.fn(async () => ({ count: 0 })) },
    messagingLinkCode: { deleteMany: vi.fn(async () => ({ count: 0 })) },
    passkey: { deleteMany: vi.fn(async () => ({ count: 0 })) },
    organization: { deleteMany: vi.fn(async () => ({ count: 0 })) },
    ...extra,
  };
  const prisma = {
    $transaction: vi.fn(async (work: (client: typeof tx) => Promise<unknown>) => work(tx)),
  };
  return { tx, prisma };
}

beforeEach(() => {
  vi.mocked(lockSharedKeyBudget).mockClear();
  vi.mocked(removeSharedKeyBudgetMemberTx).mockClear();
  vi.mocked(addSharedKeyBudgetMemberTx).mockReset();
  vi.mocked(addSharedKeyBudgetMemberTx).mockResolvedValue({ enrolled: true });
  vi.mocked(appendAuditEventTx).mockClear();
  vi.mocked(personalOrganizationIds).mockClear();
});

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

  it("blocks restore while a purge claim is fresh, not once it is stale", () => {
    const now = new Date("2026-06-15T12:00:00.000Z");
    const pending = {
      deletionRequestedAt: new Date("2026-06-01T12:00:00.000Z"),
      purgeAfter: new Date("2026-07-01T12:00:00.000Z"),
    };
    expect(
      accountRestorable({ ...pending, purgeClaimedAt: new Date(now.getTime() - 60_000) }, now),
    ).toBe(false);
    expect(
      accountRestorable(
        {
          ...pending,
          purgeClaimedAt: new Date(now.getTime() - ACCOUNT_PURGE_CLAIM_TIMEOUT_MS - 1),
        },
        now,
      ),
    ).toBe(true);
  });
});

describe("requestAccountSoftDelete", () => {
  it("refuses env-pinned users without touching the roster", async () => {
    const { prisma } = fakeTx(null);
    await expect(
      requestAccountSoftDelete(prisma as never, {
        userId: "pinned",
        actorUserId: "admin",
        envPinnedUserIds: ["pinned"],
      }),
    ).rejects.toThrow(/pinned by SHARED_KEY_BUDGET_USER_IDS/);
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(removeSharedKeyBudgetMemberTx).not.toHaveBeenCalled();
  });

  it("deactivates, revokes sessions, and drops the roster row in one locked transaction", async () => {
    const now = new Date("2026-06-01T00:00:00.000Z");
    const { tx, prisma } = fakeTx(
      { id: "u1", deletionRequestedAt: null, deactivatedAt: null, purgeAfter: null },
      { sharedKeyBudgetMember: { findUnique: vi.fn(async () => ({ userId: "u1" })) } },
    );

    const result = await requestAccountSoftDelete(prisma as never, {
      userId: "u1",
      actorUserId: "admin",
      now,
    });

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(lockSharedKeyBudget).toHaveBeenCalledWith(tx, "members");
    expect(result).toEqual({
      purgeAfter: new Date(now.getTime() + ACCOUNT_SOFT_DELETE_RETENTION_MS),
      priorSharedKeyBudgetMember: true,
      alreadyPending: false,
    });
    expect(tx.user.update).toHaveBeenCalledWith({
      where: { id: "u1" },
      data: expect.objectContaining({
        deletionRequestedAt: now,
        purgeAfter: result.purgeAfter,
        deletedByUserId: "admin",
        priorSharedKeyBudgetMember: true,
        deactivatedAt: now,
        deactivatedBeforeDeletion: null,
      }),
    });
    expect(tx.session.deleteMany).toHaveBeenCalledWith({ where: { userId: "u1" } });
    expect(removeSharedKeyBudgetMemberTx).toHaveBeenCalledWith(
      tx,
      "u1",
      now,
      expect.objectContaining({ actorUserId: "admin" }),
    );
    expect(appendAuditEventTx).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({ action: "account.soft_deleted" }),
    );
  });

  it("remembers an earlier deactivation so restore can put it back", async () => {
    const now = new Date("2026-06-01T00:00:00.000Z");
    const earlier = new Date("2026-05-01T00:00:00.000Z");
    const { tx, prisma } = fakeTx({
      id: "u1",
      deletionRequestedAt: null,
      deactivatedAt: earlier,
      purgeAfter: null,
    });
    await requestAccountSoftDelete(prisma as never, { userId: "u1", actorUserId: "admin", now });
    expect(tx.user.update).toHaveBeenCalledWith({
      where: { id: "u1" },
      data: expect.objectContaining({ deactivatedAt: earlier, deactivatedBeforeDeletion: earlier }),
    });
    expect(removeSharedKeyBudgetMemberTx).not.toHaveBeenCalled();
  });

  it("finishes a roster removal left behind instead of throwing when already pending", async () => {
    const now = new Date("2026-06-02T00:00:00.000Z");
    const purgeAfter = new Date("2026-07-01T00:00:00.000Z");
    const { tx, prisma } = fakeTx(
      {
        id: "u1",
        deletionRequestedAt: new Date("2026-06-01T00:00:00.000Z"),
        deactivatedAt: new Date("2026-06-01T00:00:00.000Z"),
        purgeAfter,
        priorSharedKeyBudgetMember: true,
      },
      { sharedKeyBudgetMember: { findUnique: vi.fn(async () => ({ userId: "u1" })) } },
    );
    const result = await requestAccountSoftDelete(prisma as never, {
      userId: "u1",
      actorUserId: "admin",
      now,
    });
    expect(result).toEqual({ purgeAfter, priorSharedKeyBudgetMember: true, alreadyPending: true });
    expect(removeSharedKeyBudgetMemberTx).toHaveBeenCalledWith(tx, "u1", now, expect.anything());
    expect(appendAuditEventTx).not.toHaveBeenCalled();
  });
});

const pendingUser = (overrides: Record<string, unknown> = {}) => ({
  id: "u1",
  deletionRequestedAt: new Date("2026-06-01T00:00:00.000Z"),
  purgeAfter: new Date("2026-07-01T00:00:00.000Z"),
  purgeClaimedAt: null,
  priorSharedKeyBudgetMember: true,
  deactivatedAt: new Date("2026-06-01T00:00:00.000Z"),
  deactivatedBeforeDeletion: null,
  ...overrides,
});

describe("restoreAccountSoftDelete", () => {
  const now = new Date("2026-06-15T00:00:00.000Z");

  it("refuses restore after purgeAfter", async () => {
    const { prisma } = fakeTx(pendingUser());
    const outcome = await restoreAccountSoftDelete(prisma as never, {
      userId: "u1",
      actorUserId: "admin",
      via: "admin",
      now: new Date("2026-07-02T00:00:00.000Z"),
    });
    expect(outcome).toEqual({ restored: false, reason: "purge_due" });
    expect(addSharedKeyBudgetMemberTx).not.toHaveBeenCalled();
  });

  it("refuses while a purge claim is fresh", async () => {
    const { prisma } = fakeTx(pendingUser({ purgeClaimedAt: new Date(now.getTime() - 1000) }));
    await expect(
      restoreAccountSoftDelete(prisma as never, {
        userId: "u1",
        actorUserId: "a",
        via: "admin",
        now,
      }),
    ).resolves.toEqual({ restored: false, reason: "purge_claimed" });
  });

  it("clears deletion and re-enrolls with the normal bar in the same locked transaction", async () => {
    const { tx, prisma } = fakeTx(pendingUser());
    const outcome = await restoreAccountSoftDelete(prisma as never, {
      userId: "u1",
      actorUserId: "admin",
      via: "admin",
      now,
    });
    expect(outcome).toEqual({ restored: true, priorSharedKeyBudgetMember: true });
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(lockSharedKeyBudget).toHaveBeenCalledWith(tx, "members");
    expect(tx.user.update).toHaveBeenCalledTimes(1);
    expect(tx.user.update).toHaveBeenCalledWith({
      where: { id: "u1" },
      data: expect.objectContaining({
        deactivatedAt: null,
        deactivatedBeforeDeletion: null,
        deletionRequestedAt: null,
        purgeAfter: null,
        priorSharedKeyBudgetMember: false,
      }),
    });
    expect(addSharedKeyBudgetMemberTx).toHaveBeenCalledWith(tx, "u1", now, { policy: undefined });
    const options = vi.mocked(addSharedKeyBudgetMemberTx).mock.calls[0]?.[3];
    expect(options).not.toHaveProperty("admin");
  });

  it.each(["zero_slice", "ineligible"] as const)(
    "keeps prior membership pending when re-enroll is %s",
    async (reason) => {
      vi.mocked(addSharedKeyBudgetMemberTx).mockResolvedValue({ enrolled: false, reason });
      const { tx, prisma } = fakeTx(pendingUser());
      const outcome = await restoreAccountSoftDelete(prisma as never, {
        userId: "u1",
        actorUserId: "admin",
        via: "admin",
        now,
      });
      expect(outcome).toEqual({
        restored: true,
        priorSharedKeyBudgetMember: true,
        budgetReenroll: "restored_budget_reenroll_pending",
      });
      expect(tx.user.update).toHaveBeenLastCalledWith({
        where: { id: "u1" },
        data: { priorSharedKeyBudgetMember: true },
      });
    },
  );

  it("refuses verified-email restore for an account deactivated before deletion", async () => {
    const { tx, prisma } = fakeTx(
      pendingUser({ deactivatedBeforeDeletion: new Date("2026-05-01T00:00:00.000Z") }),
    );
    const outcome = await restoreAccountSoftDelete(prisma as never, {
      userId: "u1",
      actorUserId: "u1",
      via: "otp",
      now,
    });
    expect(outcome).toEqual({ restored: false, reason: "admin_only" });
    expect(tx.user.update).not.toHaveBeenCalled();
  });

  it("refuses verified-email restore while the directory keeps the account off", async () => {
    const { tx, prisma } = fakeTx(pendingUser(), {
      scimUser: { findMany: vi.fn(async () => [{ active: false }]) },
    });
    const outcome = await restoreAccountSoftDelete(prisma as never, {
      userId: "u1",
      actorUserId: "u1",
      via: "otp",
      now,
    });
    expect(outcome).toEqual({ restored: false, reason: "directory" });
    expect(tx.user.update).not.toHaveBeenCalled();
  });

  it("lets an admin restore but keeps the original deactivation", async () => {
    const earlier = new Date("2026-05-01T00:00:00.000Z");
    vi.mocked(addSharedKeyBudgetMemberTx).mockResolvedValue({
      enrolled: false,
      reason: "ineligible",
    });
    const { tx, prisma } = fakeTx(pendingUser({ deactivatedBeforeDeletion: earlier }));
    const outcome = await restoreAccountSoftDelete(prisma as never, {
      userId: "u1",
      actorUserId: "admin",
      via: "admin",
      now,
    });
    expect(outcome).toMatchObject({ restored: true });
    expect(tx.user.update).toHaveBeenCalledWith({
      where: { id: "u1" },
      data: expect.objectContaining({ deactivatedAt: earlier, deletionRequestedAt: null }),
    });
  });
});

describe("retryRestoredAccountBudgetReenroll", () => {
  it("clears the pending flag once the account is back on the roster", async () => {
    const { tx, prisma } = fakeTx({ deletionRequestedAt: null, priorSharedKeyBudgetMember: true });
    await expect(
      retryRestoredAccountBudgetReenroll(prisma as never, { userId: "u1", actorUserId: "admin" }),
    ).resolves.toEqual({ enrolled: true });
    expect(tx.user.update).toHaveBeenCalledWith({
      where: { id: "u1" },
      data: { priorSharedKeyBudgetMember: false },
    });
  });

  it("does nothing for an account that is not waiting on a re-enroll", async () => {
    const { prisma } = fakeTx({ deletionRequestedAt: null, priorSharedKeyBudgetMember: false });
    await expect(
      retryRestoredAccountBudgetReenroll(prisma as never, { userId: "u1", actorUserId: "admin" }),
    ).resolves.toEqual({ enrolled: false, reason: "not_pending" });
    expect(addSharedKeyBudgetMemberTx).not.toHaveBeenCalled();
  });
});

describe("findSoftDeletedUserByEmail", () => {
  it("matches the lower-cased address exactly, never as a LIKE pattern", async () => {
    const queryRaw = vi.fn(async () => [{ id: "u1" }]);
    const findUnique = vi.fn(async () => pendingUser({ email: "a_b@example.test" }));
    const findFirst = vi.fn();
    const found = await findSoftDeletedUserByEmail(
      { $queryRaw: queryRaw, user: { findUnique, findFirst } } as never,
      " A_B@Example.TEST ",
    );
    expect(found?.id).toBe("u1");
    expect(findFirst).not.toHaveBeenCalled();
    const [strings, ...values] = queryRaw.mock.calls[0] as unknown as [string[], ...unknown[]];
    expect(strings.join("?")).toMatch(/lower\(email\) = \?/);
    expect(strings.join("?")).not.toMatch(/like/i);
    expect(values).toEqual(["a_b@example.test"]);
  });

  it("returns null when nothing matches", async () => {
    const findUnique = vi.fn();
    await expect(
      findSoftDeletedUserByEmail(
        { $queryRaw: vi.fn(async () => []), user: { findUnique } } as never,
        "nobody@example.test",
      ),
    ).resolves.toBeNull();
    expect(findUnique).not.toHaveBeenCalled();
  });
});

describe("purge claims", () => {
  const now = new Date("2026-07-02T00:00:00.000Z");
  const due = {
    deletionRequestedAt: new Date("2026-06-01T00:00:00.000Z"),
    purgeAfter: new Date("2026-07-01T00:00:00.000Z"),
  };

  it("lists due accounts that are unclaimed or whose claim went stale", async () => {
    const findMany = vi.fn(async () => []);
    await listAccountsDueForPurge({ user: { findMany } } as never, now);
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          deletionRequestedAt: { not: null },
          purgeAfter: { lt: now },
          OR: [
            { purgeClaimedAt: null },
            { purgeClaimedAt: { lt: new Date(now.getTime() - ACCOUNT_PURGE_CLAIM_TIMEOUT_MS) } },
          ],
        },
      }),
    );
  });

  it("claims only when pending and past purgeAfter", async () => {
    const { tx, prisma } = fakeTx({ ...due, purgeClaimedAt: null });
    await expect(claimAccountForPurge(prisma as never, "u1", now)).resolves.toEqual(now);
    expect(tx.user.update).toHaveBeenCalledWith({
      where: { id: "u1" },
      data: { purgeClaimedAt: now },
    });
  });

  it("does not claim when already restored", async () => {
    const { prisma } = fakeTx({
      deletionRequestedAt: null,
      purgeAfter: null,
      purgeClaimedAt: null,
    });
    await expect(claimAccountForPurge(prisma as never, "u1", now)).resolves.toBeNull();
  });

  it("refuses a fresh claim and takes over a stale one", async () => {
    const fresh = fakeTx({ ...due, purgeClaimedAt: new Date(now.getTime() - 1000) });
    await expect(claimAccountForPurge(fresh.prisma as never, "u1", now)).resolves.toBeNull();
    expect(fresh.tx.user.update).not.toHaveBeenCalled();

    const stale = fakeTx({
      ...due,
      purgeClaimedAt: new Date(now.getTime() - ACCOUNT_PURGE_CLAIM_TIMEOUT_MS - 1),
    });
    await expect(claimAccountForPurge(stale.prisma as never, "u1", now)).resolves.toEqual(now);
  });

  it("resumes after a worker crashed holding its claim, once the lease runs out", async () => {
    const row: Record<string, unknown> = { ...due, purgeClaimedAt: null };
    const { tx, prisma } = fakeTx(row);
    tx.user.findUnique.mockImplementation(async () => ({ ...row }));
    tx.user.update.mockImplementation(async (...args: unknown[]) => {
      const update = args[0] as { data: Record<string, unknown> };
      Object.assign(row, update.data);
      return {};
    });

    const first = await claimAccountForPurge(prisma as never, "u1", now);
    expect(first).toEqual(now);
    // The first worker dies here. Inside the lease nobody else may take it.
    const soon = new Date(now.getTime() + 60_000);
    await expect(claimAccountForPurge(prisma as never, "u1", soon)).resolves.toBeNull();

    const later = new Date(now.getTime() + ACCOUNT_PURGE_CLAIM_TIMEOUT_MS + 1);
    const second = await claimAccountForPurge(prisma as never, "u1", later);
    expect(second).toEqual(later);
    // The dead worker's claim no longer finalizes; the new one does.
    await expect(finalizeAccountPurge(prisma as never, "u1", now, later)).resolves.toBe(false);
    await expect(finalizeAccountPurge(prisma as never, "u1", later, later)).resolves.toBe(true);
    expect(tx.user.deleteMany).toHaveBeenCalledTimes(1);
  });
});

describe("finalizeAccountPurge", () => {
  const now = new Date("2026-07-02T00:00:00.000Z");
  const claimedAt = new Date("2026-07-01T23:59:00.000Z");
  const claimed = {
    deletionRequestedAt: new Date("2026-06-01T00:00:00.000Z"),
    purgeAfter: new Date("2026-07-01T00:00:00.000Z"),
    purgeClaimedAt: claimedAt,
  };

  it("writes the purge audit row before deleting the user, under the deployment org id", async () => {
    const { tx, prisma } = fakeTx(claimed);
    await expect(finalizeAccountPurge(prisma as never, "u1", claimedAt, now)).resolves.toBe(true);
    expect(personalOrganizationIds).toHaveBeenCalledWith(tx, "u1");
    expect(appendAuditEventTx).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        action: "account.purged",
        organizationId: "deployment",
        target: { type: "user", id: "u1" },
      }),
    );
    const auditOrder = vi.mocked(appendAuditEventTx).mock.invocationCallOrder[0]!;
    const userDeleteOrder = vi.mocked(tx.user.deleteMany).mock.invocationCallOrder[0]!;
    expect(auditOrder).toBeLessThan(userDeleteOrder);
    expect(tx.messagingLinkCode.deleteMany).toHaveBeenCalledWith({ where: { userId: "u1" } });
    expect(tx.organization.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: ["org-personal"] } },
    });
    expect(tx.user.deleteMany).toHaveBeenCalledWith({ where: { id: "u1" } });
  });

  it("leaves a restored account alone", async () => {
    const { tx, prisma } = fakeTx({ ...claimed, deletionRequestedAt: null });
    await expect(finalizeAccountPurge(prisma as never, "u1", claimedAt, now)).resolves.toBe(false);
    expect(personalOrganizationIds).not.toHaveBeenCalled();
    expect(tx.user.deleteMany).not.toHaveBeenCalled();
  });
});
