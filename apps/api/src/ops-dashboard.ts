import { sharedKeyWeekEnd, sharedKeyWeekStart } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import {
  listSharedKeyBudgetMembers,
  runAsSystem,
  sharedKeyMonthlyBudgetUsd,
  sharedKeyWeeklyBudgetStatus,
} from "@rakazo/db";

const RECENT_RUN_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const LATENCY_SAMPLE_LIMIT = 500;
const REQUEST_LOG_DEFAULT_LIMIT = 50;
const CHAT_LOG_DEFAULT_LIMIT = 100;

export type OpsDashboardPrisma = PrismaClient;

export type OpsAccountRow = {
  userId: string;
  email: string;
  name: string;
  deactivated: boolean;
  modelProvider: string | null;
  modelId: string | null;
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
    hardStopped: boolean;
    weekStartsAt: string;
    resetsAt: string;
    timezone: "America/New_York";
  } | null;
};

export type OpsAgentRow = {
  id: string;
  name: string;
  userId: string;
  spaceId: string;
  modelProvider: string | null;
  modelId: string | null;
  archived: boolean;
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
    weekStartsAt: string;
    resetsAt: string;
    timezone: "America/New_York";
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
): Promise<OpsOverview> {
  return runAsSystem("operations dashboard overview", async () => {
    const weekAgo = new Date(now.getTime() - RECENT_RUN_WINDOW_MS);
    const [
      users,
      usageGroups,
      sharedUsageGroups,
      personalUsageGroups,
      recentModels,
      bots,
      recentRuns,
      monthlyCap,
      members,
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
        where: { sharedKey: true },
        _sum: { costUsd: true },
      }),
      prisma.usageRecord.groupBy({
        by: ["userId"],
        where: { sharedKey: false },
        _sum: { costUsd: true },
      }),
      prisma.usageRecord.findMany({
        select: { userId: true, provider: true, model: true, createdAt: true },
        orderBy: { createdAt: "desc" },
        take: 2_000,
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
      sharedKeyMonthlyBudgetUsd(prisma),
      listSharedKeyBudgetMembers(prisma),
      probeDatabase(prisma),
    ]);

    const usageByUser = new Map(
      usageGroups.map((row) => [
        row.userId,
        { totalTokens: row._sum.totalTokens, totalCostUsd: row._sum.costUsd },
      ]),
    );
    const sharedByUser = new Map(
      sharedUsageGroups.map((row) => [row.userId, row._sum.costUsd ?? 0]),
    );
    const personalByUser = new Map(
      personalUsageGroups.map((row) => [row.userId, row._sum.costUsd ?? 0]),
    );
    const latestModel = new Map<string, { provider: string; model: string }>();
    for (const row of recentModels) {
      if (!latestModel.has(row.userId)) {
        latestModel.set(row.userId, { provider: row.provider, model: row.model });
      }
    }

    const memberIds = new Set(members.map((member) => member.userId));
    const accounts: OpsAccountRow[] = [];
    for (const user of users) {
      const usage = usageByUser.get(user.id);
      const model = latestModel.get(user.id);
      let budget: OpsAccountRow["sharedKeyBudget"] = null;
      if (monthlyCap != null || memberIds.has(user.id)) {
        const status = await sharedKeyWeeklyBudgetStatus(prisma, user.id, now);
        const remainingUsd = Math.max(
          0,
          status.weeklyCapUsd - status.spentUsd - status.reservedUsd,
        );
        const hardStopped =
          status.enabled &&
          status.member &&
          status.weeklyCapUsd > 0 &&
          status.spentUsd + status.reservedUsd >= status.weeklyCapUsd;
        budget = {
          configured: status.enabled,
          member: status.member,
          weeklyCapUsd: status.weeklyCapUsd,
          spentUsd: status.spentUsd,
          reservedUsd: status.reservedUsd,
          remainingUsd,
          percentUsed: status.percentUsed,
          hardStopped,
          weekStartsAt: status.weekStartsAt,
          resetsAt: status.resetsAt,
          timezone: status.timezone,
        };
      }
      accounts.push({
        userId: user.id,
        email: user.email,
        name: user.name,
        deactivated: user.deactivatedAt != null,
        modelProvider: model?.provider ?? null,
        modelId: model?.model ?? null,
        totalTokens: usage?.totalTokens ?? null,
        totalCostUsd: usage?.totalCostUsd ?? null,
        sharedKeyCostUsd: sharedByUser.get(user.id) ?? 0,
        personalKeyCostUsd: personalByUser.get(user.id) ?? 0,
        sharedKeyBudget: budget,
      });
    }

    const activeBots = bots.filter((bot) => bot.archivedAt == null);
    const firstResponses: number[] = [];
    const totals: number[] = [];
    let errorCount = 0;
    for (const run of recentRuns) {
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

    const sharedKeyCostUsd = [...sharedByUser.values()].reduce((sum, value) => sum + value, 0);
    const personalKeyCostUsd = [...personalByUser.values()].reduce((sum, value) => sum + value, 0);
    const weekStart = sharedKeyWeekStart(now);
    const budgetWindow = {
      weekStartsAt: weekStart.toISOString(),
      resetsAt: sharedKeyWeekEnd(weekStart).toISOString(),
    };

    return {
      accounts,
      agents: {
        total: bots.length,
        active: activeBots.length,
        names: activeBots.map((bot) => ({
          id: bot.id,
          name: bot.name,
          userId: bot.userId,
        })),
      },
      spend: {
        totalCostUsd: sumNullable([...usageGroups.map((row) => row._sum.costUsd)]),
        sharedKeyCostUsd,
        personalKeyCostUsd,
        totalTokens: sumNullable(usageGroups.map((row) => row._sum.totalTokens)),
      },
      sharedKeyBudget: {
        monthlyCapUsd: monthlyCap,
        rosterConfigured: members.length > 0,
        memberCount: members.length,
        weekStartsAt: budgetWindow.weekStartsAt,
        resetsAt: budgetWindow.resetsAt,
        timezone: "America/New_York",
      },
      performance: {
        sampleWindowHours: 24 * 7,
        runCount: recentRuns.length,
        errorCount,
        errorRate: recentRuns.length > 0 ? errorCount / recentRuns.length : null,
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
    };
  });
}

export async function listOpsAgents(prisma: OpsDashboardPrisma): Promise<OpsAgentRow[]> {
  return runAsSystem("operations dashboard agents", async () => {
    const bots = await prisma.bot.findMany({
      select: {
        id: true,
        name: true,
        userId: true,
        spaceId: true,
        modelProvider: true,
        modelId: true,
        archivedAt: true,
      },
      orderBy: [{ archivedAt: "asc" }, { name: "asc" }],
    });
    return bots.map((bot) => ({
      id: bot.id,
      name: bot.name,
      userId: bot.userId,
      spaceId: bot.spaceId,
      modelProvider: bot.modelProvider,
      modelId: bot.modelId,
      archived: bot.archivedAt != null,
    }));
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
    const fromUsage: OpsRequestLogRow[] = usageRows.map((row) => ({
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

    const fromRuns: OpsRequestLogRow[] = runs.map((run) => {
      const origin = run.sourceMessage?.createdAt ?? run.createdAt;
      return {
        id: `run:${run.id}`,
        kind: "run",
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
        totalMs: run.completedAt ? Math.max(0, run.completedAt.getTime() - origin.getTime()) : null,
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
