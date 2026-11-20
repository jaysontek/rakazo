import { I18nProvider } from "@lingui/react";
import type { OpsAgent, OpsOverview, OpsRequestLogRow } from "@rakazo/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { bootstrapI18n, i18n } from "../../src/lib/i18n";
import { applyResolvedAppearance } from "../../src/lib/ui-appearance";
import { OpsDashboardView } from "../../src/pages/AdminOpsPage";
import { WindowChrome } from "../../src/pages/WindowChrome";
import "../../src/styles.css";

const params = new URLSearchParams(location.search);
const theme = params.get("theme") === "light" ? "light" : "dark";
applyResolvedAppearance(theme);

const weekStart = "2026-11-09T05:00:00.000Z";
const resetsAt = "2026-11-16T05:00:00.000Z";

const fixtureOverview: OpsOverview = {
  accounts: [
    {
      userId: "user_alex",
      email: "alex@example.test",
      name: "Alex Rivera",
      deactivated: false,
      modelProvider: "google",
      modelId: "gemini-2.5-pro",
      modelSource: "last used",
      keyType: "company",
      needsReconnect: false,
      totalTokens: 1_240_000,
      totalCostUsd: 18.4,
      sharedKeyCostUsd: 18.4,
      personalKeyCostUsd: 0,
      sharedKeyBudget: {
        configured: true,
        member: true,
        weeklyCapUsd: 25,
        spentUsd: 12.5,
        reservedUsd: 0.5,
        remainingUsd: 12,
        percentUsed: 52,
        reservedPercent: 2,
        hardStopped: false,
        status: "ok",
        weekStartsAt: weekStart,
        resetsAt,
        timezone: "America/New_York",
        hardStopEnabled: true,
        warningThresholds: [80, 95],
      },
      pendingSharedBudgetApproval: false,
      envPinned: true,
      allotmentOverrideUsd: null,
    },
    {
      userId: "user_sam",
      email: "sam@example.test",
      name: "Sam Chen",
      deactivated: true,
      modelProvider: "google",
      modelId: "gemini-2.5-flash",
      modelSource: "last used",
      keyType: "company",
      needsReconnect: false,
      totalTokens: 880_000,
      totalCostUsd: 9.1,
      sharedKeyCostUsd: 9.1,
      personalKeyCostUsd: 0,
      sharedKeyBudget: {
        configured: true,
        member: false,
        weeklyCapUsd: 0,
        spentUsd: 22,
        reservedUsd: 0,
        remainingUsd: 3,
        percentUsed: 88,
        reservedPercent: 0,
        hardStopped: false,
        status: "warning",
        weekStartsAt: weekStart,
        resetsAt,
        timezone: "America/New_York",
        hardStopEnabled: true,
        warningThresholds: [80, 95],
      },
      pendingSharedBudgetApproval: false,
      envPinned: false,
      allotmentOverrideUsd: null,
      deletionRequestedAt: "2026-11-01T00:00:00.000Z",
      purgeAfter: "2026-12-01T00:00:00.000Z",
    },
    {
      userId: "user_jordan",
      email: "jordan@example.test",
      name: "Jordan Lee",
      deactivated: false,
      modelProvider: "openai",
      modelId: "gpt-4.1",
      modelSource: "configured",
      keyType: "personal",
      needsReconnect: false,
      totalTokens: 420_000,
      totalCostUsd: 31.2,
      sharedKeyCostUsd: 0,
      personalKeyCostUsd: 31.2,
      sharedKeyBudget: null,
      pendingSharedBudgetApproval: false,
      envPinned: false,
      allotmentOverrideUsd: null,
    },
    {
      userId: "user_casey",
      email: "casey@example.test",
      name: "Casey Ng",
      deactivated: false,
      modelProvider: "google",
      modelId: "gemini-2.5-pro",
      modelSource: "last used",
      keyType: "company",
      needsReconnect: false,
      totalTokens: 2_100_000,
      totalCostUsd: 41.0,
      sharedKeyCostUsd: 41.0,
      personalKeyCostUsd: 0,
      sharedKeyBudget: {
        configured: true,
        member: true,
        weeklyCapUsd: 25,
        spentUsd: 25,
        reservedUsd: 0,
        remainingUsd: 0,
        percentUsed: 100,
        reservedPercent: 0,
        hardStopped: true,
        status: "blocked",
        weekStartsAt: weekStart,
        resetsAt,
        timezone: "America/New_York",
        hardStopEnabled: true,
        warningThresholds: [80, 95],
      },
      pendingSharedBudgetApproval: false,
      envPinned: false,
      allotmentOverrideUsd: null,
    },
    {
      userId: "user_riley",
      email: "riley@example.test",
      name: "Riley Ortiz",
      deactivated: false,
      modelProvider: "google",
      modelId: "gemini-3.8-flash",
      modelSource: "default",
      // Typical shared-key user: no stored personal key (deployment default), not enrolled.
      keyType: "company",
      needsReconnect: false,
      totalTokens: 12_000,
      totalCostUsd: 0.4,
      sharedKeyCostUsd: 0.4,
      personalKeyCostUsd: 0,
      sharedKeyBudget: {
        configured: true,
        member: false,
        weeklyCapUsd: 0,
        spentUsd: 0,
        reservedUsd: 0,
        remainingUsd: 0,
        percentUsed: 0,
        reservedPercent: 0,
        hardStopped: false,
        status: "ok",
        weekStartsAt: weekStart,
        resetsAt,
        timezone: "America/New_York",
        hardStopEnabled: true,
        warningThresholds: [80, 95],
      },
      pendingSharedBudgetApproval: true,
      envPinned: false,
      allotmentOverrideUsd: null,
    },
  ],
  agents: {
    total: 6,
    active: 5,
    names: [
      { id: "bot_1", name: "Ops helper", userId: "user_alex" },
      { id: "bot_2", name: "Inbox triage", userId: "user_sam" },
      { id: "bot_3", name: "Research", userId: "user_jordan" },
      { id: "bot_4", name: "Support", userId: "user_casey" },
      { id: "bot_5", name: "Planning", userId: "user_alex" },
    ],
  },
  spend: {
    totalCostUsd: 99.7,
    sharedKeyCostUsd: 68.5,
    personalKeyCostUsd: 31.2,
    totalTokens: 4_640_000,
  },
  sharedKeyBudget: {
    monthlyCapUsd: 400,
    rosterConfigured: true,
    memberCount: 3,
    weekPoolUsd: 100,
    weekSpentUsd: 59.5,
    weekStartsAt: weekStart,
    resetsAt,
    timezone: "America/New_York",
    settings: {
      monthlyCapUsd: 400,
      monthlyCapSource: "db",
      period: "week",
      periodSource: "default",
      resetDow: 1,
      resetDowSource: "default",
      resetDom: 1,
      resetDomSource: "default",
      resetMinutes: 0,
      resetMinutesSource: "default",
      timezone: "America/New_York",
      timezoneSource: "db",
      weekStartsAt: weekStart,
      resetsAt,
      autoEnrollMode: "signup",
      autoEnrollModeSource: "default",
      warningThresholds: [80, 95],
      warningThresholdsSource: "default",
      hardStopEnabled: true,
      hardStopEnabledSource: "default",
      holdStaleMinutes: 30,
      holdStaleMinutesSource: "default",
      pruneInactive: true,
      pruneInactiveSource: "default",
      memberOverrides: [{ userId: "user_sam", weeklyAllotmentUsd: 30 }],
    },
  },
  spendAdjustments: [
    {
      id: "adj_1",
      periodStart: weekStart,
      periodEnd: "2026-11-16T05:00:00.000Z",
      scope: "team",
      userId: null,
      userIdSnapshot: null,
      deltaUsd: 5,
      reason: "Manual correction",
      createdById: "user_alex",
      createdByIdSnapshot: "user_alex",
      createdByEmailSnapshot: "alex@example.test",
      createdByEmail: "alex@example.test",
      createdByName: "Alex Rivera",
      createdAt: "2026-11-12T16:00:00.000Z",
      previousTrackedUsd: 54.5,
      newTrackedUsd: 59.5,
      reversesId: null,
    },
  ],
  performance: {
    sampleWindowHours: 168,
    runCount: 128,
    errorCount: 3,
    errorRate: 3 / 128,
    medianFirstResponseMs: 820,
    medianTotalMs: 4_200,
    p95FirstResponseMs: 2_400,
  },
  health: {
    database: "ok",
    degraded: false,
    revision: "fixture",
    runtime: "pi",
    sandbox: "docker",
  },
  adminGrants: [
    {
      userId: "user_alex",
      email: "alex@example.test",
      name: "Alex Rivera",
      grantedById: "user_alex",
      grantedByEmail: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      envBootstrap: true,
    },
    {
      userId: "user_sam",
      email: "sam@example.test",
      name: "Sam Chen",
      grantedById: "user_alex",
      grantedByEmail: "alex@example.test",
      createdAt: "2026-11-01T00:00:00.000Z",
      envBootstrap: false,
    },
  ],
  envBootstrapAdmins: ["alex@example.test"],
  allotmentTransfers: [
    {
      id: "xfer_1",
      weekStart,
      fromUserId: "user_alex",
      toUserId: "user_sam",
      amountUsd: 4.5,
      createdById: "user_alex",
      createdAt: "2026-11-12T15:00:00.000Z",
      reversedAt: null,
      reverseNote: null,
    },
  ],
};

const fixtureRequestLogRows: OpsRequestLogRow[] = [
  {
    id: "req_1",
    kind: "usage",
    userId: "user_alex",
    botId: "bot_1",
    botName: "Ops helper",
    runId: "run_1",
    threadId: "thread_1",
    provider: "google",
    model: "gemini-2.5-pro",
    sharedKey: true,
    inputTokens: 12_400,
    outputTokens: 3_200,
    totalTokens: 15_600,
    costUsd: 0.42,
    status: "ok",
    error: null,
    firstResponseMs: 640,
    totalMs: 3_100,
    createdAt: "2026-11-12T18:04:00.000Z",
  },
  {
    id: "req_2",
    kind: "run",
    userId: "user_sam",
    botId: "bot_2",
    botName: "Inbox triage",
    runId: "run_2",
    threadId: "thread_2",
    provider: "google",
    model: "gemini-2.5-flash",
    sharedKey: true,
    inputTokens: 4_800,
    outputTokens: 1_100,
    totalTokens: 5_900,
    costUsd: 0.08,
    status: "ok",
    error: null,
    firstResponseMs: 410,
    totalMs: 1_800,
    createdAt: "2026-11-12T17:51:00.000Z",
  },
  {
    id: "req_3",
    kind: "usage",
    userId: "user_jordan",
    botId: "bot_3",
    botName: "Research",
    runId: null,
    threadId: null,
    provider: "openai",
    model: "gpt-4.1",
    sharedKey: false,
    inputTokens: 22_000,
    outputTokens: 6_400,
    totalTokens: 28_400,
    costUsd: 1.15,
    status: "error",
    error: "rate_limited",
    firstResponseMs: null,
    totalMs: null,
    createdAt: "2026-11-12T16:20:00.000Z",
  },
];

const fixtureAgents: OpsAgent[] = [
  {
    id: "bot_1",
    name: "Ops helper",
    createdAt: "2026-01-10T00:00:00.000Z",
    lastActiveAt: "2026-11-12T18:00:00.000Z",
    status: "active",
    owner: {
      id: "user_alex",
      name: "Alex Rivera",
      email: "alex@example.test",
      deactivated: false,
    },
    keyType: "company",
    needsReconnect: false,
  },
  {
    id: "bot_5",
    name: "Planning",
    createdAt: "2026-02-01T00:00:00.000Z",
    lastActiveAt: "2026-11-11T10:00:00.000Z",
    status: "active",
    owner: {
      id: "user_alex",
      name: "Alex Rivera",
      email: "alex@example.test",
      deactivated: false,
    },
    keyType: "company",
    needsReconnect: false,
  },
  {
    id: "bot_2",
    name: "Inbox triage",
    createdAt: "2026-03-01T00:00:00.000Z",
    lastActiveAt: "2026-11-10T09:00:00.000Z",
    status: "active",
    owner: {
      id: "user_sam",
      name: "Sam Chen",
      email: "sam@example.test",
      deactivated: false,
    },
    keyType: "company",
    needsReconnect: false,
  },
  {
    id: "bot_3",
    name: "Research",
    createdAt: "2026-04-01T00:00:00.000Z",
    lastActiveAt: null,
    status: "archived",
    owner: {
      id: "user_jordan",
      name: "Jordan Lee",
      email: "jordan@example.test",
      deactivated: false,
    },
    keyType: "personal",
    needsReconnect: false,
  },
  {
    id: "bot_orphan",
    name: "Legacy orphan",
    createdAt: "2025-12-01T00:00:00.000Z",
    lastActiveAt: "2026-08-01T00:00:00.000Z",
    status: "active",
    owner: null,
    keyType: "company",
    needsReconnect: false,
  },
];

function Fixture() {
  const [selected, setSelected] = useState<OpsRequestLogRow | null>(null);
  return (
    <div className="flex min-h-screen flex-col bg-background text-foreground">
      <WindowChrome />
      <header className="border-b px-4 py-3">
        <h1 className="font-medium">Operations</h1>
      </header>
      <main className="flex-1 overflow-y-auto">
        <div className="w-full space-y-6 px-4 py-6 sm:px-6 lg:px-8">
          <OpsDashboardView
            data={fixtureOverview}
            onChanged={() => undefined}
            selected={selected}
            onSelect={setSelected}
            interactive={params.get("interactive") === "1"}
            fixtureAgents={fixtureAgents}
            fixtureRequestLogRows={fixtureRequestLogRows}
          />
        </div>
      </main>
    </div>
  );
}

const fixtureCatalog = [
  {
    provider: "google",
    id: "gemini-2.5-pro",
    label: "Gemini 2.5 Pro",
    providerName: "Google",
    billing: "pay-as-you-go",
  },
  {
    provider: "google",
    id: "gemini-2.5-flash",
    label: "Gemini 2.5 Flash",
    providerName: "Google",
    billing: "pay-as-you-go",
  },
  {
    provider: "openai",
    id: "gpt-4.1",
    label: "GPT-4.1",
    providerName: "OpenAI",
    billing: "pay-as-you-go",
  },
] as const;

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false } },
});
queryClient.setQueryData(["models", "list"], fixtureCatalog);

void bootstrapI18n("en").then(() => {
  createRoot(document.getElementById("root")!).render(
    <I18nProvider i18n={i18n}>
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <Fixture />
        </MemoryRouter>
      </QueryClientProvider>
    </I18nProvider>,
  );
});
