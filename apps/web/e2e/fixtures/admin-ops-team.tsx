import { I18nProvider } from "@lingui/react";
import type { OpsTeam } from "@rakazo/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { bootstrapI18n, i18n } from "../../src/lib/i18n";
import { applyResolvedAppearance } from "../../src/lib/ui-appearance";
import { TeamView } from "../../src/pages/AdminOpsTeamPage";
import "../../src/styles.css";

const params = new URLSearchParams(location.search);
const theme = params.get("theme") === "light" ? "light" : "dark";
applyResolvedAppearance(theme);

const fixtureTeam: OpsTeam = {
  organizationId: "org_1",
  organizationName: "Acme Robotics",
  memberCount: 1,
  members: [
    {
      userId: "user_alex",
      email: "alexandria.longname.rivera@example.test",
      name: "Alexandria Maximiliane Longname-Rivera of Acme Robotics International",
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
      sharedKeyBudget: null,
      pendingSharedBudgetApproval: false,
      envPinned: false,
      allotmentOverrideUsd: null,
      agentCount: 2,
    },
  ],
  agents: { total: 2, active: 1, names: [] },
  spend: {
    totalCostUsd: 18.4,
    sharedKeyCostUsd: 18.4,
    personalKeyCostUsd: 0,
    totalTokens: 1_240_000,
  },
};

const fixtureCatalog = [
  {
    provider: "google",
    id: "gemini-2.5-pro",
    label: "Gemini 2.5 Pro",
    providerName: "Google",
    billing: "pay-as-you-go",
  },
] as const;

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false } },
});

void bootstrapI18n("en").then(() => {
  createRoot(document.getElementById("root")!).render(
    <I18nProvider i18n={i18n}>
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <div className="bg-background p-4 text-foreground">
            <TeamView data={fixtureTeam} catalog={[...fixtureCatalog]} />
          </div>
        </MemoryRouter>
      </QueryClientProvider>
    </I18nProvider>,
  );
});
