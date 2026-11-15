import { describe, expect, it, vi } from "vitest";
import { removeSharedKeyBudgetMember } from "./shared-key-budget.js";
import {
  loadSharedKeyBudgetSettingsView,
  updateSharedKeyBudgetSettings,
} from "./shared-key-budget-settings.js";

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
});
