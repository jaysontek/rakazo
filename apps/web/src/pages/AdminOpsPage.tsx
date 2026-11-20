import { plural } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import type {
  OpsAccount,
  OpsAgent,
  OpsChatLog,
  OpsOverview,
  OpsRequestLogRow,
  SharedKeyBudgetDisplayStatus,
} from "@rakazo/contracts";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Badge,
  buttonVariants,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  cn,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  ListSearchInput,
  NativeSelect,
  NativeSelectOption,
  Spinner,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@rakazo/ui-web";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, ArrowUpDown, ChevronLeft, MoreHorizontal } from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useMemo, useState } from "react";
import { Link, Navigate } from "react-router-dom";
import { PageLoading } from "../components/PageLoading";
import { hardSwitchImpersonation } from "../lib/impersonation-switch";
import { useSpaceQueries } from "../lib/query";
import { formatRelativeTime } from "../lib/relative-time";
import { rpc } from "../lib/rpc";
import { errorText } from "../lib/user-error";
import {
  BudgetSection,
  MemberOverrideDialog,
  RemoveMemberDialog,
  UserSpendAdjustDialog,
} from "./AdminOpsBudget";
import { WindowChrome } from "./WindowChrome";

function money(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return `$${value.toFixed(2)}`;
}

function tokens(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return value.toLocaleString();
}

function ms(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  if (value < 1000) return `${Math.round(value)} ms`;
  return `${(value / 1000).toFixed(1)} s`;
}

function pct(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  // Floor so display matches UsageBar / SharedKeyUsageMeter (never round 99.5 → 100).
  return `${Math.min(100, Math.max(0, Math.floor(value)))}%`;
}

function accountModelLabel(account: Pick<OpsAccount, "modelProvider" | "modelId">): string | null {
  if (!account.modelProvider || !account.modelId) return null;
  return `${account.modelProvider}/${account.modelId}`;
}

function accountLabel(account: Pick<OpsAccount, "name" | "email">): string {
  return account.name || account.email;
}

function KeyBadge({
  keyType,
  pendingSharedBudget,
  needsReconnect,
}: {
  keyType: OpsAccount["keyType"];
  pendingSharedBudget?: boolean;
  needsReconnect?: boolean;
}) {
  let badge: ReactNode;
  if (pendingSharedBudget) {
    badge = (
      <Badge variant="secondary">
        <Trans>Company key — pending admin approval</Trans>
      </Badge>
    );
  } else {
    switch (keyType) {
      case "company":
        badge = (
          <Badge variant="secondary">
            <Trans>Company API</Trans>
          </Badge>
        );
        break;
      case "personal":
        badge = (
          <Badge variant="outline">
            <Trans>Personal API</Trans>
          </Badge>
        );
        break;
      default: {
        keyType satisfies never;
        // Unexpected legacy/unknown values must never render blank or "none".
        badge = (
          <Badge variant="secondary">
            <Trans>Company API</Trans>
          </Badge>
        );
      }
    }
  }
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      {badge}
      {needsReconnect ? (
        <span className="text-xs text-muted-foreground">
          <Trans>Reconnect</Trans>
        </span>
      ) : null}
    </span>
  );
}

function pendingSharedBudgetApproval(account: OpsAccount): boolean {
  return account.pendingSharedBudgetApproval === true;
}

function UsageBar({
  percent,
  label,
  hardStopped,
  status,
}: {
  percent: number;
  label: string;
  hardStopped?: boolean;
  status?: SharedKeyBudgetDisplayStatus;
}) {
  const value = Math.min(100, Math.max(0, Math.floor(percent)));
  const blocked = hardStopped || status === "blocked";
  const warning = !blocked && status === "warning";
  return (
    <div className="space-y-1">
      <div className="flex items-baseline justify-between gap-2 text-xs">
        <span
          className={cn("tabular-nums", blocked && "text-destructive", warning && "text-warning")}
        >
          {pct(value)}
        </span>
        {blocked ? (
          <span className="text-destructive">
            {hardStopped ? <Trans>Hard-stopped</Trans> : <Trans>Limit reached</Trans>}
          </span>
        ) : null}
      </div>
      <div
        className="h-1.5 overflow-hidden rounded-full bg-muted"
        role="progressbar"
        aria-valuenow={value}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuetext={`${value}%`}
        aria-label={label}
      >
        <div
          className={cn(
            "h-full rounded-full transition-[width]",
            blocked ? "bg-destructive" : warning ? "bg-warning" : "bg-foreground",
          )}
          style={{ width: `${value}%` }}
        />
      </div>
    </div>
  );
}

export function AdminOpsPage() {
  const { t } = useLingui();
  const me = useQuery(useSpaceQueries().me.queryOptions());
  if (me.isPending) return <PageLoading />;
  if (!me.data?.isAdmin) return <Navigate to="/app" replace />;
  return (
    <div className="flex h-full min-w-0 flex-col overflow-hidden bg-background text-foreground">
      <WindowChrome />
      <header className="flex items-center gap-3 border-b px-4 py-3">
        <Link
          to="/app"
          className={buttonVariants({ variant: "ghost", size: "icon" })}
          aria-label={t`Back`}
        >
          <ChevronLeft />
        </Link>
        <h1 className="flex-1 font-medium">
          <Trans>Operations</Trans>
        </h1>
      </header>
      <main className="min-h-0 flex-1 overflow-y-auto">
        <div className="w-full space-y-6 px-4 py-6 sm:px-6 lg:px-8">
          <OpsDashboard />
        </div>
      </main>
    </div>
  );
}

function OpsDashboard() {
  const overview = useQuery({
    queryKey: ["ops", "overview"],
    queryFn: () => rpc.ops.overview(),
  });
  const [selected, setSelected] = useState<OpsRequestLogRow | null>(null);

  if (overview.isPending) {
    return (
      <div className="flex justify-center py-16">
        <Spinner />
      </div>
    );
  }
  if (overview.isError || !overview.data) {
    return (
      <p className="text-sm text-muted-foreground">
        {errorText(overview.error, "Operations dashboard unavailable")}
      </p>
    );
  }

  return (
    <OpsDashboardView
      data={overview.data}
      onChanged={() => {
        void overview.refetch();
      }}
      selected={selected}
      onSelect={setSelected}
    />
  );
}

/** Presentational ops dashboard — also used by the e2e fixture with mock data. */
export function OpsDashboardView({
  data,
  onChanged,
  selected,
  onSelect,
  interactive = true,
  fixtureAgents,
}: {
  data: OpsOverview;
  onChanged: () => void;
  selected: OpsRequestLogRow | null;
  onSelect: (row: OpsRequestLogRow) => void;
  /** When false, mutation controls stay visible but RPC is not called (fixture). */
  interactive?: boolean;
  /** Agents roster for non-interactive fixtures (e2e / unit). */
  fixtureAgents?: OpsAgent[];
}) {
  return (
    <div data-testid="ops-dashboard" className="space-y-6">
      <BudgetSection data={data} onChanged={onChanged} interactive={interactive} />
      <Tabs defaultValue="accounts" className="gap-4">
        <TabsList variant="line" className="w-full max-w-full flex-wrap justify-start">
          <TabsTrigger value="accounts">
            <Trans>Accounts</Trans>
          </TabsTrigger>
          <TabsTrigger value="teams">
            <Trans>Teams</Trans>
          </TabsTrigger>
          <TabsTrigger value="transfers">
            <Trans>Transfers</Trans>
          </TabsTrigger>
          <TabsTrigger value="admins">
            <Trans>Admins</Trans>
          </TabsTrigger>
          <TabsTrigger value="audit">
            <Trans>Audit</Trans>
          </TabsTrigger>
        </TabsList>
        <TabsContent value="accounts" className="space-y-4">
          <AccountsSection
            accounts={data.accounts}
            onChanged={onChanged}
            interactive={interactive}
          />
        </TabsContent>
        <TabsContent value="teams" className="space-y-4">
          <TeamsSection />
        </TabsContent>
        <TabsContent value="transfers" className="space-y-4">
          <TransfersSection data={data} onChanged={onChanged} interactive={interactive} />
        </TabsContent>
        <TabsContent value="admins" className="space-y-4">
          <AdminGrantsSection data={data} onChanged={onChanged} interactive={interactive} />
        </TabsContent>
        <TabsContent value="audit" className="space-y-8">
          <AgentsSection
            interactive={interactive}
            fixtureAgents={fixtureAgents}
            overviewCounts={data.agents}
          />
          <PerformanceSection data={data} />
          <RequestLogSection
            selected={selected}
            onSelect={onSelect}
            interactive={interactive}
            fixtureRows={interactive ? undefined : []}
          />
          {selected?.runId || selected?.threadId ? (
            <ChatLogSection
              runId={selected.runId}
              threadId={selected.threadId}
              interactive={interactive}
            />
          ) : null}
        </TabsContent>
      </Tabs>
    </div>
  );
}

type AccountSortKey = "account" | "key" | "tokens" | "spend" | "sharedWeek";
type AccountSortDir = "asc" | "desc";

function SortButton({
  column,
  sortKey,
  sortDir,
  onToggle,
  children,
}: {
  column: AccountSortKey;
  sortKey: AccountSortKey;
  sortDir: AccountSortDir;
  onToggle: (column: AccountSortKey) => void;
  children: ReactNode;
}) {
  const active = sortKey === column;
  const Icon = !active ? ArrowUpDown : sortDir === "asc" ? ArrowUp : ArrowDown;
  return (
    <button
      type="button"
      className="inline-flex items-center gap-1 font-normal text-muted-foreground hover:text-foreground"
      onClick={() => onToggle(column)}
    >
      {children}
      <Icon className="size-3.5" aria-hidden="true" />
    </button>
  );
}

function AccountActions({
  account,
  canTransfer,
  transferDisabled,
  canAddToSharedBudget,
  canRemoveFromSharedBudget,
  canEditAllotment,
  canAdjustSpend,
  envPinned,
  addBusy,
  onImpersonate,
  onTransfer,
  onAddToSharedBudget,
  onRemoveFromSharedBudget,
  onEditAllotment,
  onAdjustSpend,
}: {
  account: OpsAccount;
  canTransfer: boolean;
  transferDisabled: boolean;
  canAddToSharedBudget: boolean;
  canRemoveFromSharedBudget: boolean;
  canEditAllotment: boolean;
  canAdjustSpend: boolean;
  envPinned: boolean;
  addBusy: boolean;
  onImpersonate: (account: OpsAccount) => void;
  onTransfer: (account: OpsAccount) => void;
  onAddToSharedBudget: (account: OpsAccount) => void;
  onRemoveFromSharedBudget: (account: OpsAccount) => void;
  onEditAllotment: (account: OpsAccount) => void;
  onAdjustSpend: (account: OpsAccount) => void;
}) {
  const { t } = useLingui();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={t`Actions for ${accountLabel(account)}`}
        className={buttonVariants({ variant: "ghost", size: "icon-sm" })}
      >
        <MoreHorizontal className="size-4" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onClick={() => onImpersonate(account)}>
          <Trans>Impersonate</Trans>
        </DropdownMenuItem>
        {canAddToSharedBudget ? (
          <DropdownMenuItem disabled={addBusy} onClick={() => onAddToSharedBudget(account)}>
            <Trans>Add to shared budget</Trans>
          </DropdownMenuItem>
        ) : null}
        {canEditAllotment ? (
          <DropdownMenuItem onClick={() => onEditAllotment(account)}>
            <Trans>Edit allotment</Trans>
          </DropdownMenuItem>
        ) : null}
        {canAdjustSpend ? (
          <DropdownMenuItem onClick={() => onAdjustSpend(account)}>
            <Trans>Adjust tracked spend</Trans>
          </DropdownMenuItem>
        ) : null}
        {canTransfer ? (
          <DropdownMenuItem disabled={transferDisabled} onClick={() => onTransfer(account)}>
            <Trans>Transfer</Trans>
          </DropdownMenuItem>
        ) : null}
        {envPinned ? (
          <DropdownMenuItem disabled>
            <Trans>Pinned</Trans>
          </DropdownMenuItem>
        ) : null}
        {canRemoveFromSharedBudget ? (
          <DropdownMenuItem variant="destructive" onClick={() => onRemoveFromSharedBudget(account)}>
            <Trans>Remove from budget</Trans>
          </DropdownMenuItem>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function sortAriaValue(
  column: AccountSortKey,
  sortKey: AccountSortKey,
  sortDir: AccountSortDir,
): "none" | "ascending" | "descending" {
  if (sortKey !== column) return "none";
  return sortDir === "asc" ? "ascending" : "descending";
}

function TeamsSection() {
  const { t } = useLingui();
  const orgs = useQuery({
    queryKey: ["ops", "organizations"],
    queryFn: () => rpc.ops.organizations(),
  });

  if (orgs.isPending) {
    return (
      <div className="flex justify-center py-8">
        <Spinner />
      </div>
    );
  }
  if (orgs.isError || !orgs.data) {
    return (
      <p className="text-sm text-muted-foreground">
        {errorText(orgs.error, t`Could not load teams`)}
      </p>
    );
  }
  if (orgs.data.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        <Trans>No teams</Trans>
      </p>
    );
  }

  return (
    <ul className="divide-y rounded-lg border" data-testid="ops-teams">
      {orgs.data.map((org) => (
        <li key={org.id}>
          <Link
            to={`/admin/ops/teams/${org.id}`}
            className="flex items-center justify-between gap-3 px-4 py-3 text-sm hover:bg-muted/40"
          >
            <span className="min-w-0 truncate font-medium">{org.name}</span>
            <span className="shrink-0 text-muted-foreground tabular-nums">
              <Trans>{org.memberCount} members</Trans>
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
}

function AccountsSection({
  accounts,
  onChanged,
  interactive,
}: {
  accounts: OpsOverview["accounts"];
  onChanged: () => void;
  interactive: boolean;
}) {
  const { t } = useLingui();
  const queryClient = useQueryClient();
  const roster = accounts.filter((account) => account.sharedKeyBudget?.member);
  const [impersonate, setImpersonate] = useState<OpsAccount | null>(null);
  const [transferFrom, setTransferFrom] = useState<OpsAccount | null>(null);
  const [transferToId, setTransferToId] = useState("");
  const [removeMember, setRemoveMember] = useState<OpsAccount | null>(null);
  const [overrideMember, setOverrideMember] = useState<OpsAccount | null>(null);
  const [spendMember, setSpendMember] = useState<OpsAccount | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [keyFilter, setKeyFilter] = useState<"all" | "company" | "personal">("all");
  const [sortKey, setSortKey] = useState<AccountSortKey>("account");
  const [sortDir, setSortDir] = useState<AccountSortDir>("asc");

  const transferTargets = transferFrom
    ? roster.filter((account) => account.userId !== transferFrom.userId)
    : [];
  const transferTo = transferTargets.find((account) => account.userId === transferToId) ?? null;
  const remaining = transferFrom?.sharedKeyBudget?.remainingUsd;
  const transferFromId = transferFrom?.userId ?? null;
  const transferTargetIds = transferTargets.map((account) => account.userId).join("\0");

  useEffect(() => {
    if (!transferFromId) {
      setTransferToId("");
      return;
    }
    const ids = transferTargetIds ? transferTargetIds.split("\0") : [];
    setTransferToId((current) => (ids.includes(current) ? current : (ids[0] ?? "")));
  }, [transferFromId, transferTargetIds]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const rows = accounts.filter((account) => {
      if (keyFilter !== "all" && account.keyType !== keyFilter) return false;
      if (!needle) return true;
      return (
        account.name.toLowerCase().includes(needle) || account.email.toLowerCase().includes(needle)
      );
    });
    const dir = sortDir === "asc" ? 1 : -1;
    rows.sort((a, b) => {
      switch (sortKey) {
        case "key":
          return a.keyType.localeCompare(b.keyType) * dir;
        case "tokens":
          return ((a.totalTokens ?? -1) - (b.totalTokens ?? -1)) * dir;
        case "spend":
          return ((a.totalCostUsd ?? -1) - (b.totalCostUsd ?? -1)) * dir;
        case "sharedWeek":
          return (
            ((a.sharedKeyBudget?.percentUsed ?? -1) - (b.sharedKeyBudget?.percentUsed ?? -1)) * dir
          );
        default:
          return accountLabel(a).localeCompare(accountLabel(b)) * dir;
      }
    });
    return rows;
  }, [accounts, keyFilter, query, sortDir, sortKey]);

  function toggleSort(key: AccountSortKey) {
    if (sortKey === key) {
      setSortDir((current) => (current === "asc" ? "desc" : "asc"));
      return;
    }
    setSortKey(key);
    setSortDir("asc");
  }

  async function confirmImpersonate() {
    if (!impersonate) return;
    if (!interactive) {
      setImpersonate(null);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await rpc.ops.startImpersonation({ userId: impersonate.userId });
      setImpersonate(null);
      hardSwitchImpersonation({ queryClient, target: "/app" });
    } catch (err) {
      setError(errorText(err, t`Could not impersonate`));
      setBusy(false);
    }
  }

  async function confirmTransfer() {
    if (!transferFrom || !transferTo) return;
    if (!interactive) {
      setTransferFrom(null);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await rpc.ops.transferSharedKeyAllotment({
        fromUserId: transferFrom.userId,
        toUserId: transferTo.userId,
      });
      setTransferFrom(null);
      onChanged();
    } catch (err) {
      setError(errorText(err, t`Could not transfer allotment`));
    } finally {
      setBusy(false);
    }
  }

  async function addToSharedBudget(account: OpsAccount) {
    if (!interactive) return;
    setBusy(true);
    setError(null);
    try {
      const result = await rpc.ops.addSharedKeyBudgetMember({ userId: account.userId });
      if (!result.enrolled) {
        const reasonMessage =
          result.reason === "already_member"
            ? t`Already on the shared budget`
            : result.reason === "ineligible"
              ? t`Not eligible for the shared budget`
              : result.reason === "zero_slice"
                ? t`No weekly share left to assign`
                : t`Could not add to shared budget`;
        setError(reasonMessage);
        onChanged();
        return;
      }
      onChanged();
    } catch (err) {
      setError(errorText(err, t`Could not add to shared budget`));
    } finally {
      setBusy(false);
    }
  }

  function AccountBudgetCell({ account }: { account: OpsAccount }) {
    const budget = account.sharedKeyBudget;
    if (!budget) return <span className="text-muted-foreground">—</span>;
    if (!budget.configured) {
      return (
        <span className="text-muted-foreground">
          <Trans>Cap unset</Trans>
        </span>
      );
    }
    if (!budget.member) {
      if (pendingSharedBudgetApproval(account)) {
        return (
          <span className="text-muted-foreground">
            <Trans>Pending admin approval</Trans>
          </span>
        );
      }
      return <span className="text-muted-foreground">—</span>;
    }
    return (
      <div className="min-w-[7rem] space-y-1">
        <UsageBar
          percent={budget.percentUsed}
          label={t`Shared week usage for ${accountLabel(account)}`}
          hardStopped={budget.hardStopped}
          status={budget.status}
        />
        <div className="text-xs text-muted-foreground tabular-nums">
          {money(budget.remainingUsd)} left
          {budget.reservedUsd > 0 ? (
            <span className="ms-1">
              <Trans>+{money(budget.reservedUsd)} held</Trans>
            </span>
          ) : null}
        </div>
        <div className="flex flex-wrap gap-1">
          {account.envPinned ? (
            <Badge variant="outline" className="font-normal">
              <Trans>Pinned</Trans>
            </Badge>
          ) : null}
          {account.allotmentOverrideUsd != null ? (
            <Badge variant="secondary" className="font-normal tabular-nums">
              {money(account.allotmentOverrideUsd)}
            </Badge>
          ) : null}
        </div>
      </div>
    );
  }

  function ModelBadge({ account }: { account: OpsAccount }) {
    const label = accountModelLabel(account);
    if (!label) {
      return <span className="text-muted-foreground">—</span>;
    }
    return (
      <Badge
        variant="outline"
        className="max-w-[12rem] truncate font-normal"
        title={account.modelSource ? `${label} · ${account.modelSource}` : label}
      >
        {label}
      </Badge>
    );
  }

  function accountActionProps(account: OpsAccount) {
    const member = Boolean(account.sharedKeyBudget?.member);
    const envPinned = account.envPinned === true;
    return {
      account,
      canTransfer: member,
      transferDisabled: roster.length < 2,
      canAddToSharedBudget: pendingSharedBudgetApproval(account),
      canRemoveFromSharedBudget: member && !envPinned,
      canEditAllotment: member,
      canAdjustSpend: member,
      envPinned,
      addBusy: busy,
      onImpersonate: (next: OpsAccount) => {
        setError(null);
        setImpersonate(next);
      },
      onTransfer: (next: OpsAccount) => {
        setError(null);
        setTransferFrom(next);
      },
      onAddToSharedBudget: (next: OpsAccount) => {
        void addToSharedBudget(next);
      },
      onRemoveFromSharedBudget: (next: OpsAccount) => {
        setError(null);
        setRemoveMember(next);
      },
      onEditAllotment: (next: OpsAccount) => {
        setError(null);
        setOverrideMember(next);
      },
      onAdjustSpend: (next: OpsAccount) => {
        setError(null);
        setSpendMember(next);
      },
    };
  }

  const dialogOpen = Boolean(impersonate || transferFrom);

  return (
    <section className="space-y-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <div className="min-w-0 flex-1">
          <ListSearchInput
            query={query}
            setQuery={setQuery}
            label={t`Search accounts`}
            placeholder={t`Search name or email`}
          />
        </div>
        <label className="flex items-center gap-2 text-sm">
          <span className="sr-only">
            <Trans>Key type</Trans>
          </span>
          <NativeSelect
            size="sm"
            value={keyFilter}
            aria-label={t`Filter by key type`}
            onChange={(event) => setKeyFilter(event.target.value as "all" | "company" | "personal")}
          >
            <NativeSelectOption value="all">{t`All keys`}</NativeSelectOption>
            <NativeSelectOption value="company">{t`Company API`}</NativeSelectOption>
            <NativeSelectOption value="personal">{t`Personal API`}</NativeSelectOption>
          </NativeSelect>
        </label>
      </div>

      {error && !dialogOpen ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}

      <div className="hidden md:block">
        <div className="overflow-x-auto">
          <table className="w-full min-w-0 text-left text-sm">
            <thead className="text-muted-foreground">
              <tr className="border-b">
                <th
                  className="py-2 pr-3 font-normal"
                  aria-sort={sortAriaValue("account", sortKey, sortDir)}
                >
                  <SortButton
                    column="account"
                    sortKey={sortKey}
                    sortDir={sortDir}
                    onToggle={toggleSort}
                  >
                    <Trans>Account</Trans>
                  </SortButton>
                </th>
                <th
                  className="py-2 pr-3 font-normal"
                  aria-sort={sortAriaValue("key", sortKey, sortDir)}
                >
                  <SortButton
                    column="key"
                    sortKey={sortKey}
                    sortDir={sortDir}
                    onToggle={toggleSort}
                  >
                    <Trans>Key</Trans>
                  </SortButton>
                </th>
                <th className="py-2 pr-3 font-normal">
                  <Trans>Model</Trans>
                </th>
                <th
                  className="py-2 pr-3 font-normal"
                  aria-sort={sortAriaValue("tokens", sortKey, sortDir)}
                >
                  <SortButton
                    column="tokens"
                    sortKey={sortKey}
                    sortDir={sortDir}
                    onToggle={toggleSort}
                  >
                    <Trans>Tokens</Trans>
                  </SortButton>
                </th>
                <th
                  className="py-2 pr-3 font-normal"
                  aria-sort={sortAriaValue("spend", sortKey, sortDir)}
                >
                  <SortButton
                    column="spend"
                    sortKey={sortKey}
                    sortDir={sortDir}
                    onToggle={toggleSort}
                  >
                    <Trans>Spend</Trans>
                  </SortButton>
                </th>
                <th
                  className="py-2 pr-3 font-normal"
                  aria-sort={sortAriaValue("sharedWeek", sortKey, sortDir)}
                >
                  <SortButton
                    column="sharedWeek"
                    sortKey={sortKey}
                    sortDir={sortDir}
                    onToggle={toggleSort}
                  >
                    <Trans>Shared week</Trans>
                  </SortButton>
                </th>
                <th className="py-2 font-normal">
                  <span className="sr-only">
                    <Trans>Actions</Trans>
                  </span>
                </th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((account) => (
                <tr key={account.userId} className="border-b border-border/60 align-top">
                  <td className="py-3 pr-3">
                    <div className="font-medium">{account.name || account.email}</div>
                    <div className="text-muted-foreground break-all">{account.email}</div>
                  </td>
                  <td className="py-3 pr-3">
                    <KeyBadge
                      keyType={account.keyType}
                      pendingSharedBudget={pendingSharedBudgetApproval(account)}
                      needsReconnect={account.needsReconnect}
                    />
                  </td>
                  <td className="py-3 pr-3">
                    <ModelBadge account={account} />
                  </td>
                  <td className="py-3 pr-3 tabular-nums">{tokens(account.totalTokens)}</td>
                  <td className="py-3 pr-3">
                    <div className="tabular-nums">{money(account.totalCostUsd)}</div>
                    <div className="text-xs text-muted-foreground">
                      <Trans>Shared {money(account.sharedKeyCostUsd)}</Trans>
                      {" · "}
                      <Trans>Personal {money(account.personalKeyCostUsd)}</Trans>
                    </div>
                  </td>
                  <td className="py-3 pr-3">
                    <AccountBudgetCell account={account} />
                  </td>
                  <td className="py-3">
                    <AccountActions {...accountActionProps(account)} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <ul className="grid gap-3 md:hidden">
        {filtered.map((account) => (
          <li key={account.userId}>
            <Card size="sm">
              <CardHeader className="flex-row items-start justify-between gap-2">
                <div className="min-w-0">
                  <CardTitle className="truncate">{account.name || account.email}</CardTitle>
                  <CardDescription className="break-all">{account.email}</CardDescription>
                </div>
                <AccountActions {...accountActionProps(account)} />
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="flex flex-wrap items-center gap-2">
                  <KeyBadge
                    keyType={account.keyType}
                    pendingSharedBudget={pendingSharedBudgetApproval(account)}
                    needsReconnect={account.needsReconnect}
                  />
                  <ModelBadge account={account} />
                </div>
                <dl className="grid grid-cols-2 gap-2 text-sm">
                  <div>
                    <dt className="text-muted-foreground">
                      <Trans>Tokens</Trans>
                    </dt>
                    <dd className="tabular-nums">{tokens(account.totalTokens)}</dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">
                      <Trans>Spend</Trans>
                    </dt>
                    <dd className="tabular-nums">{money(account.totalCostUsd)}</dd>
                  </div>
                </dl>
                <div className="text-xs text-muted-foreground">
                  <Trans>Shared {money(account.sharedKeyCostUsd)}</Trans>
                  {" · "}
                  <Trans>Personal {money(account.personalKeyCostUsd)}</Trans>
                </div>
                <AccountBudgetCell account={account} />
              </CardContent>
            </Card>
          </li>
        ))}
      </ul>

      {impersonate ? (
        <AlertDialog
          open
          onOpenChange={(open) => {
            if (!open && !busy) setImpersonate(null);
          }}
        >
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>
                <Trans>Impersonate {accountLabel(impersonate)}?</Trans>
              </AlertDialogTitle>
              <AlertDialogDescription className="sr-only">
                <Trans>Impersonate {accountLabel(impersonate)}?</Trans>
              </AlertDialogDescription>
            </AlertDialogHeader>
            {error ? <p className="text-sm text-destructive">{error}</p> : null}
            <AlertDialogFooter>
              <AlertDialogCancel disabled={busy}>
                <Trans>Cancel</Trans>
              </AlertDialogCancel>
              <AlertDialogAction disabled={busy} onClick={() => void confirmImpersonate()}>
                {busy ? <Trans>Starting…</Trans> : <Trans>Impersonate</Trans>}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      ) : null}

      {transferFrom ? (
        <AlertDialog
          open
          onOpenChange={(open) => {
            if (!open && !busy) setTransferFrom(null);
          }}
        >
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>
                <Trans>Transfer unused allotment</Trans>
              </AlertDialogTitle>
              <AlertDialogDescription>
                {transferTo ? (
                  remaining != null ? (
                    <Trans>
                      Transfer {money(remaining)} from {accountLabel(transferFrom)} to{" "}
                      {accountLabel(transferTo)}?
                    </Trans>
                  ) : (
                    <Trans>
                      Transfer unused allotment from {accountLabel(transferFrom)} to{" "}
                      {accountLabel(transferTo)}?
                    </Trans>
                  )
                ) : (
                  <Trans>Choose a destination on the roster.</Trans>
                )}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <label className="block space-y-1 text-sm">
              <span className="text-muted-foreground">
                <Trans>To</Trans>
              </span>
              <NativeSelect
                className="w-full max-w-full"
                value={transferToId}
                disabled={busy || transferTargets.length === 0}
                onChange={(event) => setTransferToId(event.target.value)}
              >
                {transferTargets.map((account) => (
                  <NativeSelectOption key={account.userId} value={account.userId}>
                    {accountLabel(account)}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </label>
            {error ? <p className="text-sm text-destructive">{error}</p> : null}
            <AlertDialogFooter>
              <AlertDialogCancel disabled={busy}>
                <Trans>Cancel</Trans>
              </AlertDialogCancel>
              <AlertDialogAction
                disabled={busy || !transferTo}
                onClick={() => void confirmTransfer()}
              >
                {busy ? <Trans>Transferring…</Trans> : <Trans>Transfer</Trans>}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      ) : null}

      <RemoveMemberDialog
        account={removeMember}
        open={Boolean(removeMember)}
        onOpenChange={(next) => {
          if (!next) setRemoveMember(null);
        }}
        interactive={interactive}
        onChanged={onChanged}
      />
      <MemberOverrideDialog
        account={overrideMember}
        open={Boolean(overrideMember)}
        onOpenChange={(next) => {
          if (!next) setOverrideMember(null);
        }}
        interactive={interactive}
        onChanged={onChanged}
      />
      <UserSpendAdjustDialog
        account={spendMember}
        open={Boolean(spendMember)}
        onOpenChange={(next) => {
          if (!next) setSpendMember(null);
        }}
        interactive={interactive}
        onChanged={onChanged}
      />
    </section>
  );
}

function AdminGrantsSection({
  data,
  onChanged,
  interactive,
}: {
  data: OpsOverview;
  onChanged: () => void;
  interactive: boolean;
}) {
  const { t } = useLingui();
  const grants = data.adminGrants;
  const grantedIds = new Set(grants.map((grant) => grant.userId));
  const candidates = data.accounts.filter((account) => !grantedIds.has(account.userId));
  const [userId, setUserId] = useState(candidates[0]?.userId ?? "");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [removeTarget, setRemoveTarget] = useState<(typeof grants)[number] | null>(null);
  const [addConfirmOpen, setAddConfirmOpen] = useState(false);
  const candidateIds = candidates.map((account) => account.userId).join("\0");
  const addCandidate = candidates.find((account) => account.userId === userId) ?? null;

  useEffect(() => {
    const ids = candidateIds ? candidateIds.split("\0") : [];
    setUserId((current) => (ids.includes(current) ? current : (ids[0] ?? "")));
  }, [candidateIds]);

  async function confirmAddGrant() {
    if (!userId) return;
    if (!interactive) {
      setAddConfirmOpen(false);
      return;
    }
    setBusy("add");
    setError(null);
    try {
      await rpc.ops.addAdminGrant({ userId });
      setAddConfirmOpen(false);
      onChanged();
    } catch (err) {
      setError(errorText(err, t`Could not add admin`));
    } finally {
      setBusy(null);
    }
  }

  async function confirmRemove() {
    if (!removeTarget) return;
    if (!interactive) {
      setRemoveTarget(null);
      return;
    }
    setBusy(removeTarget.userId);
    setError(null);
    try {
      await rpc.ops.removeAdminGrant({ userId: removeTarget.userId });
      setRemoveTarget(null);
      onChanged();
    } catch (err) {
      setError(errorText(err, t`Could not remove admin`));
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="space-y-3">
      <ul className="divide-y divide-border/60 rounded-xl border border-border/60 text-sm">
        {grants.map((grant) => (
          <li key={grant.userId} className="flex items-center gap-3 px-3 py-2">
            <div className="min-w-0 flex-1">
              <div>{grant.name || grant.email}</div>
              <div className="text-muted-foreground break-all">{grant.email}</div>
            </div>
            {grant.envBootstrap ? (
              <Badge variant="outline">
                <Trans>Env</Trans>
              </Badge>
            ) : (
              <button
                type="button"
                className={buttonVariants({ variant: "ghost", size: "sm" })}
                disabled={busy !== null}
                onClick={() => {
                  setError(null);
                  setRemoveTarget(grant);
                }}
              >
                <Trans>Remove</Trans>
              </button>
            )}
          </li>
        ))}
      </ul>
      {candidates.length > 0 ? (
        <div className="flex flex-wrap items-end gap-2">
          <label className="min-w-[12rem] flex-1 space-y-1 text-sm">
            <span className="text-muted-foreground">
              <Trans>Add</Trans>
            </span>
            <NativeSelect
              className="w-full max-w-full"
              value={userId}
              disabled={busy !== null}
              onChange={(event) => setUserId(event.target.value)}
            >
              {candidates.map((account) => (
                <NativeSelectOption key={account.userId} value={account.userId}>
                  {accountLabel(account)}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </label>
          <button
            type="button"
            className={buttonVariants({ variant: "outline", size: "sm" })}
            disabled={busy !== null || !userId}
            onClick={() => {
              setError(null);
              setAddConfirmOpen(true);
            }}
          >
            {busy === "add" ? <Spinner className="size-4" /> : <Trans>Grant</Trans>}
          </button>
        </div>
      ) : null}
      {error && !removeTarget && !addConfirmOpen ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}

      {addConfirmOpen && addCandidate ? (
        <AlertDialog
          open
          onOpenChange={(open) => {
            if (!open && busy === null) setAddConfirmOpen(false);
          }}
        >
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>
                <Trans>Grant admin to {accountLabel(addCandidate)}?</Trans>
              </AlertDialogTitle>
              <AlertDialogDescription className="sr-only">
                <Trans>Grant admin to {accountLabel(addCandidate)}?</Trans>
              </AlertDialogDescription>
            </AlertDialogHeader>
            {error ? <p className="text-sm text-destructive">{error}</p> : null}
            <AlertDialogFooter>
              <AlertDialogCancel disabled={busy !== null}>
                <Trans>Cancel</Trans>
              </AlertDialogCancel>
              <AlertDialogAction disabled={busy !== null} onClick={() => void confirmAddGrant()}>
                {busy === "add" ? <Trans>Granting…</Trans> : <Trans>Grant</Trans>}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      ) : null}

      {removeTarget ? (
        <AlertDialog
          open
          onOpenChange={(open) => {
            if (!open && busy === null) setRemoveTarget(null);
          }}
        >
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>
                <Trans>Remove {accountLabel(removeTarget)}?</Trans>
              </AlertDialogTitle>
              <AlertDialogDescription className="sr-only">
                <Trans>Remove {accountLabel(removeTarget)}?</Trans>
              </AlertDialogDescription>
            </AlertDialogHeader>
            {error ? <p className="text-sm text-destructive">{error}</p> : null}
            <AlertDialogFooter>
              <AlertDialogCancel disabled={busy !== null}>
                <Trans>Cancel</Trans>
              </AlertDialogCancel>
              <AlertDialogAction
                variant="destructive"
                disabled={busy !== null}
                onClick={() => void confirmRemove()}
              >
                {busy === removeTarget.userId ? <Trans>Removing…</Trans> : <Trans>Remove</Trans>}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      ) : null}
    </section>
  );
}

function TransfersSection({
  data,
  onChanged,
  interactive,
}: {
  data: OpsOverview;
  onChanged: () => void;
  interactive: boolean;
}) {
  const { t } = useLingui();
  const accountsById = new Map(data.accounts.map((account) => [account.userId, account]));
  const transfers = data.allotmentTransfers;
  const [reverseId, setReverseId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const reverseTarget = transfers.find((transfer) => transfer.id === reverseId) ?? null;

  function nameFor(userId: string): string {
    const account = accountsById.get(userId);
    return account ? accountLabel(account) : userId;
  }

  async function confirmReverse() {
    if (!reverseTarget) return;
    if (!interactive) {
      setReverseId(null);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await rpc.ops.reverseSharedKeyAllotmentTransfer({ transferId: reverseTarget.id });
      setReverseId(null);
      onChanged();
    } catch (err) {
      setError(errorText(err, t`Could not reverse transfer`));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="space-y-3">
      {transfers.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          <Trans>None this week.</Trans>
        </p>
      ) : (
        <>
          <div className="hidden overflow-x-auto md:block">
            <table className="w-full min-w-0 text-left text-sm">
              <thead className="text-muted-foreground">
                <tr className="border-b">
                  <th className="py-2 pr-3 font-normal">
                    <Trans>When</Trans>
                  </th>
                  <th className="py-2 pr-3 font-normal">
                    <Trans>From</Trans>
                  </th>
                  <th className="py-2 pr-3 font-normal">
                    <Trans>To</Trans>
                  </th>
                  <th className="py-2 pr-3 font-normal">
                    <Trans>Amount</Trans>
                  </th>
                  <th className="py-2 font-normal" />
                </tr>
              </thead>
              <tbody>
                {transfers.map((transfer) => (
                  <tr key={transfer.id} className="border-b border-border/60">
                    <td className="py-2 pr-3">{new Date(transfer.createdAt).toLocaleString()}</td>
                    <td className="py-2 pr-3">{nameFor(transfer.fromUserId)}</td>
                    <td className="py-2 pr-3">{nameFor(transfer.toUserId)}</td>
                    <td className="py-2 pr-3 tabular-nums">
                      {money(transfer.amountUsd)}
                      {transfer.reversedAt ? (
                        <span className="ms-2 text-muted-foreground">
                          <Trans>Reversed</Trans>
                        </span>
                      ) : null}
                    </td>
                    <td className="py-2">
                      {transfer.reversedAt ? null : (
                        <button
                          type="button"
                          className={buttonVariants({ variant: "ghost", size: "sm" })}
                          onClick={() => {
                            setError(null);
                            setReverseId(transfer.id);
                          }}
                        >
                          <Trans>Reverse</Trans>
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <ul className="grid gap-3 md:hidden">
            {transfers.map((transfer) => (
              <li key={transfer.id}>
                <Card size="sm">
                  <CardContent className="space-y-2 pt-(--card-spacing)">
                    <div className="text-xs text-muted-foreground">
                      {new Date(transfer.createdAt).toLocaleString()}
                    </div>
                    <div className="text-sm">
                      {nameFor(transfer.fromUserId)} → {nameFor(transfer.toUserId)}
                    </div>
                    <div className="flex items-center justify-between gap-2">
                      <span className="tabular-nums">{money(transfer.amountUsd)}</span>
                      {transfer.reversedAt ? (
                        <span className="text-muted-foreground">
                          <Trans>Reversed</Trans>
                        </span>
                      ) : (
                        <button
                          type="button"
                          className={buttonVariants({ variant: "ghost", size: "sm" })}
                          onClick={() => {
                            setError(null);
                            setReverseId(transfer.id);
                          }}
                        >
                          <Trans>Reverse</Trans>
                        </button>
                      )}
                    </div>
                  </CardContent>
                </Card>
              </li>
            ))}
          </ul>
        </>
      )}

      {reverseTarget ? (
        <AlertDialog
          open
          onOpenChange={(open) => {
            if (!open && !busy) setReverseId(null);
          }}
        >
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>
                <Trans>Reverse transfer?</Trans>
              </AlertDialogTitle>
              <AlertDialogDescription>
                <Trans>
                  Return {money(reverseTarget.amountUsd)} from {nameFor(reverseTarget.toUserId)} to{" "}
                  {nameFor(reverseTarget.fromUserId)}.
                </Trans>
              </AlertDialogDescription>
            </AlertDialogHeader>
            {error ? <p className="text-sm text-destructive">{error}</p> : null}
            <AlertDialogFooter>
              <AlertDialogCancel disabled={busy}>
                <Trans>Cancel</Trans>
              </AlertDialogCancel>
              <AlertDialogAction disabled={busy} onClick={() => void confirmReverse()}>
                {busy ? <Trans>Reversing…</Trans> : <Trans>Reverse</Trans>}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      ) : null}
    </section>
  );
}

const ORPHAN_OWNER_FILTER = "__orphan__";
const DEACTIVATED_OWNER_FILTER = "__deactivated__";

type AgentOwnerGroup = {
  key: string;
  title: string;
  email: string | null;
  agents: OpsAgent[];
};

function groupAgentsByOwner(agents: OpsAgent[]): {
  active: AgentOwnerGroup[];
  deactivated: AgentOwnerGroup[];
  orphans: OpsAgent[];
} {
  const activeMap = new Map<string, AgentOwnerGroup>();
  const deactivatedMap = new Map<string, AgentOwnerGroup>();
  const orphans: OpsAgent[] = [];
  for (const agent of agents) {
    if (!agent.owner) {
      orphans.push(agent);
      continue;
    }
    const map = agent.owner.deactivated ? deactivatedMap : activeMap;
    const existing = map.get(agent.owner.id);
    if (existing) {
      existing.agents.push(agent);
      continue;
    }
    const name = agent.owner.name.trim();
    map.set(agent.owner.id, {
      key: agent.owner.id,
      title: name || agent.owner.email,
      email: agent.owner.email,
      agents: [agent],
    });
  }
  const byTitle = (a: AgentOwnerGroup, b: AgentOwnerGroup) =>
    a.title.localeCompare(b.title, undefined, { sensitivity: "base" });
  for (const group of [...activeMap.values(), ...deactivatedMap.values()]) {
    group.agents.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
  }
  orphans.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
  return {
    active: [...activeMap.values()].sort(byTitle),
    deactivated: [...deactivatedMap.values()].sort(byTitle),
    orphans,
  };
}

function AgentsSection({
  interactive,
  fixtureAgents,
  overviewCounts,
}: {
  interactive: boolean;
  fixtureAgents?: OpsAgent[];
  overviewCounts: OpsOverview["agents"];
}) {
  const { t, i18n } = useLingui();
  const [ownerFilter, setOwnerFilter] = useState("all");
  const agentsQuery = useQuery({
    queryKey: ["ops", "agents"],
    queryFn: () => rpc.ops.agents(),
    enabled: interactive,
  });
  const agents = interactive ? agentsQuery.data : (fixtureAgents ?? []);

  const ownerOptions = useMemo(() => {
    const seen = new Map<string, { value: string; label: string }>();
    let hasOrphan = false;
    let hasDeactivated = false;
    for (const agent of agents ?? []) {
      if (!agent.owner) {
        hasOrphan = true;
        continue;
      }
      if (agent.owner.deactivated) hasDeactivated = true;
      if (!seen.has(agent.owner.id)) {
        const name = agent.owner.name.trim();
        seen.set(agent.owner.id, {
          value: agent.owner.id,
          label: name ? `${name} (${agent.owner.email})` : agent.owner.email,
        });
      }
    }
    const options = [...seen.values()].sort((a, b) =>
      a.label.localeCompare(b.label, undefined, { sensitivity: "base" }),
    );
    return { options, hasOrphan, hasDeactivated };
  }, [agents]);

  const filteredAgents = useMemo(() => {
    if (!agents) return [];
    if (ownerFilter === "all") return agents;
    if (ownerFilter === ORPHAN_OWNER_FILTER) return agents.filter((agent) => !agent.owner);
    if (ownerFilter === DEACTIVATED_OWNER_FILTER) {
      return agents.filter((agent) => agent.owner?.deactivated === true);
    }
    return agents.filter((agent) => agent.owner?.id === ownerFilter);
  }, [agents, ownerFilter]);

  const groups = useMemo(() => groupAgentsByOwner(filteredAgents), [filteredAgents]);

  return (
    <section className="space-y-3" data-testid="ops-agents">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0">
          <h2 className="font-medium">
            <Trans>Agents</Trans>
          </h2>
          <p className="text-sm text-muted-foreground">
            {overviewCounts.active} active · {overviewCounts.total} total
          </p>
        </div>
        <div className="w-full min-w-0 sm:w-auto sm:min-w-[14rem]">
          <NativeSelect
            size="sm"
            className="w-full max-w-full"
            value={ownerFilter}
            aria-label={t`Filter by owner`}
            onChange={(event) => setOwnerFilter(event.target.value)}
          >
            <NativeSelectOption value="all">{t`All owners`}</NativeSelectOption>
            {ownerOptions.hasDeactivated ? (
              <NativeSelectOption value={DEACTIVATED_OWNER_FILTER}>
                {t`Deactivated owners`}
              </NativeSelectOption>
            ) : null}
            {ownerOptions.hasOrphan ? (
              <NativeSelectOption value={ORPHAN_OWNER_FILTER}>
                {t`No owner / deleted account`}
              </NativeSelectOption>
            ) : null}
            {ownerOptions.options.map((option) => (
              <NativeSelectOption key={option.value} value={option.value}>
                {option.label}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </div>
      </div>

      {interactive && agentsQuery.isPending ? (
        <Spinner />
      ) : interactive && (agentsQuery.isError || !agentsQuery.data) ? (
        <p className="text-sm text-muted-foreground">
          {errorText(agentsQuery.error, t`Agents unavailable`)}
        </p>
      ) : filteredAgents.length === 0 ? (
        <p className="text-sm text-muted-foreground" data-testid="ops-agents-empty">
          {(agents ?? []).length === 0 && ownerFilter === "all" ? (
            <Trans>No agents yet</Trans>
          ) : (
            <Trans>No agents match this filter.</Trans>
          )}
        </p>
      ) : (
        <div className="space-y-6">
          {groups.active.map((group) => (
            <AgentOwnerGroupBlock
              key={group.key}
              group={group}
              locale={i18n.locale || "en"}
              showKeyBadge
            />
          ))}
          {groups.deactivated.length > 0 ? (
            <div className="space-y-3" data-testid="ops-agents-deactivated">
              <h3 className="text-sm font-medium text-muted-foreground">
                <Trans>Deactivated owners</Trans>
              </h3>
              {groups.deactivated.map((group) => (
                <AgentOwnerGroupBlock
                  key={group.key}
                  group={group}
                  locale={i18n.locale || "en"}
                  showKeyBadge
                />
              ))}
            </div>
          ) : null}
          {groups.orphans.length > 0 ? (
            <AgentOwnerGroupBlock
              key="orphan"
              group={{
                key: "orphan",
                title: t`No owner / deleted account`,
                email: null,
                agents: groups.orphans,
              }}
              locale={i18n.locale || "en"}
              showKeyBadge={false}
              testId="ops-agents-orphans"
            />
          ) : null}
        </div>
      )}
    </section>
  );
}

function AgentOwnerGroupBlock({
  group,
  locale,
  showKeyBadge,
  testId,
}: {
  group: AgentOwnerGroup;
  locale: string;
  showKeyBadge: boolean;
  testId?: string;
}) {
  const { t } = useLingui();
  return (
    <div className="space-y-2" data-testid={testId}>
      <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <h3 className="min-w-0 break-words font-medium">{group.title}</h3>
        {group.email ? (
          <span className="min-w-0 break-all text-sm text-muted-foreground">{group.email}</span>
        ) : null}
        <span className="text-sm text-muted-foreground tabular-nums">
          {t`${plural(group.agents.length, { one: "# agent", other: "# agents" })}`}
        </span>
      </div>
      <ul className="divide-y divide-border/60 rounded-xl border border-border/60">
        {group.agents.map((agent) => (
          <li key={agent.id} className="min-w-0 px-3 py-3 text-sm">
            <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
              <div className="min-w-0 space-y-1">
                <div className="break-words font-medium">{agent.name}</div>
                <dl className="grid grid-cols-1 gap-1 text-muted-foreground sm:grid-cols-2">
                  <div className="min-w-0">
                    <dt className="sr-only">
                      <Trans>Created</Trans>
                    </dt>
                    <dd className="break-words">
                      <Trans>Created</Trans>{" "}
                      <time dateTime={agent.createdAt}>
                        {new Date(agent.createdAt).toLocaleDateString(locale)}
                      </time>
                    </dd>
                  </div>
                  <div className="min-w-0">
                    <dt className="sr-only">
                      <Trans>Last active</Trans>
                    </dt>
                    <dd className="break-words">
                      <Trans>Last active</Trans>{" "}
                      {agent.lastActiveAt ? (
                        <time
                          dateTime={agent.lastActiveAt}
                          title={new Date(agent.lastActiveAt).toLocaleString(locale)}
                        >
                          {formatRelativeTime(agent.lastActiveAt)}
                        </time>
                      ) : (
                        "—"
                      )}
                    </dd>
                  </div>
                </dl>
              </div>
              <div className="flex min-w-0 flex-wrap items-center gap-2 sm:justify-end">
                <Badge variant={agent.status === "archived" ? "outline" : "secondary"}>
                  {agent.status === "archived" ? <Trans>Archived</Trans> : <Trans>Active</Trans>}
                </Badge>
                {showKeyBadge && agent.owner ? (
                  <KeyBadge keyType={agent.keyType} needsReconnect={agent.needsReconnect} />
                ) : null}
              </div>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

function PerformanceSection({ data }: { data: OpsOverview }) {
  const { performance, health } = data;
  return (
    <section className="space-y-3">
      <h2 className="font-medium">
        <Trans>Performance</Trans>
      </h2>
      <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4 text-sm">
        <Stat
          label={<Trans>Median first response</Trans>}
          value={ms(performance.medianFirstResponseMs)}
        />
        <Stat
          label={<Trans>p95 first response</Trans>}
          value={ms(performance.p95FirstResponseMs)}
        />
        <Stat label={<Trans>Median total</Trans>} value={ms(performance.medianTotalMs)} />
        <Stat
          label={<Trans>Errors</Trans>}
          value={
            performance.errorRate == null
              ? "—"
              : `${performance.errorCount}/${performance.runCount} (${pct(performance.errorRate * 100)})`
          }
        />
      </dl>
      <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4 text-sm">
        <Stat label={<Trans>Database</Trans>} value={health.database} />
        <Stat
          label={<Trans>Health</Trans>}
          value={health.degraded ? <Trans>Degraded</Trans> : <Trans>OK</Trans>}
        />
        <Stat label={<Trans>Runtime</Trans>} value={health.runtime ?? "—"} />
        <Stat label={<Trans>Sandbox</Trans>} value={health.sandbox ?? "—"} />
      </dl>
    </section>
  );
}

function RequestLogSection({
  selected,
  onSelect,
  interactive,
  fixtureRows,
}: {
  selected: OpsRequestLogRow | null;
  onSelect: (row: OpsRequestLogRow) => void;
  interactive: boolean;
  fixtureRows?: OpsRequestLogRow[];
}) {
  const log = useQuery({
    queryKey: ["ops", "requestLog"],
    queryFn: () => rpc.ops.requestLog({ limit: 40 }),
    enabled: interactive,
  });
  const rows = interactive ? log.data : (fixtureRows ?? []);

  return (
    <section className="space-y-3">
      <h2 className="font-medium">
        <Trans>Request log</Trans>
      </h2>
      {interactive && log.isPending ? (
        <Spinner />
      ) : interactive && (log.isError || !log.data) ? (
        <p className="text-sm text-muted-foreground">
          {errorText(log.error, "Request log unavailable")}
        </p>
      ) : !rows || rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          <Trans>No recent requests.</Trans>
        </p>
      ) : (
        <>
          <div className="hidden overflow-x-auto md:block">
            <table className="w-full min-w-0 text-left text-sm">
              <thead className="text-muted-foreground">
                <tr className="border-b">
                  <th className="py-2 pr-3 font-normal">
                    <Trans>When</Trans>
                  </th>
                  <th className="py-2 pr-3 font-normal">
                    <Trans>Kind</Trans>
                  </th>
                  <th className="py-2 pr-3 font-normal">
                    <Trans>Model</Trans>
                  </th>
                  <th className="py-2 pr-3 font-normal">
                    <Trans>Cost</Trans>
                  </th>
                  <th className="py-2 font-normal">
                    <Trans>Status</Trans>
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => {
                  const active = selected?.id === row.id;
                  return (
                    <tr
                      key={row.id}
                      className={`border-b border-border/60 ${row.runId || row.threadId ? "cursor-pointer" : ""} ${active ? "bg-muted/40" : ""}`}
                      onClick={() => {
                        if (row.runId || row.threadId) onSelect(row);
                      }}
                    >
                      <td className="py-2 pr-3">{new Date(row.createdAt).toLocaleString()}</td>
                      <td className="py-2 pr-3">
                        {row.kind}
                        {row.sharedKey === true ? " · shared" : null}
                        {row.sharedKey === false ? " · personal" : null}
                      </td>
                      <td className="py-2 pr-3">
                        {row.provider && row.model ? `${row.provider}/${row.model}` : "—"}
                      </td>
                      <td className="py-2 pr-3 tabular-nums">{money(row.costUsd)}</td>
                      <td className="py-2">{row.status ?? row.error ?? "—"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <ul className="grid gap-3 md:hidden">
            {rows.map((row) => {
              const active = selected?.id === row.id;
              const clickable = Boolean(row.runId || row.threadId);
              return (
                <li key={row.id}>
                  <Card size="sm" className={cn(active && "ring-1 ring-border")}>
                    <CardHeader className="gap-1">
                      {clickable ? (
                        <button
                          type="button"
                          className="min-w-0 rounded-md text-start outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
                          onClick={() => onSelect(row)}
                        >
                          <CardTitle className="text-sm font-medium">
                            {new Date(row.createdAt).toLocaleString()}
                          </CardTitle>
                          <CardDescription>
                            {row.kind}
                            {row.sharedKey === true ? " · shared" : null}
                            {row.sharedKey === false ? " · personal" : null}
                          </CardDescription>
                        </button>
                      ) : (
                        <>
                          <CardTitle className="text-sm font-medium">
                            {new Date(row.createdAt).toLocaleString()}
                          </CardTitle>
                          <CardDescription>
                            {row.kind}
                            {row.sharedKey === true ? " · shared" : null}
                            {row.sharedKey === false ? " · personal" : null}
                          </CardDescription>
                        </>
                      )}
                    </CardHeader>
                    <CardContent className="space-y-1 text-sm">
                      <div>{row.provider && row.model ? `${row.provider}/${row.model}` : "—"}</div>
                      <div className="flex justify-between gap-2 tabular-nums text-muted-foreground">
                        <span>{money(row.costUsd)}</span>
                        <span>{row.status ?? row.error ?? "—"}</span>
                      </div>
                    </CardContent>
                  </Card>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </section>
  );
}

function ChatLogSection({
  runId,
  threadId,
  interactive,
}: {
  runId: string | null;
  threadId: string | null;
  interactive: boolean;
}) {
  const chat = useQuery({
    queryKey: ["ops", "chatLog", runId, threadId],
    queryFn: () =>
      rpc.ops.chatLog({
        ...(runId ? { runId } : {}),
        ...(threadId && !runId ? { threadId } : {}),
      }),
    enabled: interactive && Boolean(runId || threadId),
  });

  return (
    <section className="space-y-3">
      <h2 className="font-medium">
        <Trans>Chat log</Trans>
      </h2>
      {!interactive ? (
        <p className="text-sm text-muted-foreground">
          <Trans>No messages for this selection.</Trans>
        </p>
      ) : chat.isPending ? (
        <Spinner />
      ) : chat.isError || !chat.data ? (
        <p className="text-sm text-muted-foreground">
          {errorText(chat.error, "Chat log unavailable")}
        </p>
      ) : (
        <ChatMessages data={chat.data} />
      )}
    </section>
  );
}

function ChatMessages({ data }: { data: OpsChatLog }) {
  if (data.messages.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        <Trans>No messages for this selection.</Trans>
      </p>
    );
  }
  return (
    <ul className="space-y-3 text-sm">
      {data.messages.map((message) => (
        <li key={message.id} className="border-b border-border/60 pb-3">
          <div className="text-muted-foreground">
            {message.role} · {new Date(message.createdAt).toLocaleString()}
          </div>
          <div className="whitespace-pre-wrap break-words">{message.text || "—"}</div>
        </li>
      ))}
    </ul>
  );
}

function Stat({ label, value }: { label: ReactNode; value: ReactNode }) {
  return (
    <div className="rounded-xl border border-border/60 px-3 py-2">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 tabular-nums">{value}</dd>
    </div>
  );
}
