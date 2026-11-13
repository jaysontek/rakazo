import { I18nProvider } from "@lingui/react";
import type { OpsOverview, OpsRequestLogRow } from "@rakazo/contracts";
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
      keyType: "company",
      totalTokens: 1_240_000,
      totalCostUsd: 18.4,
      sharedKeyCostUsd: 18.4,
      personalKeyCostUsd: 0,
      sharedKeyBudget: {
        configured: true,
        member: true,
        weeklyCapUsd: 25,
        spentUsd: 12.5,
        reservedUsd: 0,
        remainingUsd: 12.5,
        percentUsed: 50,
        hardStopped: false,
        weekStartsAt: weekStart,
        resetsAt,
        timezone: "America/New_York",
      },
    },
    {
      userId: "user_sam",
      email: "sam@example.test",
      name: "Sam Chen",
      deactivated: false,
      modelProvider: "google",
      modelId: "gemini-2.5-flash",
      keyType: "company",
      totalTokens: 880_000,
      totalCostUsd: 9.1,
      sharedKeyCostUsd: 9.1,
      personalKeyCostUsd: 0,
      sharedKeyBudget: {
        configured: true,
        member: true,
        weeklyCapUsd: 25,
        spentUsd: 22,
        reservedUsd: 0,
        remainingUsd: 3,
        percentUsed: 88,
        hardStopped: false,
        weekStartsAt: weekStart,
        resetsAt,
        timezone: "America/New_York",
      },
    },
    {
      userId: "user_jordan",
      email: "jordan@example.test",
      name: "Jordan Lee",
      deactivated: false,
      modelProvider: "openai",
      modelId: "gpt-4.1",
      keyType: "personal",
      totalTokens: 420_000,
      totalCostUsd: 31.2,
      sharedKeyCostUsd: 0,
      personalKeyCostUsd: 31.2,
      sharedKeyBudget: null,
    },
    {
      userId: "user_casey",
      email: "casey@example.test",
      name: "Casey Ng",
      deactivated: false,
      modelProvider: "google",
      modelId: "gemini-2.5-pro",
      keyType: "company",
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
        hardStopped: true,
        weekStartsAt: weekStart,
        resetsAt,
        timezone: "America/New_York",
      },
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
  },
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
            interactive={false}
          />
        </div>
      </main>
    </div>
  );
}

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false } },
});

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
