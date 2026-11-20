// @vitest-environment jsdom

import type { ModelCatalogEntry, OpsTeam } from "@rakazo/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("@lingui/core/macro", () => ({
  t: (strings: TemplateStringsArray, ...values: unknown[]) =>
    strings.flatMap((part, index) => [part, values[index] ?? ""]).join(""),
  plural: (count: number, forms: { one: string; other: string }) =>
    (count === 1 ? forms.one : forms.other).replace("#", String(count)),
}));

vi.mock("@lingui/react/macro", () => {
  const t = (strings: TemplateStringsArray, ...values: unknown[]) =>
    strings.flatMap((part, index) => [part, values[index] ?? ""]).join("");
  return {
    useLingui: () => ({ t, i18n: { locale: "en" } }),
    Trans: ({ children }: { children?: ReactNode }) => children,
  };
});

const { teamRpc, modelsListRpc } = vi.hoisted(() => ({
  teamRpc: vi.fn(),
  modelsListRpc: vi.fn(),
}));

vi.mock("@rakazo/ui-web", () => {
  const Pass = ({ children, ...props }: { children?: ReactNode } & Record<string, unknown>) => (
    <div {...props}>{children}</div>
  );
  return {
    Badge: ({ children, className, title }: ComponentProps<"span">) => (
      <span className={className} title={title}>
        {children}
      </span>
    ),
    Card: Pass,
    CardDescription: ({ children }: { children?: ReactNode }) => <p>{children}</p>,
    CardHeader: Pass,
    CardTitle: ({ children, className }: ComponentProps<"h3">) => (
      <h3 className={className}>{children}</h3>
    ),
    Spinner: () => <span>loading</span>,
    buttonVariants: () => "",
    cn: (...values: unknown[]) => values.filter(Boolean).join(" "),
  };
});

vi.mock("../lib/rpc", () => ({
  rpc: {
    ops: {
      team: (...args: unknown[]) => teamRpc(...args),
      startImpersonation: vi.fn(),
      organizations: vi.fn(async () => []),
    },
    models: {
      list: (...args: unknown[]) => modelsListRpc(...args),
    },
  },
}));

vi.mock("../lib/impersonation-switch", () => ({
  hardSwitchImpersonation: vi.fn(),
}));

vi.mock("../lib/impersonation-teammates", () => ({
  storeImpersonationTeammates: vi.fn(),
}));

vi.mock("../lib/query", () => ({
  useSpaceQueries: () => ({
    me: {
      queryOptions: () => ({
        queryKey: ["me"],
        queryFn: async () => ({ id: "admin", isAdmin: true }),
      }),
      setData: vi.fn(),
    },
  }),
}));

vi.mock("./WindowChrome", () => ({ WindowChrome: () => null }));

import { TeamDashboard } from "./AdminOpsTeamPage";

const catalog: ModelCatalogEntry[] = [
  {
    provider: "google",
    id: "gemini-2.5-pro",
    label: "Friendly Pro",
    providerName: "Google",
    billing: "pay-as-you-go",
  },
];

const team: OpsTeam = {
  organizationId: "org_1",
  organizationName: "Acme",
  memberCount: 1,
  members: [
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

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  teamRpc.mockReset();
  modelsListRpc.mockReset();
  teamRpc.mockResolvedValue(team);
  modelsListRpc.mockResolvedValue(catalog);
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
});

it("TeamDashboard passes catalog so ModelBadge shows a friendly label", async () => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  queryClient.setQueryData(["ops", "team", "org_1"], team);
  queryClient.setQueryData(["models", "list"], catalog);
  await act(async () => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <TeamDashboard organizationId="org_1" />
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
  await vi.waitFor(() => {
    expect(container.textContent).toContain("Friendly Pro");
  });
  expect(container.textContent).toContain("Google");
  expect(container.textContent).not.toContain("gemini-2.5-pro");
});
