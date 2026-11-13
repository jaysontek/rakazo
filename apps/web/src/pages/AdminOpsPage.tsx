import { Trans, useLingui } from "@lingui/react/macro";
import type { OpsAccount, OpsChatLog, OpsOverview, OpsRequestLogRow } from "@rakazo/contracts";
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
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Input,
  ListSearchInput,
  NativeSelect,
  NativeSelectOption,
  Spinner,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  buttonVariants,
  cn,
} from "@rakazo/ui-web";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, ArrowUpDown, ChevronLeft, MoreHorizontal } from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useMemo, useState } from "react";
import { Link, Navigate, useNavigate } from "react-router-dom";
import { PageLoading } from "../components/PageLoading";
import { useSpaceQueries } from "../lib/query";
import { rpc } from "../lib/rpc";
import { errorText } from "../lib/user-error";
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
  return `${Math.round(value)}%`;
}

function accountLabel(account: Pick<OpsAccount, "name" | "email">): string {
  return account.name || account.email;
}

function KeyBadge({
  keyType,
  pendingSharedBudget,
}: {
  keyType: OpsAccount["keyType"];
  pendingSharedBudget?: boolean;
}) {
  if (keyType === "company") {
    if (pendingSharedBudget) {
      return (
        <Badge variant="secondary">
          <Trans>Company key — pending admin approval</Trans>
        </Badge>
      );
    }
    return (
      <Badge variant="secondary">
        <Trans>Company</Trans>
      </Badge>
    );
  }
  if (keyType === "personal") {
    return (
      <Badge variant="outline">
        <Trans>Personal</Trans>
      </Badge>
    );
  }
  return <span className="text-muted-foreground">—</span>;
}

function pendingSharedBudgetApproval(account: OpsAccount): boolean {
  return (
    account.keyType === "company" &&
    Boolean(account.sharedKeyBudget?.configured) &&
    !account.sharedKeyBudget?.member
  );
}

function UsageBar({
  percent,
  label,
  hardStopped,
}: {
  percent: number;
  label: string;
  hardStopped?: boolean;
}) {
  const value = Math.min(100, Math.max(0, Math.floor(percent)));
  return (
    <div className="space-y-1">
      <div className="flex items-baseline justify-between gap-2 text-xs">
        <span className={cn("tabular-nums", hardStopped && "text-destructive")}>{pct(value)}</span>
        {hardStopped ? (
          <span className="text-destructive">
            <Trans>Hard-stopped</Trans>
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
            hardStopped ? "bg-destructive" : "bg-foreground",
          )}
          style={{ width: `${value}%` }}
        />
      </div>
    </div>
  );
}

function resetCountdown(resetsAt: string, nowMs = Date.now()): string {
  const msLeft = new Date(resetsAt).getTime() - nowMs;
  if (!(msLeft > 0)) return "0h";
  const totalHours = Math.floor(msLeft / 3_600_000);
  const days = Math.floor(totalHours / 24);
  const hours = totalHours % 24;
  if (days > 0) return `${days}d ${hours}h`;
  const minutes = Math.floor((msLeft % 3_600_000) / 60_000);
  if (totalHours > 0) return `${totalHours}h ${minutes}m`;
  return `${Math.max(1, minutes)}m`;
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
}: {
  data: OpsOverview;
  onChanged: () => void;
  selected: OpsRequestLogRow | null;
  onSelect: (row: OpsRequestLogRow) => void;
  /** When false, mutation controls stay visible but RPC is not called (fixture). */
  interactive?: boolean;
}) {
  return (
    <div data-testid="ops-dashboard" className="space-y-6">
      <KpiRow data={data} onCapSaved={onChanged} interactive={interactive} />
      <Tabs defaultValue="accounts" className="gap-4">
        <TabsList variant="line" className="w-full max-w-full flex-wrap justify-start">
          <TabsTrigger value="accounts">
            <Trans>Accounts</Trans>
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
          <AccountsSection accounts={data.accounts} onChanged={onChanged} interactive={interactive} />
        </TabsContent>
        <TabsContent value="transfers" className="space-y-4">
          <TransfersSection data={data} onChanged={onChanged} interactive={interactive} />
        </TabsContent>
        <TabsContent value="admins" className="space-y-4">
          <AdminGrantsSection data={data} onChanged={onChanged} interactive={interactive} />
        </TabsContent>
        <TabsContent value="audit" className="space-y-8">
          <AgentsSection data={data} />
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

function KpiRow({
  data,
  onCapSaved,
  interactive,
}: {
  data: OpsOverview;
  onCapSaved: () => void;
  interactive: boolean;
}) {
  const { t } = useLingui();
  const budget = data.sharedKeyBudget;
  const [draft, setDraft] = useState(
    budget.monthlyCapUsd != null ? String(budget.monthlyCapUsd) : "",
  );
  const [saving, setSaving] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const pool = budget.weekPoolUsd;
  const spent = budget.weekSpentUsd;
  const poolPct =
    pool != null && pool > 0 ? Math.min(100, Math.max(0, (spent / pool) * 100)) : 0;

  useEffect(() => {
    setDraft(budget.monthlyCapUsd != null ? String(budget.monthlyCapUsd) : "");
  }, [budget.monthlyCapUsd]);

  function requestSaveCap() {
    const value = Number(draft);
    if (!Number.isFinite(value) || value <= 0 || value > 1_000_000) {
      setError(t`Enter a positive amount up to $1,000,000`);
      return;
    }
    setError(null);
    setConfirmOpen(true);
  }

  async function confirmSaveCap() {
    const value = Number(draft);
    if (!interactive) {
      setConfirmOpen(false);
      setEditing(false);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const result = await rpc.ops.setSharedKeyMonthlyBudget({ monthlyCapUsd: value });
      setDraft(String(result.monthlyCapUsd));
      setConfirmOpen(false);
      setEditing(false);
      onCapSaved();
    } catch (err) {
      setError(errorText(err, "Could not save monthly cap"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4" aria-label={t`Shared-key week`}>
      <Card size="sm" data-testid="shared-key-monthly-cap">
        <CardHeader className="gap-1">
          <CardDescription>
            <Trans>Monthly cap</Trans>
          </CardDescription>
          <CardTitle className="tabular-nums">
            {budget.monthlyCapUsd == null ? (
              <span className="text-muted-foreground font-normal">
                <Trans>Not configured</Trans>
              </span>
            ) : (
              money(budget.monthlyCapUsd)
            )}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {editing ? (
            <div className="flex flex-wrap items-center gap-2">
              <label className="flex min-w-0 flex-1 items-center gap-1 text-sm">
                <span className="text-muted-foreground" aria-hidden="true">
                  $
                </span>
                <Input
                  type="number"
                  min={0.01}
                  max={1_000_000}
                  step="any"
                  inputMode="decimal"
                  aria-label={t`Monthly shared Gemini key cap`}
                  className="tabular-nums"
                  value={draft}
                  disabled={saving}
                  onChange={(event) => setDraft(event.target.value)}
                />
              </label>
              <button
                type="button"
                className={buttonVariants({ variant: "outline", size: "sm" })}
                disabled={saving}
                onClick={() => requestSaveCap()}
              >
                {saving ? <Spinner className="size-4" /> : <Trans>Save</Trans>}
              </button>
              <button
                type="button"
                className={buttonVariants({ variant: "ghost", size: "sm" })}
                disabled={saving}
                onClick={() => {
                  setEditing(false);
                  setDraft(budget.monthlyCapUsd != null ? String(budget.monthlyCapUsd) : "");
                  setError(null);
                }}
              >
                <Trans>Cancel</Trans>
              </button>
            </div>
          ) : (
            <button
              type="button"
              className={buttonVariants({ variant: "ghost", size: "sm" })}
              onClick={() => setEditing(true)}
            >
              <Trans>Edit</Trans>
            </button>
          )}
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
        </CardContent>
      </Card>

      <Card size="sm">
        <CardHeader className="gap-1">
          <CardDescription>
            <Trans>Shared-key week</Trans>
          </CardDescription>
          <CardTitle className="tabular-nums">
            {pool == null ? "—" : `${money(spent)} / ${money(pool)}`}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          <UsageBar
            percent={poolPct}
            label={t`Weekly shared-key pool used`}
          />
          <p className="text-xs text-muted-foreground">
            <Trans>Resets in {resetCountdown(budget.resetsAt)}</Trans>
            {" · "}
            {budget.timezone}
          </p>
        </CardContent>
      </Card>

      <Card size="sm">
        <CardHeader className="gap-1">
          <CardDescription>
            <Trans>Roster</Trans>
          </CardDescription>
          <CardTitle className="tabular-nums">{budget.memberCount}</CardTitle>
        </CardHeader>
      </Card>

      <Card size="sm">
        <CardHeader className="gap-1">
          <CardDescription>
            <Trans>Spend</Trans>
          </CardDescription>
          <CardTitle className="tabular-nums">{money(data.spend.totalCostUsd)}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-1 text-xs text-muted-foreground">
          <div className="flex justify-between gap-2">
            <Trans>Shared</Trans>
            <span className="tabular-nums text-foreground">{money(data.spend.sharedKeyCostUsd)}</span>
          </div>
          <div className="flex justify-between gap-2">
            <Trans>Personal</Trans>
            <span className="tabular-nums text-foreground">
              {money(data.spend.personalKeyCostUsd)}
            </span>
          </div>
        </CardContent>
      </Card>

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              <Trans>Save monthly shared-key cap?</Trans>
            </AlertDialogTitle>
            <AlertDialogDescription>
              <Trans>
                This sets the deployment monthly cap for the shared Gemini key to{" "}
                {money(Number(draft) || 0)}.
              </Trans>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={saving}>
              <Trans>Cancel</Trans>
            </AlertDialogCancel>
            <AlertDialogAction disabled={saving} onClick={() => void confirmSaveCap()}>
              <Trans>Save</Trans>
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
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
  addBusy,
  onImpersonate,
  onTransfer,
  onAddToSharedBudget,
}: {
  account: OpsAccount;
  canTransfer: boolean;
  transferDisabled: boolean;
  canAddToSharedBudget: boolean;
  addBusy: boolean;
  onImpersonate: (account: OpsAccount) => void;
  onTransfer: (account: OpsAccount) => void;
  onAddToSharedBudget: (account: OpsAccount) => void;
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
        {canTransfer ? (
          <DropdownMenuItem disabled={transferDisabled} onClick={() => onTransfer(account)}>
            <Trans>Transfer</Trans>
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
  const navigate = useNavigate();
  const queries = useSpaceQueries();
  const queryClient = useQueryClient();
  const roster = accounts.filter((account) => account.sharedKeyBudget?.member);
  const [impersonate, setImpersonate] = useState<OpsAccount | null>(null);
  const [transferFrom, setTransferFrom] = useState<OpsAccount | null>(null);
  const [transferToId, setTransferToId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [keyFilter, setKeyFilter] = useState<"all" | "company" | "personal" | "none">("all");
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
      const next = await rpc.ops.startImpersonation({ userId: impersonate.userId });
      queryClient.setQueryData(queries.me.queryKey(), next);
      await queryClient.invalidateQueries();
      setImpersonate(null);
      navigate("/app", { replace: true });
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
      await rpc.ops.addSharedKeyBudgetMember({ userId: account.userId });
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
        />
        <div className="text-xs text-muted-foreground tabular-nums">
          {money(budget.remainingUsd)} left
        </div>
      </div>
    );
  }

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
            onChange={(event) =>
              setKeyFilter(event.target.value as "all" | "company" | "personal" | "none")
            }
          >
            <NativeSelectOption value="all">{t`All keys`}</NativeSelectOption>
            <NativeSelectOption value="company">{t`Company`}</NativeSelectOption>
            <NativeSelectOption value="personal">{t`Personal`}</NativeSelectOption>
            <NativeSelectOption value="none">{t`No key`}</NativeSelectOption>
          </NativeSelect>
        </label>
      </div>

      <div className="hidden md:block">
        <div className="overflow-x-auto">
          <table className="w-full min-w-0 text-left text-sm">
            <thead className="text-muted-foreground">
              <tr className="border-b">
                <th className="py-2 pr-3 font-normal" aria-sort={sortAriaValue("account", sortKey, sortDir)}>
                  <SortButton column="account" sortKey={sortKey} sortDir={sortDir} onToggle={toggleSort}>
                    <Trans>Account</Trans>
                  </SortButton>
                </th>
                <th className="py-2 pr-3 font-normal" aria-sort={sortAriaValue("key", sortKey, sortDir)}>
                  <SortButton column="key" sortKey={sortKey} sortDir={sortDir} onToggle={toggleSort}>
                    <Trans>Key</Trans>
                  </SortButton>
                </th>
                <th className="py-2 pr-3 font-normal">
                  <Trans>Model</Trans>
                </th>
                <th className="py-2 pr-3 font-normal" aria-sort={sortAriaValue("tokens", sortKey, sortDir)}>
                  <SortButton column="tokens" sortKey={sortKey} sortDir={sortDir} onToggle={toggleSort}>
                    <Trans>Tokens</Trans>
                  </SortButton>
                </th>
                <th className="py-2 pr-3 font-normal" aria-sort={sortAriaValue("spend", sortKey, sortDir)}>
                  <SortButton column="spend" sortKey={sortKey} sortDir={sortDir} onToggle={toggleSort}>
                    <Trans>Spend</Trans>
                  </SortButton>
                </th>
                <th className="py-2 pr-3 font-normal" aria-sort={sortAriaValue("sharedWeek", sortKey, sortDir)}>
                  <SortButton column="sharedWeek" sortKey={sortKey} sortDir={sortDir} onToggle={toggleSort}>
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
                    />
                  </td>
                  <td className="py-3 pr-3">
                    {account.modelProvider && account.modelId ? (
                      <Badge variant="outline" className="max-w-[12rem] truncate font-normal">
                        {account.modelProvider}/{account.modelId}
                      </Badge>
                    ) : (
                      "—"
                    )}
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
                    <AccountActions
                      account={account}
                      canTransfer={Boolean(account.sharedKeyBudget?.member)}
                      transferDisabled={roster.length < 2}
                      canAddToSharedBudget={pendingSharedBudgetApproval(account)}
                      addBusy={busy}
                      onImpersonate={(next) => {
                        setError(null);
                        setImpersonate(next);
                      }}
                      onTransfer={(next) => {
                        setError(null);
                        setTransferFrom(next);
                      }}
                      onAddToSharedBudget={(next) => {
                        void addToSharedBudget(next);
                      }}
                    />
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
                <AccountActions
                  account={account}
                  canTransfer={Boolean(account.sharedKeyBudget?.member)}
                  transferDisabled={roster.length < 2}
                  canAddToSharedBudget={pendingSharedBudgetApproval(account)}
                  addBusy={busy}
                  onImpersonate={(next) => {
                    setError(null);
                    setImpersonate(next);
                  }}
                  onTransfer={(next) => {
                    setError(null);
                    setTransferFrom(next);
                  }}
                  onAddToSharedBudget={(next) => {
                    void addToSharedBudget(next);
                  }}
                />
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="flex flex-wrap items-center gap-2">
                  <KeyBadge
                    keyType={account.keyType}
                    pendingSharedBudget={pendingSharedBudgetApproval(account)}
                  />
                  {account.modelProvider && account.modelId ? (
                    <Badge variant="outline" className="font-normal">
                      {account.modelProvider}/{account.modelId}
                    </Badge>
                  ) : null}
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

function AgentsSection({ data }: { data: OpsOverview }) {
  return (
    <section className="space-y-3">
      <h2 className="font-medium">
        <Trans>Agents</Trans>
      </h2>
      <p className="text-sm text-muted-foreground">
        {data.agents.active} active · {data.agents.total} total
      </p>
      <ul className="columns-1 gap-x-8 text-sm sm:columns-2 lg:columns-3">
        {data.agents.names.map((agent) => (
          <li key={agent.id} className="break-inside-avoid py-0.5">
            {agent.name}
          </li>
        ))}
      </ul>
    </section>
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
        <div className="overflow-x-auto">
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
