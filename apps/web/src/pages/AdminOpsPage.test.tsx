// @vitest-environment jsdom

import type { OpsOverview, OpsRequestLogRow } from "@rakazo/contracts";
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("@lingui/react/macro", () => {
  const t = (strings: TemplateStringsArray, ...values: unknown[]) =>
    strings.flatMap((part, index) => [part, values[index] ?? ""]).join("");
  return {
    useLingui: () => ({ t, i18n: { locale: "en" } }),
    Trans: ({ children }: { children?: ReactNode }) => children,
  };
});

const { addSharedKeyBudgetMember } = vi.hoisted(() => ({
  addSharedKeyBudgetMember: vi.fn(),
}));

vi.mock("@rakazo/ui-web", () => {
  const Pass = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
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
    DropdownMenu: Pass,
    DropdownMenuContent: Pass,
    DropdownMenuItem: ({
      children,
      onClick,
      disabled,
    }: ComponentProps<"button">) => (
      <button type="button" role="menuitem" disabled={disabled} onClick={onClick}>
        {children}
      </button>
    ),
    DropdownMenuTrigger: ({
      children,
      className,
      ...props
    }: ComponentProps<"button">) => (
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

vi.mock("../lib/rpc", () => ({
  rpc: {
    ops: {
      addSharedKeyBudgetMember: (...args: unknown[]) => addSharedKeyBudgetMember(...args),
      overview: vi.fn(),
      requestLog: vi.fn(),
      chatLog: vi.fn(),
      setSharedKeyMonthlyBudget: vi.fn(),
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

const overview: OpsOverview = {
  accounts: [
    {
      userId: "user_pending",
      email: "pending@example.test",
      name: "Pending User",
      deactivated: false,
      modelProvider: "google",
      modelId: "gemini-2.5-flash",
      keyType: "none",
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
      },
      pendingSharedBudgetApproval: true,
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
};

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  addSharedKeyBudgetMember.mockReset();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

it("shows Add failure reason in the accounts section when enrolled is false", async () => {
  addSharedKeyBudgetMember.mockResolvedValue({ enrolled: false, reason: "ineligible" });
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
            interactive
          />
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });

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
