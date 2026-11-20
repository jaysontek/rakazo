import { I18nProvider } from "@lingui/react";
import type { UsageLimit, UsageSummary } from "@rakazo/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import { SharedKeyUsageMeter } from "../../src/components/SharedKeyUsageMeter";
import { bootstrapI18n, i18n } from "../../src/lib/i18n";
import { applyResolvedAppearance } from "../../src/lib/ui-appearance";
import { UsageSettingsPanel } from "../../src/pages/AccountSettingsOverlay";
import "../../src/styles.css";

const params = new URLSearchParams(location.search);
const theme = params.get("theme") === "light" ? "light" : "dark";
const view = params.get("view") === "popover" ? "popover" : "settings";
applyResolvedAppearance(theme);

const usageLimit: UsageLimit = {
  kind: "shared_weekly",
  percentUsed: 85,
  usedPercent: 85,
  reservedPercent: 0,
  spentPercent: 85,
  status: "blocked",
  resetsAt: "2026-11-16T05:00:00.000Z",
  timezone: "America/New_York",
};

const usage: UsageSummary = {
  runs: 42,
  inputTokens: 120_000,
  outputTokens: 48_000,
  totalTokens: 168_000,
  modelCalls: 90,
  models: [
    {
      provider: "google",
      model: "gemini-3.8-flash",
      inputTokens: 80_000,
      outputTokens: 30_000,
      totalTokens: 110_000,
      modelCalls: 60,
    },
    {
      provider: "openai",
      model: "gpt-4.1",
      inputTokens: 40_000,
      outputTokens: 18_000,
      totalTokens: 58_000,
      modelCalls: 30,
    },
  ],
  usageLimit,
};

function Fixture() {
  if (view === "popover") {
    return (
      <div className="flex min-h-screen items-end justify-start bg-background p-4 text-foreground">
        <div className="w-[295px] rounded-xl border border-border bg-popover p-1 shadow-md">
          <div className="mb-1 min-w-0 border-b border-border px-2.5 py-2.5">
            <p className="truncate text-sm font-medium">Alex Rivera</p>
            <p className="truncate text-xs text-muted-foreground">alex@example.test</p>
          </div>
          <SharedKeyUsageMeter limit={usageLimit} />
        </div>
      </div>
    );
  }
  return (
    <div className="min-h-screen bg-background p-4 text-foreground sm:p-8">
      <div className="mx-auto max-w-lg rounded-xl border border-border p-4">
        <h1 className="mb-4 text-lg font-medium">Usage</h1>
        <UsageSettingsPanel usage={usage} />
      </div>
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
        <Fixture />
      </QueryClientProvider>
    </I18nProvider>,
  );
});
