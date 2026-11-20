import type { SecretStore } from "@rakazo/adapter-kit";
import {
  lookupMinimumWorstCaseCallCostUsd,
  resolveDeploymentModel,
  resolveModelKeyTypeSafe,
} from "@rakazo/adapters";
import type { OpsAccountModelSource } from "@rakazo/contracts";
import { projectSharedKeyBudgetDisplay } from "@rakazo/core";
import type {
  AdminGrantRow,
  AllotmentTransferRow,
  PrismaClient,
  SharedKeyBudgetSettingsView,
  SharedKeySpendAdjustmentRow,
} from "@rakazo/db";
import {
  isHiddenOpsEmail,
  listAdminGrants,
  listSharedKeyAllotmentTransfers,
  listSharedKeyBudgetMembers,
  listSharedKeyBudgetNotEnrolledHits,
  listSharedKeySpendAdjustments,
  loadSharedKeyBudgetSettingsView,
  Prisma,
  resolveSharedKeyPeriodBounds,
  runAsSystem,
  sharedKeyMonthlyBudgetUsd,
  sharedKeyWeeklyBudgetStatus,
  trackedSharedKeySpendByUser,
  trackedSharedKeyTeamSpendUsd,
} from "@rakazo/db";

const RECENT_RUN_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const LATENCY_SAMPLE_LIMIT = 500;
const REQUEST_LOG_DEFAULT_LIMIT = 50;
const CHAT_LOG_DEFAULT_LIMIT = 100;
/** Decrypt/classify a few owners at a time so a large roster cannot stampede the secret store. */
const KEY_TYPE_CONCURRENCY = 4;

export type OpsDashboardPrisma = PrismaClient;

/**
 * Oldest non-deleting space membership per user — same space Accounts and Agents use when
 * classifying company vs personal (hosted credits are space-scoped).
 */
export async function loadOpsSpaceByUser(
  prisma: OpsDashboardPrisma,
  userIds: string[],
): Promise<Map<string, string>> {
  const spaceByUser = new Map<string, string>();
  if (userIds.length === 0) return spaceByUser;
  const spaceMemberships = await prisma.spaceMember.findMany({
    where: {
      userId: { in: userIds },
      space: { deletingAt: null },
    },
    select: { userId: true, spaceId: true },
    orderBy: { createdAt: "asc" },
  });
  for (const membership of spaceMemberships) {
    if (!spaceByUser.has(membership.userId)) {
      spaceByUser.set(membership.userId, membership.spaceId);
    }
  }
  return spaceByUser;
}

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return [];
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      results[index] = await fn(items[index]!);
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * Live company|personal labels for ops Accounts and Agents. One resolve per userId,
 * bounded concurrency, and the same spaceByUser rule both tabs share.
 */
export async function resolveOpsModelKeyTypes(
  prisma: OpsDashboardPrisma,
  scopes: Array<{ userId: string; spaceId: string }>,
  options: {
    secrets?: SecretStore;
    deploymentModelKey?: string | null;
    concurrency?: number;
  } = {},
): Promise<Map<string, { keyType: "company" | "personal"; needsReconnect: boolean }>> {
  const secretStore =
    options.secrets ??
    ({
      load: async () => {
        throw new Error("secret store unavailable");
      },
    } satisfies Pick<SecretStore, "load">);
  const unique = new Map<string, { userId: string; spaceId: string }>();
  for (const scope of scopes) {
    if (!unique.has(scope.userId)) unique.set(scope.userId, scope);
  }
  const entries = [...unique.values()];
  const resolved = await mapWithConcurrency(
    entries,
    options.concurrency ?? KEY_TYPE_CONCURRENCY,
    async (scope) => {
      const resolution = await resolveModelKeyTypeSafe(
        {
          prisma,
          secretStore,
          deploymentModelKey: options.deploymentModelKey ?? undefined,
        },
        scope,
      );
      return {
        userId: scope.userId,
        keyType: resolution.keyType,
        needsReconnect: resolution.needsReconnect,
      };
    },
  );
  return new Map(
    resolved.map((row) => [
      row.userId,
      { keyType: row.keyType, needsReconnect: row.needsReconnect },
    ]),
  );
}

export type OpsAccountRow = {
  userId: string;
  email: string;
  name: string;
  deactivated: boolean;
  modelProvider: string | null;
  modelId: string | null;
  modelSource?: OpsAccountModelSource;
  keyType: "company" | "personal";
  needsReconnect: boolean;
  totalTokens: number | null;
  totalCostUsd: number | null;
  sharedKeyCostUsd: number;
  personalKeyCostUsd: number;
  sharedKeyBudget: {
    configured: boolean;
    member: boolean;
    weeklyCapUsd: number;
    spentUsd: number;
    reservedUsd: number;
    remainingUsd: number;
    percentUsed: number;
    reservedPercent?: number;
    hardStopped: boolean;
    status?: "ok" | "warning" | "blocked";
    weekStartsAt: string;
    resetsAt: string;
    timezone: string;
    hardStopEnabled: boolean;
    warningThresholds: number[];
  } | null;
  pendingSharedBudgetApproval: boolean;
  envPinned: boolean;
  allotmentOverrideUsd: number | null;
};

type OpsResolvedModel = {
  provider: string;
  model: string;
  source: OpsAccountModelSource;
};

/**
 * Per-user latest usage model (DISTINCT ON), then configured role/preference/space
 * choices, then the deployment default. Bounded — no N+1 and no global take window.
 */
export async function resolveOpsAccountModels(
  prisma: OpsDashboardPrisma,
  users: Array<{ userId: string; spaceId: string }>,
): Promise<Map<string, OpsResolvedModel>> {
  const result = new Map<string, OpsResolvedModel>();
  if (users.length === 0) return result;
  const userIds = users.map((user) => user.userId);

  const latestUsage = await prisma.$queryRaw<
    Array<{ userId: string; provider: string; model: string }>
  >(Prisma.sql`
    SELECT DISTINCT ON ("userId") "userId", provider, model
    FROM usage_records
    WHERE "userId" IN (${Prisma.join(userIds)})
    ORDER BY "userId", "createdAt" DESC
  `);
  for (const row of latestUsage) {
    result.set(row.userId, {
      provider: row.provider,
      model: row.model,
      source: "last used",
    });
  }

  const missingAfterUsage = userIds.filter((id) => !result.has(id));
  if (missingAfterUsage.length === 0) return result;

  const missingSet = new Set(missingAfterUsage);
  const spaceTargets = users.filter((user) => missingSet.has(user.userId));
  const [roleChoices, preferences, spaceChoices] = await Promise.all([
    prisma.userModelRoleChoice.findMany({
      where: { userId: { in: missingAfterUsage }, role: "main", position: 0 },
      select: { userId: true, provider: true, modelId: true },
    }),
    prisma.userModelPreference.findMany({
      where: {
        userId: { in: missingAfterUsage },
        modelId: { not: null },
      },
      select: {
        userId: true,
        modelId: true,
        updatedAt: true,
        credential: { select: { provider: true } },
      },
      orderBy: { updatedAt: "desc" },
    }),
    spaceTargets.length === 0
      ? Promise.resolve([] as Array<{ userId: string; provider: string; modelId: string }>)
      : prisma.spaceModelRoleChoice.findMany({
          where: {
            role: "main",
            position: 0,
            OR: spaceTargets.map((user) => ({
              userId: user.userId,
              spaceId: user.spaceId,
            })),
          },
          select: { userId: true, provider: true, modelId: true },
        }),
  ]);

  for (const row of roleChoices) {
    if (result.has(row.userId)) continue;
    result.set(row.userId, {
      provider: row.provider,
      model: row.modelId,
      source: "configured",
    });
  }

  for (const row of preferences) {
    if (result.has(row.userId) || !row.modelId) continue;
    result.set(row.userId, {
      provider: row.credential.provider,
      model: row.modelId,
      source: "configured",
    });
  }

  for (const row of spaceChoices) {
    if (result.has(row.userId)) continue;
    result.set(row.userId, {
      provider: row.provider,
      model: row.modelId,
      source: "configured",
    });
  }

  const deployment = resolveDeploymentModel();
  for (const userId of missingAfterUsage) {
    if (result.has(userId)) continue;
    result.set(userId, {
      provider: deployment.provider,
      model: deployment.model,
      source: "default",
    });
  }

  return result;
}

export type OpsAgentOwner = {
  id: string;
  name: string;
  email: string;
  deactivated: boolean;
};

export type OpsAgentRow = {
  id: string;
  name: string;
  createdAt: string;
  lastActiveAt: string | null;
  status: "active" | "archived";
  owner: OpsAgentOwner | null;
  keyType: "company" | "personal";
  needsReconnect: boolean;
};

export type OpsRequestLogRow = {
  id: string;
  kind: "usage" | "run";
  userId: string;
  botId: string | null;
  botName: string | null;
  runId: string | null;
  threadId: string | null;
  provider: string | null;
  model: string | null;
  sharedKey: boolean | null;
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  costUsd: number | null;
  status: string | null;
  error: string | null;
  firstResponseMs: number | null;
  totalMs: number | null;
  createdAt: string;
};

export type OpsChatLogMessage = {
  id: string;
  role: string;
  seq: number;
  runId: string | null;
  text: string;
  createdAt: string;
};

export type OpsOverview = {
  accounts: OpsAccountRow[];
  agents: {
    total: number;
    active: number;
    names: Array<{ id: string; name: string; userId: string }>;
  };
  spend: {
    totalCostUsd: number | null;
    sharedKeyCostUsd: number;
    personalKeyCostUsd: number;
    totalTokens: number | null;
  };
  sharedKeyBudget: {
    monthlyCapUsd: number | null;
    rosterConfigured: boolean;
    memberCount: number;
    weekPoolUsd: number | null;
    weekSpentUsd: number;
    weekStartsAt: string;
    resetsAt: string;
    timezone: string;
    settings: SharedKeyBudgetSettingsView;
  };
  performance: {
    sampleWindowHours: number;
    runCount: number;
    errorCount: number;
    errorRate: number | null;
    medianFirstResponseMs: number | null;
    medianTotalMs: number | null;
    p95FirstResponseMs: number | null;
  };
  health: {
    database: "ok" | "unreachable" | "unknown";
    degraded: boolean;
    revision: string | null;
    runtime: string | null;
    sandbox: string | null;
  };
  adminGrants: AdminGrantRow[];
  envBootstrapAdmins: string[];
  allotmentTransfers: AllotmentTransferRow[];
  spendAdjustments: SharedKeySpendAdjustmentRow[];
};

export type OpsTeamMemberRow = OpsAccountRow & { agentCount: number };

export type OpsTeam = {
  organizationId: string;
  organizationName: string;
  memberCount: number;
  members: OpsTeamMemberRow[];
  agents: {
    total: number;
    active: number;
    names: Array<{ id: string; name: string; userId: string }>;
  };
  spend: {
    totalCostUsd: number | null;
    sharedKeyCostUsd: number;
    personalKeyCostUsd: number;
    totalTokens: number | null;
  };
};

export type OpsOrganizationNavRow = {
  id: string;
  name: string;
  memberCount: number;
};

/** First plain text block from a message; used for admin chat-log drill-in. */
function messageText(blocks: unknown): string {
  if (!Array.isArray(blocks)) return "";
  for (const block of blocks) {
    if (
      block &&
      typeof block === "object" &&
      "text" in block &&
      typeof (block as { text?: unknown }).text === "string"
    ) {
      return (block as { text: string }).text.trim();
    }
  }
  return "";
}

function sumNullable(values: Array<number | null | undefined>): number | null {
  let total = 0;
  let any = false;
  for (const value of values) {
    if (value == null || !Number.isFinite(value)) continue;
    total += value;
    any = true;
  }
  return any ? total : null;
}

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index] ?? null;
}

function median(sorted: number[]): number | null {
  if (sorted.length === 0) return null;
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid] ?? null;
  const a = sorted[mid - 1];
  const b = sorted[mid];
  if (a == null || b == null) return null;
  return (a + b) / 2;
}

async function probeDatabase(prisma: OpsDashboardPrisma): Promise<"ok" | "unreachable"> {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return "ok";
  } catch {
    return "unreachable";
  }
}

/** Cross-account ops snapshot. Caller must already enforce admin + LAN. */
export async function loadOpsOverview(
  prisma: OpsDashboardPrisma,
  health: {
    degraded?: boolean;
    revision?: string | null;
    runtime?: string | null;
    sandbox?: string | null;
  } = {},
  now = new Date(),
  envSharedKeyMonthlyBudgetUsd: number | null = null,
  options: {
    secrets?: SecretStore;
    /** Deployment shared API key for whatever provider resolveDeploymentModel selects. */
    deploymentModelKey?: string | null;
    envBootstrapAdmins?: string[];
    /** SHARED_KEY_BUDGET_USER_IDS — marked envPinned on account rows. */
    sharedKeyBudgetUserIds?: string[];
  } = {},
): Promise<OpsOverview> {
  return runAsSystem("operations dashboard overview", async () => {
    const weekAgo = new Date(now.getTime() - RECENT_RUN_WINDOW_MS);
    const [
      users,
      usageGroups,
      personalUsageGroups,
      bots,
      recentRuns,
      monthlyCap,
      members,
      settingsRow,
      settingsView,
      database,
    ] = await Promise.all([
      prisma.user.findMany({
        select: {
          id: true,
          email: true,
          name: true,
          deactivatedAt: true,
        },
        orderBy: { createdAt: "asc" },
      }),
      prisma.usageRecord.groupBy({
        by: ["userId"],
        _sum: { totalTokens: true, costUsd: true },
      }),
      prisma.usageRecord.groupBy({
        by: ["userId"],
        where: { sharedKey: false },
        _sum: { costUsd: true },
      }),
      prisma.bot.findMany({
        select: {
          id: true,
          name: true,
          userId: true,
          spaceId: true,
          modelProvider: true,
          modelId: true,
          archivedAt: true,
        },
        orderBy: { name: "asc" },
      }),
      prisma.run.findMany({
        where: { createdAt: { gte: weekAgo } },
        select: {
          userId: true,
          status: true,
          error: true,
          createdAt: true,
          startedAt: true,
          firstResponseAt: true,
          completedAt: true,
          sourceMessage: { select: { createdAt: true } },
        },
        orderBy: { createdAt: "desc" },
        take: LATENCY_SAMPLE_LIMIT,
      }),
      sharedKeyMonthlyBudgetUsd(prisma, envSharedKeyMonthlyBudgetUsd),
      listSharedKeyBudgetMembers(prisma),
      prisma.deploymentSettings.findUnique({
        where: { id: "default" },
        select: {
          sharedKeyPeriod: true,
          sharedKeyResetDow: true,
          sharedKeyResetDom: true,
          sharedKeyResetMinutes: true,
          sharedKeyTimezone: true,
          sharedKeyActivePeriodStart: true,
        },
      }),
      loadSharedKeyBudgetSettingsView(prisma, envSharedKeyMonthlyBudgetUsd, now),
      probeDatabase(prisma),
    ]);
    const { schedule, periodStart, periodEnd } = resolveSharedKeyPeriodBounds(settingsRow, now);
    const [notEnrolledHits, allotmentTransfers, spendAdjustments, sharedByUserMap, weekSpentUsd] =
      await Promise.all([
        listSharedKeyBudgetNotEnrolledHits(prisma, periodStart),
        listSharedKeyAllotmentTransfers(prisma, periodStart),
        listSharedKeySpendAdjustments(prisma, { periodStart, now }),
        trackedSharedKeySpendByUser(prisma, {
          userIds: users.map((user) => user.id),
          until: now,
        }),
        // Tracked company shared-key spend for the current period (usage + adjustments).
        // Personal-key rows are never included. Visible-account filter applied below.
        trackedSharedKeyTeamSpendUsd(prisma, {
          since: periodStart,
          until: now,
          periodStart,
        }),
      ]);
    const notEnrolledHitIds = new Set(notEnrolledHits);
    const envPinnedIds = new Set(
      (options.sharedKeyBudgetUserIds ?? []).map((id) => id.trim()).filter(Boolean),
    );
    const overrideByUser = new Map(
      settingsView.memberOverrides.map((row) => [row.userId, row.weeklyAllotmentUsd]),
    );

    const usageByUser = new Map(
      usageGroups.map((row) => [
        row.userId,
        { totalTokens: row._sum.totalTokens, totalCostUsd: row._sum.costUsd },
      ]),
    );
    const personalByUser = new Map(
      personalUsageGroups.map((row) => [row.userId, row._sum.costUsd ?? 0]),
    );

    const memberIds = new Set(members.map((member) => member.userId));
    const visibleUsers = users.filter((user) => !isHiddenOpsEmail(user.email));
    const hiddenUserIds = new Set(
      users.filter((user) => isHiddenOpsEmail(user.email)).map((user) => user.id),
    );
    const spaceByUser = await loadOpsSpaceByUser(
      prisma,
      visibleUsers.map((user) => user.id),
    );
    const scopedUsers = visibleUsers.map((user) => ({
      userId: user.id,
      spaceId: spaceByUser.get(user.id) ?? user.id,
    }));
    const [keyByUser, latestModel] = await Promise.all([
      resolveOpsModelKeyTypes(prisma, scopedUsers, {
        secrets: options.secrets,
        deploymentModelKey: options.deploymentModelKey,
      }),
      resolveOpsAccountModels(prisma, scopedUsers),
    ]);
    const accounts: OpsAccountRow[] = [];
    for (const user of visibleUsers) {
      const usage = usageByUser.get(user.id);
      const model = latestModel.get(user.id);
      let budget: OpsAccountRow["sharedKeyBudget"] = null;
      if (monthlyCap != null || memberIds.has(user.id)) {
        const status = await sharedKeyWeeklyBudgetStatus(
          prisma,
          user.id,
          now,
          envSharedKeyMonthlyBudgetUsd,
        );
        const maxCallCostUsd = lookupMinimumWorstCaseCallCostUsd(model?.provider, model?.model);
        const projection = projectSharedKeyBudgetDisplay({
          spentUsd: status.spentUsd,
          reservedUsd: status.reservedUsd,
          weeklyCapUsd: status.weeklyCapUsd,
          hardStopEnabled: status.hardStopEnabled && status.enabled && status.member,
          maxCallCostUsd,
          warningThresholds: status.warningThresholds,
        });
        budget = {
          configured: status.enabled,
          member: status.member,
          weeklyCapUsd: status.weeklyCapUsd,
          spentUsd: status.spentUsd,
          reservedUsd: status.reservedUsd,
          remainingUsd: projection.remainingUsd,
          percentUsed: projection.usedPercent,
          reservedPercent: projection.reservedPercent,
          hardStopped: projection.hardStopped,
          status: projection.status,
          weekStartsAt: status.weekStartsAt,
          resetsAt: status.resetsAt,
          timezone: status.timezone,
          hardStopEnabled: status.hardStopEnabled,
          warningThresholds: status.warningThresholds,
        };
      }
      const keyResolution = keyByUser.get(user.id) ?? {
        keyType: "company" as const,
        needsReconnect: false,
      };
      const keyType = keyResolution.keyType;
      const deactivated = user.deactivatedAt != null;
      const budgetConfigured = Boolean(budget?.configured) || monthlyCap != null;
      const pendingSharedBudgetApproval =
        budgetConfigured &&
        !memberIds.has(user.id) &&
        !deactivated &&
        notEnrolledHitIds.has(user.id) &&
        keyType !== "personal";
      accounts.push({
        userId: user.id,
        email: user.email,
        name: user.name,
        deactivated,
        modelProvider: model?.provider ?? null,
        modelId: model?.model ?? null,
        modelSource: model?.source,
        keyType,
        needsReconnect: keyResolution.needsReconnect,
        totalTokens: usage?.totalTokens ?? null,
        totalCostUsd: usage?.totalCostUsd ?? null,
        sharedKeyCostUsd: sharedByUserMap.get(user.id) ?? 0,
        personalKeyCostUsd: personalByUser.get(user.id) ?? 0,
        sharedKeyBudget: budget,
        pendingSharedBudgetApproval,
        envPinned: envPinnedIds.has(user.id),
        allotmentOverrideUsd: overrideByUser.get(user.id) ?? null,
      });
    }
    const visibleBots = bots.filter((bot) => !hiddenUserIds.has(bot.userId));
    const activeBots = visibleBots.filter((bot) => bot.archivedAt == null);
    const adminGrants = (await listAdminGrants(prisma, options.envBootstrapAdmins ?? [])).filter(
      (grant) => !isHiddenOpsEmail(grant.email),
    );
    // Also surface env bootstrap admins that have no DB grant row yet.
    for (const email of options.envBootstrapAdmins ?? []) {
      if (isHiddenOpsEmail(email)) continue;
      if (adminGrants.some((grant) => grant.email.toLowerCase() === email.toLowerCase())) continue;
      const bootstrap = visibleUsers.find(
        (user) => user.email.toLowerCase() === email.toLowerCase(),
      );
      if (!bootstrap) continue;
      adminGrants.unshift({
        userId: bootstrap.id,
        email: bootstrap.email,
        name: bootstrap.name,
        grantedById: bootstrap.id,
        grantedByEmail: null,
        createdAt: new Date(0).toISOString(),
        envBootstrap: true,
      });
    }
    const firstResponses: number[] = [];
    const totals: number[] = [];
    let errorCount = 0;
    const visibleRuns = recentRuns.filter((run) => !hiddenUserIds.has(run.userId));
    for (const run of visibleRuns) {
      if (run.error || run.status === "failed") errorCount += 1;
      const origin = run.sourceMessage?.createdAt ?? run.createdAt;
      if (run.firstResponseAt) {
        firstResponses.push(Math.max(0, run.firstResponseAt.getTime() - origin.getTime()));
      }
      if (run.completedAt) {
        totals.push(Math.max(0, run.completedAt.getTime() - origin.getTime()));
      }
    }
    firstResponses.sort((a, b) => a - b);
    totals.sort((a, b) => a - b);

    const sharedKeyCostUsd = accounts.reduce((sum, row) => sum + row.sharedKeyCostUsd, 0);
    const personalKeyCostUsd = accounts.reduce((sum, row) => sum + row.personalKeyCostUsd, 0);
    // Exclude hidden-account usage from the team week total. Team-wide adjustments
    // (userId null) remain in weekSpentUsd from trackedSharedKeyTeamSpendUsd.
    let hiddenWeekShared = 0;
    if (hiddenUserIds.size > 0) {
      const hiddenTracked = await trackedSharedKeySpendByUser(prisma, {
        userIds: [...hiddenUserIds],
        since: periodStart,
        until: now,
        periodStart,
      });
      for (const value of hiddenTracked.values()) hiddenWeekShared += value;
    }
    const visibleWeekSpentUsd = Math.max(0, weekSpentUsd - hiddenWeekShared);

    return {
      accounts,
      agents: {
        total: visibleBots.length,
        active: activeBots.length,
        names: activeBots.map((bot) => ({
          id: bot.id,
          name: bot.name,
          userId: bot.userId,
        })),
      },
      spend: {
        totalCostUsd: sumNullable(accounts.map((row) => row.totalCostUsd)),
        sharedKeyCostUsd,
        personalKeyCostUsd,
        totalTokens: sumNullable(accounts.map((row) => row.totalTokens)),
      },
      sharedKeyBudget: {
        monthlyCapUsd: monthlyCap,
        rosterConfigured: members.length > 0 || monthlyCap != null,
        memberCount: members.length,
        weekPoolUsd:
          monthlyCap != null && monthlyCap > 0
            ? schedule.period === "month"
              ? monthlyCap
              : monthlyCap / 4
            : null,
        weekSpentUsd: visibleWeekSpentUsd,
        weekStartsAt: periodStart.toISOString(),
        resetsAt: periodEnd.toISOString(),
        timezone: schedule.timezone,
        settings: settingsView,
      },
      performance: {
        sampleWindowHours: 24 * 7,
        runCount: visibleRuns.length,
        errorCount,
        errorRate: visibleRuns.length > 0 ? errorCount / visibleRuns.length : null,
        medianFirstResponseMs: median(firstResponses),
        medianTotalMs: median(totals),
        p95FirstResponseMs: percentile(firstResponses, 95),
      },
      health: {
        database,
        degraded: health.degraded === true || database === "unreachable",
        revision: health.revision ?? null,
        runtime: health.runtime ?? null,
        sandbox: health.sandbox ?? null,
      },
      adminGrants,
      envBootstrapAdmins: (options.envBootstrapAdmins ?? []).filter(
        (email) => !isHiddenOpsEmail(email),
      ),
      allotmentTransfers,
      spendAdjustments,
    };
  });
}

/**
 * Org-scoped team drill-down: overview account fields for members of `organizationId`,
 * plus per-member agent counts and aggregate spend/agents.
 */
export async function loadOpsTeam(
  prisma: OpsDashboardPrisma,
  organizationId: string,
  health: {
    degraded?: boolean;
    revision?: string | null;
    runtime?: string | null;
    sandbox?: string | null;
  } = {},
  envSharedKeyMonthlyBudgetUsd?: number | null,
  options: {
    secrets?: SecretStore;
    deploymentModelKey?: string | null;
    envBootstrapAdmins?: string[];
  } = {},
): Promise<OpsTeam> {
  const org = await runAsSystem("operations dashboard team org", async () =>
    prisma.organization.findUnique({
      where: { id: organizationId },
      select: {
        id: true,
        name: true,
        members: { select: { userId: true } },
      },
    }),
  );
  if (!org) throw new Error("Organization not found");

  // Personal orgs are sole-member bootstrap spaces — same rule as assertNonPersonalOrganization.
  const uniqueMemberIds = new Set(org.members.map((member) => member.userId));
  if (uniqueMemberIds.size <= 1) throw new Error("Organization not found");

  const memberIds = uniqueMemberIds;
  const [overview, bots] = await Promise.all([
    loadOpsOverview(prisma, health, undefined, envSharedKeyMonthlyBudgetUsd, options),
    listOpsAgents(prisma, {
      secrets: options.secrets,
      deploymentModelKey: options.deploymentModelKey,
    }),
  ]);

  const memberAccounts = overview.accounts.filter((account) => memberIds.has(account.userId));
  const memberBots = bots.filter((bot) => bot.owner && memberIds.has(bot.owner.id));
  const activeBots = memberBots.filter((bot) => bot.status === "active");
  const members: OpsTeamMemberRow[] = memberAccounts.map((account) => ({
    ...account,
    agentCount: memberBots.filter((bot) => bot.owner?.id === account.userId).length,
  }));

  return {
    organizationId: org.id,
    organizationName: org.name,
    memberCount: members.length,
    members,
    agents: {
      total: memberBots.length,
      active: activeBots.length,
      names: activeBots.map((bot) => ({
        id: bot.id,
        name: bot.name,
        userId: bot.owner!.id,
      })),
    },
    spend: {
      totalCostUsd: sumNullable(members.map((row) => row.totalCostUsd)),
      sharedKeyCostUsd: members.reduce((sum, row) => sum + row.sharedKeyCostUsd, 0),
      personalKeyCostUsd: members.reduce((sum, row) => sum + row.personalKeyCostUsd, 0),
      totalTokens: sumNullable(members.map((row) => row.totalTokens)),
    },
  };
}

/** Organizations for the ops nav switcher (id, name, member count). Sole-member Personal orgs are omitted. */
export async function listOpsOrganizations(
  prisma: OpsDashboardPrisma,
): Promise<OpsOrganizationNavRow[]> {
  return runAsSystem("operations dashboard organizations", async () => {
    const organizations = await prisma.organization.findMany({
      select: {
        id: true,
        name: true,
        _count: { select: { members: true } },
      },
      orderBy: [{ name: "asc" }, { id: "asc" }],
    });
    return organizations
      .filter((organization) => organization._count.members > 1)
      .map((organization) => ({
        id: organization.id,
        name: organization.name,
        memberCount: organization._count.members,
      }));
  });
}

/** Cross-account agent roster with owner + last-active. Caller must enforce admin + LAN. */
export async function listOpsAgents(
  prisma: OpsDashboardPrisma,
  options: {
    secrets?: SecretStore;
    deploymentModelKey?: string | null;
  } = {},
): Promise<OpsAgentRow[]> {
  return runAsSystem("operations dashboard agents", async () => {
    const bots = await prisma.bot.findMany({
      select: {
        id: true,
        name: true,
        userId: true,
        spaceId: true,
        createdAt: true,
        archivedAt: true,
      },
      orderBy: [{ archivedAt: "asc" }, { name: "asc" }],
    });
    const botIds = bots.map((bot) => bot.id);
    const ownerIds = [...new Set(bots.map((bot) => bot.userId))];
    const [users, lastActiveGroups] = await Promise.all([
      ownerIds.length === 0
        ? Promise.resolve(
            [] as Array<{
              id: string;
              email: string;
              name: string;
              deactivatedAt: Date | null;
            }>,
          )
        : prisma.user.findMany({
            where: { id: { in: ownerIds } },
            select: { id: true, email: true, name: true, deactivatedAt: true },
          }),
      botIds.length === 0
        ? Promise.resolve([] as Array<{ botId: string; _max: { createdAt: Date | null } }>)
        : prisma.run.groupBy({
            by: ["botId"],
            where: { botId: { in: botIds } },
            _max: { createdAt: true },
          }),
    ]);
    const userById = new Map(users.map((user) => [user.id, user]));
    const hiddenUsers = new Set(
      users.filter((user) => isHiddenOpsEmail(user.email)).map((user) => user.id),
    );
    const lastActiveByBot = new Map(
      lastActiveGroups.map((row) => [
        row.botId,
        row._max.createdAt ? row._max.createdAt.toISOString() : null,
      ]),
    );
    const visibleOwners = users.filter((user) => !hiddenUsers.has(user.id));
    const spaceByUser = await loadOpsSpaceByUser(
      prisma,
      visibleOwners.map((user) => user.id),
    );
    const keyByOwner = await resolveOpsModelKeyTypes(
      prisma,
      visibleOwners.map((user) => ({
        userId: user.id,
        spaceId: spaceByUser.get(user.id) ?? user.id,
      })),
      {
        secrets: options.secrets,
        deploymentModelKey: options.deploymentModelKey,
      },
    );
    return bots
      .filter((bot) => !hiddenUsers.has(bot.userId))
      .map((bot) => {
        const user = userById.get(bot.userId);
        const owner: OpsAgentOwner | null = user
          ? {
              id: user.id,
              name: user.name,
              email: user.email,
              deactivated: user.deactivatedAt != null,
            }
          : null;
        const key = owner
          ? (keyByOwner.get(owner.id) ?? { keyType: "company" as const, needsReconnect: false })
          : { keyType: "company" as const, needsReconnect: false };
        return {
          id: bot.id,
          name: bot.name,
          createdAt: bot.createdAt.toISOString(),
          lastActiveAt: lastActiveByBot.get(bot.id) ?? null,
          status: bot.archivedAt != null ? ("archived" as const) : ("active" as const),
          owner,
          keyType: key.keyType,
          needsReconnect: key.needsReconnect,
        };
      });
  });
}

export async function listOpsRequestLog(
  prisma: OpsDashboardPrisma,
  input: { before?: string; limit?: number; userId?: string } = {},
): Promise<OpsRequestLogRow[]> {
  return runAsSystem("operations dashboard request log", async () => {
    const limit = Math.min(Math.max(input.limit ?? REQUEST_LOG_DEFAULT_LIMIT, 1), 100);
    const before = input.before ? new Date(input.before) : undefined;
    const usageWhere = {
      ...(input.userId ? { userId: input.userId } : {}),
      ...(before ? { createdAt: { lt: before } } : {}),
    };
    const runWhere = {
      ...(input.userId ? { userId: input.userId } : {}),
      ...(before ? { createdAt: { lt: before } } : {}),
    };

    const [usageRows, runs, botNames] = await Promise.all([
      prisma.usageRecord.findMany({
        where: usageWhere,
        orderBy: { createdAt: "desc" },
        take: limit,
        select: {
          id: true,
          userId: true,
          botId: true,
          runId: true,
          provider: true,
          model: true,
          sharedKey: true,
          inputTokens: true,
          outputTokens: true,
          totalTokens: true,
          costUsd: true,
          createdAt: true,
        },
      }),
      prisma.run.findMany({
        where: runWhere,
        orderBy: { createdAt: "desc" },
        take: limit,
        select: {
          id: true,
          userId: true,
          botId: true,
          threadId: true,
          status: true,
          error: true,
          modelProvider: true,
          modelId: true,
          createdAt: true,
          startedAt: true,
          firstResponseAt: true,
          completedAt: true,
          sourceMessage: { select: { createdAt: true } },
        },
      }),
      prisma.bot.findMany({
        select: { id: true, name: true },
      }),
    ]);

    const names = new Map(botNames.map((bot) => [bot.id, bot.name]));
    const userIds = [
      ...new Set([...usageRows.map((row) => row.userId), ...runs.map((run) => run.userId)]),
    ];
    const users = await prisma.user.findMany({
      where: { id: { in: userIds } },
      select: { id: true, email: true },
    });
    const hiddenUsers = new Set(
      users.filter((user) => isHiddenOpsEmail(user.email)).map((user) => user.id),
    );
    const fromUsage: OpsRequestLogRow[] = usageRows
      .filter((row) => !hiddenUsers.has(row.userId))
      .map((row) => ({
        id: `usage:${row.id}`,
        kind: "usage",
        userId: row.userId,
        botId: row.botId,
        botName: row.botId ? (names.get(row.botId) ?? null) : null,
        runId: row.runId,
        threadId: null,
        provider: row.provider,
        model: row.model,
        sharedKey: row.sharedKey,
        inputTokens: row.inputTokens,
        outputTokens: row.outputTokens,
        totalTokens: row.totalTokens,
        costUsd: row.costUsd,
        status: null,
        error: null,
        firstResponseMs: null,
        totalMs: null,
        createdAt: row.createdAt.toISOString(),
      }));

    const fromRuns: OpsRequestLogRow[] = runs
      .filter((run) => !hiddenUsers.has(run.userId))
      .map((run) => {
        const origin = run.sourceMessage?.createdAt ?? run.createdAt;
        return {
          id: `run:${run.id}`,
          kind: "run" as const,
          userId: run.userId,
          botId: run.botId,
          botName: names.get(run.botId) ?? null,
          runId: run.id,
          threadId: run.threadId,
          provider: run.modelProvider,
          model: run.modelId,
          sharedKey: null,
          inputTokens: null,
          outputTokens: null,
          totalTokens: null,
          costUsd: null,
          status: run.status,
          // Admins on LAN may see the run error string; never returned without the gate.
          error: run.error,
          firstResponseMs: run.firstResponseAt
            ? Math.max(0, run.firstResponseAt.getTime() - origin.getTime())
            : null,
          totalMs: run.completedAt
            ? Math.max(0, run.completedAt.getTime() - origin.getTime())
            : null,
          createdAt: run.createdAt.toISOString(),
        };
      });

    return [...fromUsage, ...fromRuns]
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit);
  });
}

export async function loadOpsChatLog(
  prisma: OpsDashboardPrisma,
  input: { runId?: string; threadId?: string; before?: string; limit?: number },
): Promise<{
  threadId: string;
  runId: string | null;
  messages: OpsChatLogMessage[];
}> {
  return runAsSystem("operations dashboard chat log", async () => {
    if (!input.runId && !input.threadId) {
      throw new Error("runId or threadId required");
    }
    const limit = Math.min(Math.max(input.limit ?? CHAT_LOG_DEFAULT_LIMIT, 1), 200);
    let threadId = input.threadId ?? null;
    let runId = input.runId ?? null;

    let sourceMessageId: string | null = null;
    if (runId) {
      const run = await prisma.run.findUnique({
        where: { id: runId },
        select: { id: true, threadId: true, sourceMessageId: true },
      });
      if (!run) throw new Error("Run not found");
      threadId = run.threadId;
      runId = run.id;
      sourceMessageId = run.sourceMessageId;
    }

    if (!threadId) throw new Error("Thread not found");

    const before = input.before ? new Date(input.before) : undefined;
    const messages = await prisma.message.findMany({
      where: {
        threadId,
        ...(runId
          ? {
              OR: [{ runId }, ...(sourceMessageId ? [{ id: sourceMessageId }] : [])],
            }
          : {}),
        ...(before ? { createdAt: { lt: before } } : {}),
      },
      orderBy: { seq: "asc" },
      take: limit,
      select: {
        id: true,
        role: true,
        seq: true,
        runId: true,
        blocks: true,
        createdAt: true,
      },
    });

    return {
      threadId,
      runId,
      messages: messages.map((message) => ({
        id: message.id,
        role: message.role,
        seq: message.seq,
        runId: message.runId,
        text: messageText(message.blocks),
        createdAt: message.createdAt.toISOString(),
      })),
    };
  });
}
