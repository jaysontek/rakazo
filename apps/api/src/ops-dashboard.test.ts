import { describe, expect, it, vi } from "vitest";
import { loadOpsOverview } from "./ops-dashboard.js";

describe("loadOpsOverview", () => {
  it("filters builddrive.net accounts out of the overview", async () => {
    const prisma = {
      user: {
        findMany: vi.fn(async () => [
          { id: "visible", email: "user@tekweld.com", name: "User", deactivatedAt: null },
          { id: "hidden", email: "ops@builddrive.net", name: "Hidden", deactivatedAt: null },
          {
            id: "hidden-sub",
            email: "dev@corp.builddrive.net",
            name: "Sub",
            deactivatedAt: null,
          },
        ]),
      },
      usageRecord: {
        groupBy: vi.fn(async () => []),
        findMany: vi.fn(async () => []),
        aggregate: vi.fn(async () => ({ _sum: { costUsd: 0 } })),
      },
      bot: {
        findMany: vi.fn(async () => [
          {
            id: "bot-visible",
            name: "Visible bot",
            userId: "visible",
            spaceId: "space",
            modelProvider: null,
            modelId: null,
            archivedAt: null,
          },
          {
            id: "bot-hidden",
            name: "Hidden bot",
            userId: "hidden",
            spaceId: "space",
            modelProvider: null,
            modelId: null,
            archivedAt: null,
          },
        ]),
      },
      run: {
        findMany: vi.fn(async () => [
          {
            userId: "visible",
            status: "completed",
            error: null,
            createdAt: new Date("2026-11-05T12:00:00Z"),
            startedAt: null,
            firstResponseAt: null,
            completedAt: null,
            sourceMessage: null,
          },
          {
            userId: "hidden",
            status: "failed",
            error: "boom",
            createdAt: new Date("2026-11-05T12:00:00Z"),
            startedAt: null,
            firstResponseAt: null,
            completedAt: null,
            sourceMessage: null,
          },
        ]),
      },
      deploymentSettings: {
        findUnique: vi.fn(async () => null),
      },
      sharedKeyBudgetMember: {
        findMany: vi.fn(async () => []),
        findUnique: vi.fn(async () => null),
      },
      sharedKeyBudgetEnrollmentRequest: {
        findMany: vi.fn(async () => []),
      },
      sharedKeyWeekAllotment: {
        findMany: vi.fn(async () => []),
        findUnique: vi.fn(async () => null),
      },
      sharedKeyAllotmentTransfer: {
        findMany: vi.fn(async () => []),
      },
      adminGrant: {
        findMany: vi.fn(async () => []),
      },
      $queryRaw: vi.fn(async () => [{ "?column?": 1 }]),
    };

    const overview = await loadOpsOverview(
      prisma as never,
      {},
      new Date("2026-11-05T17:00:00.000Z"),
      null,
    );

    expect(overview.accounts.map((row) => row.email)).toEqual(["user@tekweld.com"]);
    expect(overview.agents.names.map((bot) => bot.id)).toEqual(["bot-visible"]);
    expect(overview.performance.runCount).toBe(1);
    expect(overview.performance.errorCount).toBe(0);
  });
});
