import { describe, expect, it, vi } from "vitest";
import { removeSharedKeyBudgetMember } from "./shared-key-budget.js";
import {
  loadSharedKeyBudgetSettingsView,
  setSharedKeyMemberOverride,
  updateSharedKeyBudgetSettings,
} from "./shared-key-budget-settings.js";

function settingsClient(overrides?: {
  settings?: Record<string, unknown>;
  memberOverrides?: Array<{ userId: string; weeklyAllotmentUsd: number }>;
  auditFail?: boolean;
  noOrg?: boolean;
}) {
  const settingsRow = {
    sharedKeyMonthlyBudgetUsd: 400,
    sharedKeyPeriod: null as string | null,
    sharedKeyResetDow: null,
    sharedKeyResetDom: null,
    sharedKeyResetMinutes: null,
    sharedKeyTimezone: null,
    sharedKeyActivePeriodStart: null as Date | null,
    sharedKeyAutoEnrollMode: null,
    sharedKeyWarningThresholds: null,
    sharedKeyHardStopEnabled: null,
    sharedKeyHoldStaleMinutes: null,
    sharedKeyPruneInactive: null,
    ...overrides?.settings,
  };
  let liveSettings = { ...settingsRow };
  const memberOverrides = [...(overrides?.memberOverrides ?? [])];
  const auditRows: Array<Record<string, unknown>> = [];
  const client = {
    deploymentSettings: {
      findUnique: vi.fn(async () => ({ ...liveSettings })),
      upsert: vi.fn(async ({ update }: { update: Record<string, unknown> }) => {
        liveSettings = { ...liveSettings, ...update };
        return { ...liveSettings };
      }),
    },
    sharedKeyMemberOverride: {
      findMany: vi.fn(async ({ where }: { where?: { userId?: { not: string } } } = {}) => {
        if (where?.userId?.not) {
          return memberOverrides.filter((row) => row.userId !== where.userId!.not);
        }
        return [...memberOverrides];
      }),
      findFirst: vi.fn(async () => memberOverrides[0] ?? null),
      findUnique: vi.fn(async ({ where }: { where: { userId: string } }) => {
        const found = memberOverrides.find((row) => row.userId === where.userId);
        return found ? { weeklyAllotmentUsd: found.weeklyAllotmentUsd } : null;
      }),
      upsert: vi.fn(
        async ({
          where,
          create,
          update,
        }: {
          where: { userId: string };
          create: { userId: string; weeklyAllotmentUsd: number };
          update: { weeklyAllotmentUsd: number };
        }) => {
          const idx = memberOverrides.findIndex((row) => row.userId === where.userId);
          if (idx >= 0) {
            memberOverrides[idx]!.weeklyAllotmentUsd = update.weeklyAllotmentUsd;
          } else {
            memberOverrides.push({ ...create });
          }
          return create;
        },
      ),
      deleteMany: vi.fn(async ({ where }: { where: { userId: string } }) => {
        const before = memberOverrides.length;
        for (let i = memberOverrides.length - 1; i >= 0; i -= 1) {
          if (memberOverrides[i]!.userId === where.userId) memberOverrides.splice(i, 1);
        }
        return { count: before - memberOverrides.length };
      }),
    },
    sharedKeyBudgetMember: {
      findMany: vi.fn(async () => []),
      findUnique: vi.fn(async ({ where }: { where: { userId: string } }) =>
        where.userId ? { userId: where.userId } : null,
      ),
    },
    sharedKeyWeekAllotment: {
      findMany: vi.fn(async () => []),
      findUnique: vi.fn(async () => null),
      upsert: vi.fn(async () => null),
      update: vi.fn(async () => null),
      updateMany: vi.fn(async () => ({ count: 0 })),
      deleteMany: vi.fn(async () => ({ count: 0 })),
    },
    sharedKeyAllotmentTransfer: { findMany: vi.fn(async () => []) },
    sharedKeySpendAdjustment: {
      aggregate: vi.fn(async () => ({ _sum: { deltaUsd: 0 } })),
      groupBy: vi.fn(async () => []),
    },
    usageRecord: {
      aggregate: vi.fn(async () => ({ _sum: { costUsd: 0 } })),
      groupBy: vi.fn(async () => []),
    },
    user: {
      findMany: vi.fn(async () => []),
      findUnique: vi.fn(async () => ({ email: "admin@example.test" })),
    },
    member: {
      findMany: vi.fn(async () =>
        overrides?.noOrg ? [] : [{ organizationId: "org-admin" }],
      ),
    },
    adminGrant: { findMany: vi.fn(async () => []) },
    auditEvent: {
      createMany: vi.fn(async ({ data }: { data: Array<Record<string, unknown>> }) => {
        if (overrides?.auditFail) throw new Error("audit write failed");
        auditRows.push(...data);
        return { count: data.length };
      }),
    },
    space: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) =>
        where.id === "space-ops"
          ? { organizationId: "org-ops", name: "Ops" }
          : null,
      ),
    },
    $queryRaw: vi.fn(async () => [{ lock: "1", bypass: "off", key: "", login: "test" }]),
    $transaction: vi.fn(async (work: (tx: unknown) => Promise<unknown>) => {
      const snapshotSettings = { ...liveSettings };
      const snapshotOverrides = memberOverrides.map((row) => ({ ...row }));
      const snapshotAudit = auditRows.length;
      try {
        return await work(client);
      } catch (error) {
        liveSettings = snapshotSettings;
        memberOverrides.splice(0, memberOverrides.length, ...snapshotOverrides);
        auditRows.splice(snapshotAudit);
        throw error;
      }
    }),
  };
  return { client, auditRows, getSettings: () => liveSettings, memberOverrides };
}

describe("shared-key budget settings", () => {
  it("reports default sources when DB columns are null", async () => {
    const prisma = {
      deploymentSettings: {
        findUnique: vi.fn(async () => ({
          sharedKeyMonthlyBudgetUsd: null,
          sharedKeyPeriod: null,
          sharedKeyResetDow: null,
          sharedKeyResetDom: null,
          sharedKeyResetMinutes: null,
          sharedKeyTimezone: null,
          sharedKeyActivePeriodStart: null,
          sharedKeyAutoEnrollMode: null,
          sharedKeyWarningThresholds: null,
          sharedKeyHardStopEnabled: null,
          sharedKeyHoldStaleMinutes: null,
          sharedKeyPruneInactive: null,
        })),
      },
      sharedKeyMemberOverride: {
        findMany: vi.fn(async () => []),
      },
    };
    const view = await loadSharedKeyBudgetSettingsView(prisma as never, 400);
    expect(view.monthlyCapUsd).toBe(400);
    expect(view.monthlyCapSource).toBe("env");
    expect(view.period).toBe("week");
    expect(view.periodSource).toBe("default");
    expect(view.timezone).toBe("America/New_York");
    expect(view.hardStopEnabled).toBe(true);
    expect(view.holdStaleMinutes).toBe(30);
    expect(view.warningThresholds).toEqual([80, 95]);
  });

  it("takes the members lock on every settings write", async () => {
    const locks: string[] = [];
    const client = {
      deploymentSettings: {
        findUnique: vi.fn(async () => ({
          sharedKeyMonthlyBudgetUsd: 400,
          sharedKeyPeriod: null,
          sharedKeyResetDow: null,
          sharedKeyResetDom: null,
          sharedKeyResetMinutes: null,
          sharedKeyTimezone: null,
          sharedKeyActivePeriodStart: null,
          sharedKeyAutoEnrollMode: null,
          sharedKeyWarningThresholds: null,
          sharedKeyHardStopEnabled: null,
          sharedKeyHoldStaleMinutes: null,
          sharedKeyPruneInactive: null,
        })),
        upsert: vi.fn(async () => ({})),
      },
      sharedKeyMemberOverride: { findMany: vi.fn(async () => []) },
      sharedKeyBudgetMember: { findMany: vi.fn(async () => []), findUnique: vi.fn(async () => null) },
      sharedKeyWeekAllotment: {
        findMany: vi.fn(async () => []),
        findUnique: vi.fn(async () => null),
        upsert: vi.fn(async () => null),
        update: vi.fn(async () => null),
        updateMany: vi.fn(async () => ({ count: 0 })),
        deleteMany: vi.fn(async () => ({ count: 0 })),
      },
      sharedKeyAllotmentTransfer: { findMany: vi.fn(async () => []) },
      sharedKeySpendAdjustment: {
        aggregate: vi.fn(async () => ({ _sum: { deltaUsd: 0 } })),
        groupBy: vi.fn(async () => []),
      },
      usageRecord: {
        aggregate: vi.fn(async () => ({ _sum: { costUsd: 0 } })),
        groupBy: vi.fn(async () => []),
      },
      user: {
        findMany: vi.fn(async () => []),
        findUnique: vi.fn(async () => ({ email: "admin@example.test" })),
      },
      member: {
        findMany: vi.fn(async () => [{ organizationId: "org-admin" }]),
      },
      adminGrant: { findMany: vi.fn(async () => []) },
      auditEvent: { createMany: vi.fn(async () => ({ count: 0 })) },
      space: { findUnique: vi.fn(async () => null) },
      $queryRaw: vi.fn(async (query: { values?: unknown[] }) => {
        const key = Array.isArray(query?.values) ? String(query.values[0] ?? "") : "";
        if (key) locks.push(key);
        return [{ lock: "1" }];
      }),
      $transaction: vi.fn(async (work: (tx: unknown) => Promise<unknown>) => work(client)),
    };
    await updateSharedKeyBudgetSettings(
      client as never,
      {
        hardStopEnabled: false,
        holdStaleMinutes: 45,
      },
      { actorUserId: "admin", gatedDeployment: false },
    );
    expect(locks.some((key) => key.includes("shared-key-budget:members"))).toBe(true);
    expect(client.auditEvent.createMany).toHaveBeenCalled();
  });

  it("treats applyScheduleNow alone as a no-op (no unaudited rebase)", async () => {
    const locks: string[] = [];
    let rebaseCalls = 0;
    const client = {
      deploymentSettings: {
        findUnique: vi.fn(async () => ({
          sharedKeyMonthlyBudgetUsd: 400,
          sharedKeyPeriod: null,
          sharedKeyResetDow: null,
          sharedKeyResetDom: null,
          sharedKeyResetMinutes: null,
          sharedKeyTimezone: null,
          sharedKeyActivePeriodStart: new Date("2026-11-02T05:00:00.000Z"),
          sharedKeyAutoEnrollMode: null,
          sharedKeyWarningThresholds: null,
          sharedKeyHardStopEnabled: null,
          sharedKeyHoldStaleMinutes: null,
          sharedKeyPruneInactive: null,
        })),
        upsert: vi.fn(async ({ update }: { update: Record<string, unknown> }) => {
          // No schedule fields → upsert still runs but must not rewrite active period
          // via applyScheduleNow alone, and must not trigger a rebase.
          expect(update).not.toHaveProperty("sharedKeyActivePeriodStart");
          return {};
        }),
      },
      sharedKeyMemberOverride: { findMany: vi.fn(async () => []) },
      sharedKeyBudgetMember: {
        findMany: vi.fn(async () => {
          rebaseCalls += 1;
          return [];
        }),
        findUnique: vi.fn(async () => null),
      },
      sharedKeyWeekAllotment: {
        findMany: vi.fn(async () => []),
        findUnique: vi.fn(async () => null),
        upsert: vi.fn(async () => null),
        update: vi.fn(async () => null),
        updateMany: vi.fn(async () => ({ count: 0 })),
        deleteMany: vi.fn(async () => ({ count: 0 })),
      },
      sharedKeyAllotmentTransfer: { findMany: vi.fn(async () => []) },
      sharedKeySpendAdjustment: {
        aggregate: vi.fn(async () => ({ _sum: { deltaUsd: 0 } })),
        groupBy: vi.fn(async () => []),
      },
      usageRecord: {
        aggregate: vi.fn(async () => ({ _sum: { costUsd: 0 } })),
        groupBy: vi.fn(async () => []),
      },
      user: {
        findMany: vi.fn(async () => []),
        findUnique: vi.fn(async () => ({ email: "admin@example.test" })),
      },
      member: { findMany: vi.fn(async () => [{ organizationId: "org-admin" }]) },
      adminGrant: { findMany: vi.fn(async () => []) },
      auditEvent: { createMany: vi.fn(async () => ({ count: 0 })) },
      space: { findUnique: vi.fn(async () => null) },
      $queryRaw: vi.fn(async (query: { values?: unknown[] }) => {
        const key = Array.isArray(query?.values) ? String(query.values[0] ?? "") : "";
        if (key) locks.push(key);
        return [{ lock: "1" }];
      }),
      $transaction: vi.fn(async (work: (tx: unknown) => Promise<unknown>) => work(client)),
    };
    await updateSharedKeyBudgetSettings(
      client as never,
      { applyScheduleNow: true },
      { actorUserId: "admin", gatedDeployment: false },
    );
    expect(rebaseCalls).toBe(0);
    expect(client.auditEvent.createMany).not.toHaveBeenCalled();
  });

  it("refuses to remove env-pinned members", async () => {
    const client = {
      $transaction: vi.fn(async (work: (tx: unknown) => Promise<unknown>) => work(client)),
      $queryRaw: vi.fn(async () => [{ lock: "1" }]),
      sharedKeyBudgetMember: {
        deleteMany: vi.fn(async () => ({ count: 1 })),
      },
    };
    await expect(
      removeSharedKeyBudgetMember(client as never, "pinned", new Date(), {
        envPinnedUserIds: ["pinned"],
      }),
    ).rejects.toThrow(/pinned by SHARED_KEY_BUDGET_USER_IDS/);
    expect(client.$transaction).not.toHaveBeenCalled();
  });

  it("rolls back a settings write when the audit write fails", async () => {
    const { client, getSettings } = settingsClient({ auditFail: true });
    await expect(
      updateSharedKeyBudgetSettings(
        client as never,
        { hardStopEnabled: false },
        { actorUserId: "admin", gatedDeployment: false, spaceId: "space-ops" },
      ),
    ).rejects.toThrow(/audit write failed/);
    expect(getSettings().sharedKeyHardStopEnabled).toBeNull();
  });

  it("audits settings changes with prev/next values", async () => {
    const { client, auditRows } = settingsClient();
    await updateSharedKeyBudgetSettings(
      client as never,
      { hardStopEnabled: false, holdStaleMinutes: 45 },
      { actorUserId: "admin", gatedDeployment: false, spaceId: "space-ops" },
    );
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]).toMatchObject({
      action: "shared_key_budget.settings.changed",
      organizationId: "org-ops",
      metadata: expect.objectContaining({
        "prev.hardStopEnabled": null,
        "next.hardStopEnabled": false,
        "prev.holdStaleMinutes": null,
        "next.holdStaleMinutes": 45,
      }),
    });
  });

  it("audits override writes with prev/next weeklyAllotmentUsd", async () => {
    const { client, auditRows, memberOverrides } = settingsClient({
      memberOverrides: [{ userId: "a", weeklyAllotmentUsd: 10 }],
    });
    await setSharedKeyMemberOverride(client as never, {
      userId: "a",
      weeklyAllotmentUsd: 25,
      actorUserId: "admin",
      spaceId: "space-ops",
    });
    expect(memberOverrides.find((row) => row.userId === "a")?.weeklyAllotmentUsd).toBe(25);
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]).toMatchObject({
      action: "shared_key_budget.member.override",
      organizationId: "org-ops",
      metadata: expect.objectContaining({
        "prev.weeklyAllotmentUsd": 10,
        "next.weeklyAllotmentUsd": 25,
      }),
    });
  });

  it("rejects an override that exceeds the period pool", async () => {
    const { client } = settingsClient({
      memberOverrides: [{ userId: "b", weeklyAllotmentUsd: 80 }],
    });
    // Week pool = 400/4 = 100; 80 + 30 = 110.
    await expect(
      setSharedKeyMemberOverride(client as never, {
        userId: "a",
        weeklyAllotmentUsd: 30,
        actorUserId: "admin",
        spaceId: "space-ops",
      }),
    ).rejects.toThrow(/exceeds the period pool/);
  });

  it("rejects a cap reduction that puts the pool below current overrides", async () => {
    const { client, getSettings } = settingsClient({
      memberOverrides: [
        { userId: "a", weeklyAllotmentUsd: 40 },
        { userId: "b", weeklyAllotmentUsd: 40 },
      ],
    });
    // Week pool at $200/mo = $50; overrides sum to $80.
    await expect(
      updateSharedKeyBudgetSettings(
        client as never,
        { monthlyCapUsd: 200 },
        { actorUserId: "admin", gatedDeployment: false, spaceId: "space-ops" },
      ),
    ).rejects.toThrow(/exceeds the period pool/);
    expect(getSettings().sharedKeyMonthlyBudgetUsd).toBe(400);
  });

  it("rejects a period change that puts the pool below current overrides", async () => {
    const { client, getSettings } = settingsClient({
      settings: {
        sharedKeyMonthlyBudgetUsd: 100,
        sharedKeyPeriod: "month",
      },
      memberOverrides: [{ userId: "a", weeklyAllotmentUsd: 60 }],
    });
    // Month pool $100 fits; week pool $25 does not.
    await expect(
      updateSharedKeyBudgetSettings(
        client as never,
        { period: "week" },
        { actorUserId: "admin", gatedDeployment: false, spaceId: "space-ops" },
      ),
    ).rejects.toThrow(/exceeds the period pool/);
    expect(getSettings().sharedKeyPeriod).toBe("month");
  });
});
