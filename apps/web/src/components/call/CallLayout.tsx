import type { Bot } from "@rakazo/contracts";
import { useQuery } from "@tanstack/react-query";
import { Outlet, useNavigate } from "react-router-dom";
import { useSpaceQueries } from "../../lib/query";
import { useIsImpersonating } from "../../lib/use-impersonating";
import { CallCard } from "./CallCard";
import { IncomingCall } from "./IncomingCall";

const NO_BOTS: Bot[] = [];

/**
 * Pages outside the shell keep an ongoing call in reach and still ring for incoming ones;
 * the shell shows its own, polled with its roster.
 */
export function CallLayout() {
  const navigate = useNavigate();
  const queries = useSpaceQueries();
  const impersonating = useIsImpersonating();
  const phoneCallsEnabled = useQuery(queries.me.queryOptions()).data?.phoneCallsEnabled === true;
  const callsEnabled = !impersonating && phoneCallsEnabled;
  // Polled like the shell's roster, hidden tabs included, so a call rings here too.
  const bots = useQuery({
    ...queries.bots.list.queryOptions(),
    enabled: callsEnabled,
    refetchInterval: 3_000,
    refetchIntervalInBackground: true,
  }).data;
  const voiceStatus = useQuery({
    ...queries.voice.status.queryOptions(),
    enabled: callsEnabled,
  }).data;
  return (
    <div className="flex h-full flex-col">
      <div className="min-h-0 flex-1">
        <Outlet />
      </div>
      <CallCard onSettings={() => navigate("/app?settings=voice")} />
      {impersonating ? null : (
        <IncomingCall
          bots={callsEnabled ? (bots ?? NO_BOTS) : NO_BOTS}
          transcribe={voiceStatus ? Boolean(voiceStatus.transcribe) : undefined}
          onAnswered={(botId) => navigate(`/app/${botId}`)}
        />
      )}
    </div>
  );
}
