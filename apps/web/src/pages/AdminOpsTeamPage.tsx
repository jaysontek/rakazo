import { Trans, useLingui } from "@lingui/react/macro";
import type { OpsTeam, OpsTeamMember } from "@rakazo/contracts";
import {
  Badge,
  buttonVariants,
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
  Spinner,
} from "@rakazo/ui-web";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronLeft } from "lucide-react";
import { useState } from "react";
import { Link, Navigate, useParams } from "react-router-dom";
import { ModelBadge } from "../components/ai/model-badge";
import { PageLoading } from "../components/PageLoading";
import { hardSwitchImpersonation } from "../lib/impersonation-switch";
import { storeImpersonationTeammates } from "../lib/impersonation-teammates";
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

function memberLabel(member: Pick<OpsTeamMember, "name" | "email">): string {
  return member.name || member.email;
}

function KeyBadge({ keyType }: { keyType: OpsTeamMember["keyType"] }) {
  if (keyType === "personal") {
    return (
      <Badge variant="outline" className="shrink-0">
        <Trans>Personal API</Trans>
      </Badge>
    );
  }
  return (
    <Badge variant="secondary" className="shrink-0">
      <Trans>Company API</Trans>
    </Badge>
  );
}

export function AdminOpsTeamPage() {
  const { t } = useLingui();
  const { organizationId } = useParams<{ organizationId: string }>();
  const me = useQuery(useSpaceQueries().me.queryOptions());
  if (me.isPending) return <PageLoading />;
  if (!me.data?.isAdmin) return <Navigate to="/app" replace />;
  if (!organizationId) return <Navigate to="/admin/ops" replace />;

  return (
    <div className="flex h-full min-w-0 flex-col overflow-hidden bg-background text-foreground">
      <WindowChrome />
      <header className="flex items-center gap-3 border-b px-4 py-3">
        <Link
          to="/admin/ops"
          className={buttonVariants({ variant: "ghost", size: "icon" })}
          aria-label={t`Back`}
        >
          <ChevronLeft />
        </Link>
        <h1 className="flex-1 font-medium">
          <Trans>Team</Trans>
        </h1>
      </header>
      <main className="min-h-0 flex-1 overflow-y-auto">
        <div className="w-full space-y-6 px-4 py-6 sm:px-6 lg:px-8">
          <TeamDashboard organizationId={organizationId} />
        </div>
      </main>
    </div>
  );
}

function TeamDashboard({ organizationId }: { organizationId: string }) {
  const { t } = useLingui();
  const catalogQuery = useQuery({
    queryKey: ["models", "list"],
    queryFn: () => rpc.models.list(),
  });
  const catalog = catalogQuery.data ?? [];
  const team = useQuery({
    queryKey: ["ops", "team", organizationId],
    queryFn: () => rpc.ops.team({ organizationId }),
  });

  if (team.isPending) {
    return (
      <div className="flex justify-center py-16">
        <Spinner />
      </div>
    );
  }
  if (team.isError || !team.data) {
    return (
      <p className="text-sm text-muted-foreground">
        {errorText(team.error, t`Could not load team`)}
      </p>
    );
  }

  return <TeamView data={team.data} />;
}

export function TeamView({ data }: { data: OpsTeam }) {
  const { t } = useLingui();
  const queryClient = useQueryClient();
  const [busyUserId, setBusyUserId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function viewAs(member: OpsTeamMember) {
    setBusyUserId(member.userId);
    setError(null);
    try {
      storeImpersonationTeammates(
        data.organizationId,
        data.members.map((row) => ({
          userId: row.userId,
          name: row.name,
          email: row.email,
        })),
      );
      await rpc.ops.startImpersonation({
        userId: member.userId,
        organizationId: data.organizationId,
      });
      hardSwitchImpersonation({ queryClient, target: "/app" });
    } catch (err) {
      setError(errorText(err, t`Could not impersonate`));
      setBusyUserId(null);
    }
  }

  return (
    <div data-testid="ops-team" className="space-y-6">
      <div>
        <h2 className="text-lg font-medium">{data.organizationName}</h2>
        <p className="text-sm text-muted-foreground">
          {data.memberCount} <Trans>members</Trans>
          {" · "}
          {data.agents.active}/{data.agents.total} <Trans>agents</Trans>
          {" · "}
          {money(data.spend.totalCostUsd)}
          {" · "}
          {tokens(data.spend.totalTokens)} <Trans>tokens</Trans>
        </p>
      </div>

      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}

      <div className="hidden md:block">
        <div className="overflow-x-auto">
          <table className="w-full min-w-0 text-left text-sm">
            <thead className="text-muted-foreground">
              <tr className="border-b">
                <th className="py-2 pr-3 font-normal">
                  <Trans>Member</Trans>
                </th>
                <th className="py-2 pr-3 font-normal">
                  <Trans>Key</Trans>
                </th>
                <th className="py-2 pr-3 font-normal">
                  <Trans>Model</Trans>
                </th>
                <th className="py-2 pr-3 font-normal">
                  <Trans>Agents</Trans>
                </th>
                <th className="py-2 pr-3 font-normal">
                  <Trans>Spend</Trans>
                </th>
                <th className="py-2 pr-3 font-normal">
                  <Trans>Shared week</Trans>
                </th>
                <th className="py-2 font-normal">
                  <span className="sr-only">
                    <Trans>Actions</Trans>
                  </span>
                </th>
              </tr>
            </thead>
            <tbody>
              {data.members.map((member) => (
                <tr key={member.userId} className="border-b border-border/60 align-top">
                  <td className="py-3 pr-3">
                    <div className="font-medium">{memberLabel(member)}</div>
                    <div className="text-muted-foreground break-all">{member.email}</div>
                  </td>
                  <td className="py-3 pr-3">
                    <KeyBadge keyType={member.keyType} />
                  </td>
                  <td className="py-3 pr-3">
                    <ModelBadge
                      provider={member.modelProvider}
                      modelId={member.modelId}
                      source={member.modelSource}
                      catalog={catalog}
                    />
                  </td>
                  <td className="py-3 pr-3 tabular-nums">{member.agentCount}</td>
                  <td className="py-3 pr-3">
                    <div className="tabular-nums">{money(member.totalCostUsd)}</div>
                    <div className="text-xs text-muted-foreground">
                      <Trans>Shared {money(member.sharedKeyCostUsd)}</Trans>
                      {" · "}
                      <Trans>Personal {money(member.personalKeyCostUsd)}</Trans>
                    </div>
                  </td>
                  <td className="py-3 pr-3 tabular-nums">
                    {member.sharedKeyBudget?.member
                      ? money(member.sharedKeyBudget.remainingUsd)
                      : "—"}
                  </td>
                  <td className="py-3">
                    <button
                      type="button"
                      className={buttonVariants({ variant: "outline", size: "sm" })}
                      disabled={busyUserId != null || member.deactivated}
                      onClick={() => void viewAs(member)}
                    >
                      {busyUserId === member.userId ? (
                        <Spinner className="size-4" />
                      ) : (
                        <Trans>View as</Trans>
                      )}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <ul className="grid gap-3 md:hidden">
        {data.members.map((member) => (
          <li key={member.userId}>
            <Card size="sm">
              <CardHeader className="gap-2">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0 w-full">
                    <CardTitle className="min-w-0 w-full truncate">{memberLabel(member)}</CardTitle>
                    <CardDescription className="break-all">{member.email}</CardDescription>
                  </div>
                  <KeyBadge keyType={member.keyType} />
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <ModelBadge
                    provider={member.modelProvider}
                    modelId={member.modelId}
                    source={member.modelSource}
                    catalog={catalog}
                  />
                </div>
                <div className="text-xs text-muted-foreground">
                  {member.agentCount} <Trans>agents</Trans>
                  {" · "}
                  {money(member.totalCostUsd)}
                </div>
                <div className="text-xs text-muted-foreground">
                  <Trans>Shared {money(member.sharedKeyCostUsd)}</Trans>
                  {" · "}
                  <Trans>Personal {money(member.personalKeyCostUsd)}</Trans>
                </div>
                <div className="text-xs tabular-nums text-muted-foreground">
                  <Trans>Shared week</Trans>
                  {": "}
                  {member.sharedKeyBudget?.member
                    ? money(member.sharedKeyBudget.remainingUsd)
                    : "—"}
                </div>
                <button
                  type="button"
                  className={buttonVariants({ variant: "outline", size: "sm" })}
                  disabled={busyUserId != null || member.deactivated}
                  onClick={() => void viewAs(member)}
                >
                  {busyUserId === member.userId ? (
                    <Spinner className="size-4" />
                  ) : (
                    <Trans>View as</Trans>
                  )}
                </button>
              </CardHeader>
            </Card>
          </li>
        ))}
      </ul>
    </div>
  );
}
