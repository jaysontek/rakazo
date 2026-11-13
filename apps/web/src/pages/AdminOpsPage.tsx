import { Trans, useLingui } from "@lingui/react/macro";
import type { OpsChatLog, OpsOverview, OpsRequestLogRow } from "@rakazo/contracts";
import { buttonVariants, Spinner } from "@rakazo/ui-web";
import { useQuery } from "@tanstack/react-query";
import { ChevronLeft } from "lucide-react";
import type { ReactNode } from "react";
import { useState } from "react";
import { Link, Navigate } from "react-router-dom";
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
  return (
    <>
      <BudgetSection data={data} />
      <AccountsSection accounts={data.accounts} />
      <AgentsSection data={data} />
      <PerformanceSection data={data} />
      <RequestLogSection selected={selected} onSelect={setSelected} />
      {selected?.runId || selected?.threadId ? (
        <ChatLogSection runId={selected.runId} threadId={selected.threadId} />
      ) : null}
    </>
  );
}

function BudgetSection({ data }: { data: OpsOverview }) {
  const budget = data.sharedKeyBudget;
  return (
    <section className="space-y-3">
      <h2 className="font-medium">
        <Trans>Shared-key week</Trans>
      </h2>
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

function AccountsSection({ accounts }: { accounts: OpsOverview["accounts"] }) {
  return (
    <section className="space-y-3">
      <h2 className="font-medium">
        <Trans>Accounts</Trans>
      </h2>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[40rem] text-left text-sm">
          <thead className="text-muted-foreground">
            <tr className="border-b">
              <th className="py-2 pr-3 font-normal">
                <Trans>Account</Trans>
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
              <th className="py-2 font-normal">
                <Trans>Shared week</Trans>
              </th>
            </tr>
          </thead>
          <tbody>
            {accounts.map((account) => {
              const budget = account.sharedKeyBudget;
              return (
                <tr key={account.userId} className="border-b border-border/60 align-top">
                  <td className="py-2 pr-3">
                    <div>{account.name || account.email}</div>
                    <div className="text-muted-foreground">{account.email}</div>
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
                  <td className="py-2">
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
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
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
