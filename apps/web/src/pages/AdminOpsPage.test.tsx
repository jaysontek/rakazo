// @vitest-environment jsdom

import type { OpsAgent, OpsOverview, OpsRequestLogRow } from "@rakazo/contracts";
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

const { addSharedKeyBudgetMember, agentsRpc } = vi.hoisted(() => ({
  addSharedKeyBudgetMember: vi.fn(),
  agentsRpc: vi.fn(),
}));

vi.mock("@rakazo/ui-web", () => {
  const Pass = ({ children, ...props }: { children?: ReactNode } & Record<string, unknown>) => (
    <div {...props}>{children}</div>
  );
  const Button = ({
    children,
    onClick,
    disabled,
    className,
    ...props
  }: ComponentProps<"button"> & { variant?: string; size?: string }) => (
    <button type="button" disabled={disabled} onClick={onClick} className={className} {...props}>
      {children}
    </button>
  );
  return {
    AlertDialog: Pass,
    AlertDialogAction: Button,
    AlertDialogCancel: Button,
    AlertDialogContent: Pass,
    AlertDialogDescription: Pass,
    AlertDialogFooter: Pass,
    AlertDialogHeader: Pass,
    AlertDialogTitle: Pass,
    Badge: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
    Card: Pass,
    CardContent: Pass,
    CardDescription: Pass,
    CardHeader: Pass,
    CardTitle: Pass,
    Checkbox: ({
      checked,
      onCheckedChange,
      id,
      ...props
    }: {
      checked?: boolean;
      onCheckedChange?: (checked: boolean) => void;
      id?: string;
    } & ComponentProps<"input">) => (
      <input
        type="checkbox"
        id={id}
        checked={checked}
        onChange={(event) => onCheckedChange?.(event.target.checked)}
        {...props}
      />
    ),
    Collapsible: ({
      open,
      onOpenChange,
      children,
      ...props
    }: {
      open?: boolean;
      onOpenChange?: (open: boolean) => void;
      children?: ReactNode;
    } & Record<string, unknown>) => (
      <div data-open={open ? "true" : "false"} {...props}>
        {typeof children === "function" ? null : children}
        <button
          type="button"
          data-testid="collapsible-force-open"
          className="sr-only"
          onClick={() => onOpenChange?.(true)}
        />
      </div>
    ),
    CollapsibleContent: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
    CollapsibleTrigger: ({
      children,
      onClick,
      className,
      ...props
    }: ComponentProps<"button">) => (
      <button
        type="button"
        className={className}
        onClick={(event) => {
          onClick?.(event);
          const root = (event.currentTarget as HTMLElement).closest("[data-open]");
          const force = root?.querySelector<HTMLButtonElement>("[data-testid='collapsible-force-open']");
          force?.click();
        }}
        {...props}
      >
        {children}
      </button>
    ),
    DropdownMenu: Pass,
    DropdownMenuContent: Pass,
    DropdownMenuItem: ({
      children,
      onClick,
      disabled,
    }: ComponentProps<"button"> & { variant?: string }) => (
      <button type="button" role="menuitem" disabled={disabled} onClick={onClick}>
        {children}
      </button>
    ),
    DropdownMenuTrigger: ({ children, className, ...props }: ComponentProps<"button">) => (
      <button type="button" className={className} {...props}>
        {children}
      </button>
    ),
    Input: (props: ComponentProps<"input">) => <input {...props} />,
    ListSearchInput: ({
      query,
      setQuery,
      label,
      placeholder,
    }: {
      query: string;
      setQuery: (value: string) => void;
      label: string;
      placeholder: string;
    }) => (
      <input
        aria-label={label}
        placeholder={placeholder}
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />
    ),
    NativeSelect: (props: ComponentProps<"select">) => <select {...props} />,
    NativeSelectOption: (props: ComponentProps<"option">) => <option {...props} />,
    Spinner: () => <span>loading</span>,
    Switch: ({
      checked,
      onCheckedChange,
      id,
      ...props
    }: {
      checked?: boolean;
      onCheckedChange?: (checked: boolean) => void;
      id?: string;
    } & ComponentProps<"button">) => (
      <button
        type="button"
        role="switch"
        id={id}
        aria-checked={checked}
        onClick={() => onCheckedChange?.(!checked)}
        {...props}
      />
    ),
    Tabs: Pass,
    TabsContent: ({ children }: { children?: ReactNode; value?: string }) => <div>{children}</div>,
    TabsList: Pass,
    TabsTrigger: ({ children }: { children?: ReactNode; value?: string }) => (
      <button type="button">{children}</button>
    ),
    buttonVariants: () => "",
    cn: (...values: unknown[]) => values.filter(Boolean).join(" "),
  };
});

vi.mock("../lib/relative-time", () => ({ formatRelativeTime: () => "2d ago" }));

vi.mock("../lib/rpc", () => ({
  rpc: {
    ops: {
      addSharedKeyBudgetMember: (...args: unknown[]) => addSharedKeyBudgetMember(...args),
      overview: vi.fn(),
      agents: (...args: unknown[]) => agentsRpc(...args),
      requestLog: vi.fn(),
      chatLog: vi.fn(),
      setSharedKeyMonthlyBudget: vi.fn(),
      updateSharedKeyBudgetSettings: vi.fn(),
      setSharedKeyMemberOverride: vi.fn(),
      removeSharedKeyBudgetMember: vi.fn(),
      setSharedKeyTrackedSpend: vi.fn(),
      adjustSharedKeyTrackedSpend: vi.fn(),
      reverseSharedKeySpendAdjustment: vi.fn(),
      startImpersonation: vi.fn(),
      transferSharedKeyAllotment: vi.fn(),
      addAdminGrant: vi.fn(),
      removeAdminGrant: vi.fn(),
      reverseSharedKeyAllotmentTransfer: vi.fn(),
    },
  },
}));

vi.mock("../lib/query", () => ({
  useSpaceQueries: () => ({
    me: {
      queryOptions: () => ({ queryKey: ["me"], queryFn: async () => ({ id: "admin" }) }),
      setData: vi.fn(),
    },
  }),
}));

vi.mock("./WindowChrome", () => ({ WindowChrome: () => null }));

import { OpsDashboardView } from "./AdminOpsPage";

const weekStart = "2026-11-09T05:00:00.000Z";
const resetsAt = "2026-11-16T05:00:00.000Z";

const budgetSettings = {
  monthlyCapUsd: 400,
  monthlyCapSource: "db" as const,
  period: "week" as const,
  periodSource: "default" as const,
  resetDow: 1,
  resetDowSource: "default" as const,
  resetDom: 1,
  resetDomSource: "default" as const,
  resetMinutes: 0,
  resetMinutesSource: "default" as const,
  timezone: "America/New_York",
  timezoneSource: "db" as const,
  weekStartsAt: weekStart,
  resetsAt,
  autoEnrollMode: "signup" as const,
  autoEnrollModeSource: "default" as const,
  warningThresholds: [80, 95],
  warningThresholdsSource: "default" as const,
  hardStopEnabled: true,
  hardStopEnabledSource: "default" as const,
  holdStaleMinutes: 30,
  holdStaleMinutesSource: "default" as const,
  pruneInactive: true,
  pruneInactiveSource: "default" as const,
  memberOverrides: [] as Array<{ userId: string; weeklyAllotmentUsd: number }>,
};

const overview: OpsOverview = {
  accounts: [
    {
      userId: "user_pending",
      email: "pending@example.test",
      name: "Pending User",
      deactivated: false,
      modelProvider: "google",
      modelId: "gemini-2.5-flash",
      keyType: "company",
      needsReconnect: false,
      totalTokens: 100,
      totalCostUsd: 0.1,
      sharedKeyCostUsd: 0.1,
      personalKeyCostUsd: 0,
      sharedKeyBudget: {
        configured: true,
        member: false,
        weeklyCapUsd: 0,
        spentUsd: 0,
        reservedUsd: 0,
        remainingUsd: 0,
        percentUsed: 0,
        hardStopped: false,
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
  agents: { total: 0, active: 0, names: [] },
  spend: {
    totalCostUsd: 0.1,
    sharedKeyCostUsd: 0.1,
    personalKeyCostUsd: 0,
    totalTokens: 100,
  },
  sharedKeyBudget: {
    monthlyCapUsd: 400,
    rosterConfigured: true,
    memberCount: 0,
    weekPoolUsd: 100,
    weekSpentUsd: 0,
    weekStartsAt: weekStart,
    resetsAt,
    timezone: "America/New_York",
    settings: budgetSettings,
  },
  performance: {
    sampleWindowHours: 168,
    runCount: 0,
    errorCount: 0,
    errorRate: null,
    medianFirstResponseMs: null,
    medianTotalMs: null,
    p95FirstResponseMs: null,
  },
  health: {
    database: "ok",
    degraded: false,
    revision: "test",
    runtime: "pi",
    sandbox: "docker",
  },
  adminGrants: [],
  envBootstrapAdmins: [],
  allotmentTransfers: [],
  spendAdjustments: [
    {
      id: "adj_1",
      periodStart: weekStart,
      userId: null,
      deltaUsd: 2.5,
      reason: "Fixture correction",
      createdById: "user_admin",
      createdByEmail: "admin@example.test",
      createdByName: "Admin",
      createdAt: "2026-11-12T12:00:00.000Z",
      previousTrackedUsd: 0,
      newTrackedUsd: 2.5,
      reversesId: null,
    },
  ],
};

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  addSharedKeyBudgetMember.mockReset();
  agentsRpc.mockReset();
  agentsRpc.mockResolvedValue([]);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function renderDashboard(data: OpsOverview = overview, interactive = false) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  await act(async () => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <OpsDashboardView
            data={data}
            onChanged={() => undefined}
            selected={null as OpsRequestLogRow | null}
            onSelect={() => undefined}
            interactive={interactive}
          />
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
}

it("shows Add failure reason in the accounts section when enrolled is false", async () => {
  addSharedKeyBudgetMember.mockResolvedValue({ enrolled: false, reason: "ineligible" });
  await renderDashboard(overview, true);

  const addButton = Array.from(container.querySelectorAll('[role="menuitem"]')).find((node) =>
    node.textContent?.includes("Add to shared budget"),
  ) as HTMLButtonElement | undefined;
  expect(addButton).toBeTruthy();
  await act(async () => {
    addButton!.click();
  });
  await act(async () => {
    await Promise.resolve();
  });

  const alert = container.querySelector('[role="alert"]');
  expect(alert?.textContent).toBe("Not eligible for the shared budget");
  expect(addSharedKeyBudgetMember).toHaveBeenCalledWith({ userId: "user_pending" });
});

function accountFixture(
  overrides: Partial<OpsOverview["accounts"][number]> &
    Pick<OpsOverview["accounts"][number], "userId" | "email" | "name" | "keyType">,
): OpsOverview["accounts"][number] {
  return {
    deactivated: false,
    modelProvider: "google",
    modelId: "gemini-2.5-flash",
    needsReconnect: false,
    totalTokens: 10,
    totalCostUsd: 0.01,
    sharedKeyCostUsd: 0.01,
    personalKeyCostUsd: 0,
    sharedKeyBudget: null,
    pendingSharedBudgetApproval: false,
    envPinned: false,
    allotmentOverrideUsd: null,
    ...overrides,
  };
}

it("never renders an em dash for the Key column on desktop or mobile", async () => {
  const data: OpsOverview = {
    ...overview,
    accounts: [
      accountFixture({
        userId: "user_company",
        email: "company@example.test",
        name: "Company User",
        keyType: "company",
      }),
      accountFixture({
        userId: "user_personal",
        email: "personal@example.test",
        name: "Personal User",
        keyType: "personal",
        sharedKeyCostUsd: 0,
        personalKeyCostUsd: 0.01,
      }),
      accountFixture({
        userId: "user_reconnect",
        email: "reconnect@example.test",
        name: "Reconnect User",
        keyType: "personal",
        needsReconnect: true,
        sharedKeyCostUsd: 0,
        personalKeyCostUsd: 0,
      }),
    ],
  };
  await renderDashboard(data, true);

  const desktopRows = Array.from(container.querySelectorAll("table tbody tr"));
  expect(desktopRows).toHaveLength(3);
  for (const row of desktopRows) {
    const keyCell = row.querySelectorAll("td")[1];
    expect(keyCell?.textContent).not.toContain("—");
    expect(
      keyCell?.textContent?.includes("Company API") ||
        keyCell?.textContent?.includes("Personal API") ||
        keyCell?.textContent?.includes("Company key — pending admin approval"),
    ).toBe(true);
  }
  expect(desktopRows[0]?.querySelectorAll("td")[1]?.textContent).toContain("Company API");
  expect(desktopRows[1]?.querySelectorAll("td")[1]?.textContent).toContain("Personal API");
  expect(desktopRows[2]?.querySelectorAll("td")[1]?.textContent).toContain("Personal API");
  expect(desktopRows[2]?.querySelectorAll("td")[1]?.textContent).toContain("Reconnect");

  const mobileCards = Array.from(container.querySelectorAll("ul.grid li"));
  expect(mobileCards).toHaveLength(3);
  expect(mobileCards[0]?.textContent).toContain("Company API");
  expect(mobileCards[1]?.textContent).toContain("Personal API");
  expect(mobileCards[2]?.textContent).toContain("Personal API");
  expect(mobileCards[2]?.textContent).toContain("Reconnect");
});

function agentFixture(overrides: Partial<OpsAgent> & Pick<OpsAgent, "id" | "name">): OpsAgent {
  return {
    createdAt: "2026-01-01T00:00:00.000Z",
    lastActiveAt: "2026-11-10T12:00:00.000Z",
    status: "active",
    owner: {
      id: "user_alex",
      name: "Alex Rivera",
      email: "alex@example.test",
      deactivated: false,
    },
    keyType: "company",
    needsReconnect: false,
    ...overrides,
  };
}

const fixtureAgents: OpsAgent[] = [
  agentFixture({ id: "bot_alex", name: "Ops helper" }),
  agentFixture({
    id: "bot_sam",
    name: "Inbox triage",
    owner: {
      id: "user_sam",
      name: "Sam Chen",
      email: "sam@example.test",
      deactivated: false,
    },
    keyType: "personal",
  }),
  agentFixture({
    id: "bot_orphan",
    name: "Orphan agent",
    owner: null,
    lastActiveAt: null,
  }),
  agentFixture({
    id: "bot_gone",
    name: "Retired bot",
    owner: {
      id: "user_gone",
      name: "Gone User",
      email: "gone@example.test",
      deactivated: true,
    },
  }),
];

it("groups agents by owner, shows the orphan group, and filters by owner", async () => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  await act(async () => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <OpsDashboardView
            data={overview}
            onChanged={() => undefined}
            selected={null as OpsRequestLogRow | null}
            onSelect={() => undefined}
            interactive={false}
            fixtureAgents={fixtureAgents}
          />
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });

  const agentsSection = container.querySelector('[data-testid="ops-agents"]');
  expect(agentsSection).toBeTruthy();
  expect(agentsSection?.textContent).toContain("Alex Rivera");
  expect(agentsSection?.textContent).toContain("Ops helper");
  expect(agentsSection?.textContent).toContain("Sam Chen");
  expect(agentsSection?.textContent).toContain("Inbox triage");

  const orphans = container.querySelector('[data-testid="ops-agents-orphans"]');
  expect(orphans).toBeTruthy();
  expect(orphans?.textContent).toContain("No owner / deleted account");
  expect(orphans?.textContent).toContain("Orphan agent");
  expect(orphans?.textContent).not.toContain("Company API");

  const deactivated = container.querySelector('[data-testid="ops-agents-deactivated"]');
  expect(deactivated).toBeTruthy();
  expect(deactivated?.textContent).toContain("Gone User");
  expect(deactivated?.textContent).toContain("Retired bot");

  const filter = container.querySelector(
    '[data-testid="ops-agents"] select[aria-label="Filter by owner"]',
  ) as HTMLSelectElement | null;
  expect(filter).toBeTruthy();
  await act(async () => {
    filter!.value = "user_sam";
    filter!.dispatchEvent(new Event("change", { bubbles: true }));
  });
  expect(container.querySelector('[data-testid="ops-agents"]')?.textContent).toContain(
    "Inbox triage",
  );
  expect(container.querySelector('[data-testid="ops-agents"]')?.textContent).not.toContain(
    "Ops helper",
  );
  expect(container.querySelector('[data-testid="ops-agents-orphans"]')).toBeNull();

  await act(async () => {
    filter!.value = "__orphan__";
    filter!.dispatchEvent(new Event("change", { bubbles: true }));
  });
  expect(container.querySelector('[data-testid="ops-agents-orphans"]')?.textContent).toContain(
    "Orphan agent",
  );
  expect(container.querySelector('[data-testid="ops-agents"]')?.textContent).not.toContain(
    "Ops helper",
  );
});

it("shows No agents yet when the roster is empty", async () => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  await act(async () => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <OpsDashboardView
            data={overview}
            onChanged={() => undefined}
            selected={null as OpsRequestLogRow | null}
            onSelect={() => undefined}
            interactive={false}
            fixtureAgents={[]}
          />
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
  expect(container.querySelector('[data-testid="ops-agents-empty"]')?.textContent).toContain(
    "No agents yet",
  );
});

it("uses email alone in the owner filter when the name is blank", async () => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const nameless: OpsAgent[] = [
    agentFixture({
      id: "bot_nameless",
      name: "Solo",
      owner: {
        id: "user_blank",
        name: "  ",
        email: "blank@example.test",
        deactivated: false,
      },
    }),
  ];
  await act(async () => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <OpsDashboardView
            data={overview}
            onChanged={() => undefined}
            selected={null as OpsRequestLogRow | null}
            onSelect={() => undefined}
            interactive={false}
            fixtureAgents={nameless}
          />
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
  const filter = container.querySelector(
    '[data-testid="ops-agents"] select[aria-label="Filter by owner"]',
  ) as HTMLSelectElement;
  const option = Array.from(filter.querySelectorAll("option")).find(
    (node) => node.value === "user_blank",
  );
  expect(option?.textContent).toBe("blank@example.test");
  expect(option?.textContent).not.toContain("(");
  expect(container.querySelector('[data-testid="ops-agents"]')?.textContent).toContain("1 agent");
});

it("renders budget settings and spend adjustment controls with interactive=false", async () => {
  await renderDashboard(overview, false);

  expect(container.querySelector('[data-testid="ops-budget-section"]')).toBeTruthy();
  expect(container.querySelector('[data-testid="ops-budget-reset"]')?.textContent).toContain(
    "America/New_York",
  );
  expect(container.querySelector('[data-testid="ops-spend-adjustments"]')).toBeTruthy();

  const settingsTrigger = Array.from(container.querySelectorAll("button")).find((node) =>
    node.textContent?.includes("Budget settings"),
  ) as HTMLButtonElement | undefined;
  expect(settingsTrigger).toBeTruthy();
  await act(async () => {
    settingsTrigger!.click();
  });

  expect(container.querySelector('[aria-label="Budget period"]')).toBeTruthy();
  expect(container.querySelector('[aria-label="Auto-enroll mode"]')).toBeTruthy();
  expect(container.querySelector('[aria-label="First warning threshold"]')).toBeTruthy();
  expect(container.querySelector('[aria-label="Stale-hold timeout minutes"]')).toBeTruthy();
  expect(container.textContent).toContain("DB");
  expect(container.textContent).toContain("Default");
  expect(container.querySelector('[role="switch"]')).toBeTruthy();

  expect(container.querySelector('[aria-label="Spend adjustment mode"]')).toBeTruthy();
  expect(container.querySelector('[aria-label="Spend amount"]')).toBeTruthy();
  expect(container.querySelector('[aria-label="Spend adjustment reason"]')).toBeTruthy();

  const historyTrigger = Array.from(container.querySelectorAll("button")).find((node) =>
    node.textContent?.includes("Adjustment history"),
  ) as HTMLButtonElement | undefined;
  expect(historyTrigger).toBeTruthy();
  await act(async () => {
    historyTrigger!.click();
  });
  expect(container.textContent).toContain("Fixture correction");
  expect(container.textContent).toContain("Reverse");
});

it("shows pinned roster lock and remove action for non-pinned members", async () => {
  const data: OpsOverview = {
    ...overview,
    accounts: [
      accountFixture({
        userId: "user_pinned",
        email: "pinned@example.test",
        name: "Pinned User",
        keyType: "company",
        envPinned: true,
        sharedKeyBudget: {
          configured: true,
          member: true,
          weeklyCapUsd: 25,
          spentUsd: 1,
          reservedUsd: 0,
          remainingUsd: 24,
          percentUsed: 4,
          hardStopped: false,
          weekStartsAt: weekStart,
          resetsAt,
          timezone: "America/New_York",
          hardStopEnabled: true,
          warningThresholds: [80, 95],
        },
      }),
      accountFixture({
        userId: "user_member",
        email: "member@example.test",
        name: "Roster Member",
        keyType: "company",
        allotmentOverrideUsd: 40,
        sharedKeyBudget: {
          configured: true,
          member: true,
          weeklyCapUsd: 40,
          spentUsd: 2,
          reservedUsd: 0,
          remainingUsd: 38,
          percentUsed: 5,
          hardStopped: false,
          weekStartsAt: weekStart,
          resetsAt,
          timezone: "America/New_York",
          hardStopEnabled: true,
          warningThresholds: [80, 95],
        },
      }),
    ],
    sharedKeyBudget: {
      ...overview.sharedKeyBudget,
      memberCount: 2,
    },
  };
  await renderDashboard(data, false);

  expect(container.textContent).toContain("Pinned");
  expect(container.textContent).toContain("$40.00");

  const menuItems = Array.from(container.querySelectorAll('[role="menuitem"]')).map(
    (node) => node.textContent ?? "",
  );
  expect(menuItems.some((text) => text.includes("Pinned"))).toBe(true);
  expect(menuItems.some((text) => text.includes("Remove from budget"))).toBe(true);
  expect(menuItems.some((text) => text.includes("Edit allotment"))).toBe(true);
  expect(menuItems.some((text) => text.includes("Adjust tracked spend"))).toBe(true);
});
