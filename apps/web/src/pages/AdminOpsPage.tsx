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
  NativeSelect,
  NativeSelectOption,
  buttonVariants,
  Spinner,
} from "@rakazo/ui-web";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronLeft } from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";
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

function KeyLabel({
  keyType,
  onRoster,
}: {
  keyType: OpsAccount["keyType"];
  onRoster: boolean;
}) {
  if (keyType === "company") {
    return onRoster ? (
      <Trans>Company</Trans>
    ) : (
      <Trans>Company key (not on budget roster)</Trans>
    );
  }
  if (keyType === "personal") return <Trans>Personal</Trans>;
  return <span className="text-muted-foreground">—</span>;
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
        <div className="mx-auto max-w-5xl space-y-10 px-4 py-6">
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

  const data = overview.data;
  const refetch = () => {
    void overview.refetch();
  };

  return (
    <>
      <BudgetSection data={data} onCapSaved={refetch} />
      <AccountsSection accounts={data.accounts} onChanged={refetch} />
      <AdminGrantsSection data={data} onChanged={refetch} />
      <TransfersSection data={data} onChanged={refetch} />
      <AgentsSection data={data} />
      <PerformanceSection data={data} />
      <RequestLogSection selected={selected} onSelect={setSelected} />
      {selected?.runId || selected?.threadId ? (
        <ChatLogSection runId={selected.runId} threadId={selected.threadId} />
      ) : null}
    </>
  );
}

function BudgetSection({ data, onCapSaved }: { data: OpsOverview; onCapSaved: () => void }) {
  const { t } = useLingui();
  const budget = data.sharedKeyBudget;
  const [draft, setDraft] = useState(
    budget.monthlyCapUsd != null ? String(budget.monthlyCapUsd) : "",
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setDraft(budget.monthlyCapUsd != null ? String(budget.monthlyCapUsd) : "");
  }, [budget.monthlyCapUsd]);

  async function saveCap() {
    const value = Number(draft);
    if (!Number.isFinite(value) || value <= 0 || value > 1_000_000) {
      setError(t`Enter a positive amount up to $1,000,000`);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const result = await rpc.ops.setSharedKeyMonthlyBudget({ monthlyCapUsd: value });
      setDraft(String(result.monthlyCapUsd));
      onCapSaved();
    } catch (err) {
      setError(errorText(err, "Could not save monthly cap"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="space-y-3">
      <h2 className="font-medium">
        <Trans>Shared-key week</Trans>
      </h2>
      <div
        data-testid="shared-key-monthly-cap"
        className="flex flex-wrap items-end gap-3 rounded-xl border border-border px-4 py-3"
      >
        <label className="min-w-[10rem] flex-1 space-y-1 text-sm">
          <span className="text-muted-foreground">
            <Trans>Monthly shared Gemini key cap</Trans>
          </span>
          <div className="flex items-center gap-2">
            <span className="text-muted-foreground" aria-hidden="true">
              $
            </span>
            <input
              type="number"
              min={0.01}
              max={1_000_000}
              step="any"
              inputMode="decimal"
              aria-label={t`Monthly shared Gemini key cap`}
              className="h-9 w-full min-w-0 rounded-md border border-border bg-background px-3 text-sm tabular-nums"
              value={draft}
              disabled={saving}
              onChange={(event) => setDraft(event.target.value)}
            />
          </div>
        </label>
        <button
          type="button"
          className={buttonVariants({ variant: "outline", size: "sm" })}
          disabled={saving}
          onClick={() => void saveCap()}
        >
          {saving ? <Spinner className="size-4" /> : <Trans>Save</Trans>}
        </button>
      </div>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4 text-sm">
        <Stat
          label={<Trans>Monthly cap</Trans>}
          value={
            budget.monthlyCapUsd == null ? (
              <span className="text-muted-foreground">
                <Trans>Not configured</Trans>
              </span>
            ) : (
              money(budget.monthlyCapUsd)
            )
          }
        />
        <Stat
          label={<Trans>Roster</Trans>}
          value={
            budget.rosterConfigured ? (
              budget.memberCount
            ) : (
              <span className="text-muted-foreground">
                <Trans>Not configured</Trans>
              </span>
            )
          }
        />
        <Stat
          label={<Trans>Week</Trans>}
          value={`${new Date(budget.weekStartsAt).toLocaleString()} → ${new Date(budget.resetsAt).toLocaleString()}`}
        />
        <Stat label={<Trans>Timezone</Trans>} value={budget.timezone} />
      </dl>
      <dl className="grid gap-3 sm:grid-cols-3 text-sm">
        <Stat label={<Trans>Total spend</Trans>} value={money(data.spend.totalCostUsd)} />
        <Stat label={<Trans>Shared-key spend</Trans>} value={money(data.spend.sharedKeyCostUsd)} />
        <Stat
          label={<Trans>Personal-key spend</Trans>}
          value={money(data.spend.personalKeyCostUsd)}
        />
      </dl>
    </section>
  );
}

function AccountsSection({
  accounts,
  onChanged,
}: {
  accounts: OpsOverview["accounts"];
  onChanged: () => void;
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

  async function confirmImpersonate() {
    if (!impersonate) return;
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

  return (
    <section className="space-y-3">
      <h2 className="font-medium">
        <Trans>Accounts</Trans>
      </h2>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[48rem] text-left text-sm">
          <thead className="text-muted-foreground">
            <tr className="border-b">
              <th className="py-2 pr-3 font-normal">
                <Trans>Account</Trans>
              </th>
              <th className="py-2 pr-3 font-normal">
                <Trans>Key</Trans>
              </th>
              <th className="py-2 pr-3 font-normal">
                <Trans>Model</Trans>
              </th>
              <th className="py-2 pr-3 font-normal">
                <Trans>Tokens</Trans>
              </th>
              <th className="py-2 pr-3 font-normal">
                <Trans>Spend</Trans>
              </th>
              <th className="py-2 pr-3 font-normal">
                <Trans>Shared week</Trans>
              </th>
              <th className="py-2 font-normal">
                <Trans>Actions</Trans>
              </th>
            </tr>
          </thead>
          <tbody>
            {accounts.map((account) => {
              const budget = account.sharedKeyBudget;
              const canTransfer = Boolean(budget?.member);
              return (
                <tr key={account.userId} className="border-b border-border/60 align-top">
                  <td className="py-2 pr-3">
                    <div>{account.name || account.email}</div>
                    <div className="text-muted-foreground">{account.email}</div>
                  </td>
                  <td className="py-2 pr-3">
                    <KeyLabel
                      keyType={account.keyType}
                      onRoster={Boolean(account.sharedKeyBudget?.member)}
                    />
                  </td>
                  <td className="py-2 pr-3">
                    {account.modelProvider && account.modelId
                      ? `${account.modelProvider}/${account.modelId}`
                      : "—"}
                  </td>
                  <td className="py-2 pr-3">{tokens(account.totalTokens)}</td>
                  <td className="py-2 pr-3">
                    <div>{money(account.totalCostUsd)}</div>
                    <div className="text-muted-foreground">
                      <Trans>Shared {money(account.sharedKeyCostUsd)}</Trans>
                      {" · "}
                      <Trans>Personal {money(account.personalKeyCostUsd)}</Trans>
                    </div>
                  </td>
                  <td className="py-2 pr-3">
                    {!budget ? (
                      "—"
                    ) : !budget.configured ? (
                      <span className="text-muted-foreground">
                        <Trans>Cap unset</Trans>
                      </span>
                    ) : !budget.member ? (
                      <span className="text-muted-foreground">
                        <Trans>Not on roster</Trans>
                      </span>
                    ) : (
                      <div>
                        <div>
                          {pct(budget.percentUsed)} · {money(budget.remainingUsd)} left
                        </div>
                        {budget.hardStopped ? (
                          <div className="text-destructive">
                            <Trans>Hard-stopped</Trans>
                          </div>
                        ) : null}
                      </div>
                    )}
                  </td>
                  <td className="py-2">
                    <div className="flex flex-wrap gap-1">
                      <button
                        type="button"
                        className={buttonVariants({ variant: "ghost", size: "sm" })}
                        onClick={() => {
                          setError(null);
                          setImpersonate(account);
                        }}
                      >
                        <Trans>Impersonate</Trans>
                      </button>
                      {canTransfer ? (
                        <button
                          type="button"
                          className={buttonVariants({ variant: "ghost", size: "sm" })}
                          disabled={roster.length < 2}
                          onClick={() => {
                            setError(null);
                            setTransferFrom(account);
                          }}
                        >
                          <Trans>Transfer</Trans>
                        </button>
                      ) : null}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

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

function AdminGrantsSection({ data, onChanged }: { data: OpsOverview; onChanged: () => void }) {
  const { t } = useLingui();
  const grants = data.adminGrants;
  const grantedIds = new Set(grants.map((grant) => grant.userId));
  const candidates = data.accounts.filter((account) => !grantedIds.has(account.userId));
  const [userId, setUserId] = useState(candidates[0]?.userId ?? "");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [removeTarget, setRemoveTarget] = useState<(typeof grants)[number] | null>(null);
  const candidateIds = candidates.map((account) => account.userId).join("\0");

  useEffect(() => {
    const ids = candidateIds ? candidateIds.split("\0") : [];
    setUserId((current) => (ids.includes(current) ? current : (ids[0] ?? "")));
  }, [candidateIds]);

  async function addGrant() {
    if (!userId) return;
    setBusy("add");
    setError(null);
    try {
      await rpc.ops.addAdminGrant({ userId });
      onChanged();
    } catch (err) {
      setError(errorText(err, t`Could not add admin`));
    } finally {
      setBusy(null);
    }
  }

  async function confirmRemove() {
    if (!removeTarget) return;
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
      <h2 className="font-medium">
        <Trans>Admins</Trans>
      </h2>
      <ul className="divide-y divide-border/60 text-sm">
        {grants.map((grant) => (
          <li key={grant.userId} className="flex items-center gap-3 py-2">
            <div className="min-w-0 flex-1">
              <div>{grant.name || grant.email}</div>
              <div className="text-muted-foreground">{grant.email}</div>
            </div>
            {grant.envBootstrap ? (
              <span className="text-muted-foreground">
                <Trans>Env</Trans>
              </span>
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
            onClick={() => void addGrant()}
          >
            {busy === "add" ? <Spinner className="size-4" /> : <Trans>Grant</Trans>}
          </button>
        </div>
      ) : null}
      {error && !removeTarget ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
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

function TransfersSection({ data, onChanged }: { data: OpsOverview; onChanged: () => void }) {
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
      <h2 className="font-medium">
        <Trans>Transfers</Trans>
      </h2>
      {transfers.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          <Trans>None this week.</Trans>
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[36rem] text-left text-sm">
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
                  <td className="py-2 pr-3">
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
      <ul className="columns-1 gap-x-8 text-sm sm:columns-2">
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
      <p className="text-xs text-muted-foreground">
        Latency from run timing fields over the last {performance.sampleWindowHours} hours.
      </p>
    </section>
  );
}

function RequestLogSection({
  selected,
  onSelect,
}: {
  selected: OpsRequestLogRow | null;
  onSelect: (row: OpsRequestLogRow) => void;
}) {
  const log = useQuery({
    queryKey: ["ops", "requestLog"],
    queryFn: () => rpc.ops.requestLog({ limit: 40 }),
  });

  return (
    <section className="space-y-3">
      <h2 className="font-medium">
        <Trans>Request log</Trans>
      </h2>
      {log.isPending ? (
        <Spinner />
      ) : log.isError || !log.data ? (
        <p className="text-sm text-muted-foreground">
          {errorText(log.error, "Request log unavailable")}
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[40rem] text-left text-sm">
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
              {log.data.map((row) => {
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
                    <td className="py-2 pr-3">{money(row.costUsd)}</td>
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

function ChatLogSection({ runId, threadId }: { runId: string | null; threadId: string | null }) {
  const chat = useQuery({
    queryKey: ["ops", "chatLog", runId, threadId],
    queryFn: () =>
      rpc.ops.chatLog({
        ...(runId ? { runId } : {}),
        ...(threadId && !runId ? { threadId } : {}),
      }),
    enabled: Boolean(runId || threadId),
  });

  return (
    <section className="space-y-3">
      <h2 className="font-medium">
        <Trans>Chat log</Trans>
      </h2>
      {chat.isPending ? (
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
    <div>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="mt-0.5">{value}</dd>
    </div>
  );
}
