import { useLingui } from "@lingui/react/macro";
import type { VoiceInfo } from "@rakazo/contracts";
import { accountDisplay } from "@rakazo/core";
import {
  BotAvatar,
  Button,
  cn,
  NativeSelect,
  NativeSelectOption,
} from "@rakazo/ui-web";
import { Mic, MicOff, PhoneOff, Settings } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { authClient } from "../../lib/auth";
import type { CallState } from "../../lib/call-session";
import { endCall, toggleMute, useCallSession } from "../../lib/call-session";
import { useSpaceRpc } from "../../lib/space-rpc";

function callClock(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  return `${String(minutes).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

function useCallElapsed(call: CallState | null): number {
  const connectedAt = call?.connectedAt ?? null;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (connectedAt === null) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [connectedAt]);
  return connectedAt === null ? 0 : Math.max(0, Math.floor((now - connectedAt) / 1000));
}

function CallVoicePicker() {
  const { t } = useLingui();
  const rpc = useSpaceRpc();
  const voiceSelectId = useId();
  const [voices, setVoices] = useState<VoiceInfo[]>([]);
  const [voiceId, setVoiceId] = useState("");
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const status = await rpc.voice.status({});
        if (cancelled) return;
        setVoiceId(status.voiceId);
        if (!status.provider) {
          setVoices([]);
          return;
        }
        const listed = await rpc.voice.voices({ provider: status.provider });
        if (cancelled) return;
        setVoices(listed);
      } catch {
        if (!cancelled) setVoices([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [rpc]);
  if (!voices.length) return null;
  return (
    <NativeSelect
      id={voiceSelectId}
      size="sm"
      aria-label={t`Voice`}
      data-testid="call-voice-picker"
      value={voiceId}
      disabled={saving}
      onChange={(event) => {
        const next = event.target.value;
        const previous = voiceId;
        setVoiceId(next);
        if (!next) return;
        setSaving(true);
        void rpc.voice
          .setVoice({ voiceId: next })
          .then((status) => setVoiceId(status.voiceId || next))
          .catch(() => setVoiceId(previous))
          .finally(() => setSaving(false));
      }}
      className="max-w-[4.5rem] min-w-0 shrink sm:max-w-28"
    >
      {voices.map((voice) => (
        <NativeSelectOption key={voice.id} value={voice.id}>
          {voice.label}
        </NativeSelectOption>
      ))}
    </NativeSelect>
  );
}

/**
 * In-call chrome for the composer field bar: participant tiles and call controls.
 * Agent calls are audio-only — account image/initial for the user, never camera or video UI.
 * Keeps the thread visible; never covers the app as a modal.
 */
export function CallStrip({
  onSettings,
  className,
}: {
  onSettings: () => void;
  className?: string;
}) {
  const { t } = useLingui();
  const call = useCallSession();
  const elapsed = useCallElapsed(call);
  const session = authClient.useSession();
  const user = session.data?.user;
  const { label: userName, initial } = accountDisplay(user ?? {}, t`You`);
  if (!call) return null;
  const ringing = call.phase === "ringing";
  const speaking = call.phase === "speaking";
  const activity = ringing
    ? t`Calling…`
    : call.phase === "thinking"
      ? t`Thinking`
      : call.muted
        ? t`Muted`
        : speaking
          ? t`Speaking`
          : t`Listening`;
  return (
    <div
      data-testid="call-view"
      role="region"
      aria-label={t`Call with ${call.botName}`}
      className={cn(
        "flex min-w-0 items-center gap-2 overflow-hidden rounded-[18px] border border-border bg-card px-2.5 py-2",
        className,
      )}
    >
      <div className="flex shrink-0 items-center gap-1.5">
        <div
          className="relative size-10 overflow-hidden rounded-[12px] bg-muted"
          aria-label={t`You`}
          title={userName}
        >
          {user?.image ? (
            <img src={user.image} alt="" className="size-full object-cover" />
          ) : (
            <span className="grid size-full place-items-center text-[13px] font-semibold text-muted-foreground">
              {initial}
            </span>
          )}
        </div>
        <div
          className={cn(
            "relative grid size-10 place-items-center overflow-hidden rounded-[12px] bg-muted",
            speaking ? "ring-2 ring-foreground/40" : "",
          )}
          aria-label={call.botName}
          title={call.botName}
        >
          <BotAvatar
            avatarSet={call.botAvatarSet}
            color={call.botColor}
            identity={call.botId}
            size={40}
            activity={speaking ? "working" : call.phase === "thinking" ? "reading" : "idle"}
            status={speaking || call.phase === "thinking" ? "running" : undefined}
          />
        </div>
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-[13px] font-medium text-foreground" dir="auto">
          {call.botName}
        </div>
        <div
          className="flex min-w-0 gap-1.5 text-[12px] tabular-nums text-muted-foreground"
          aria-live="polite"
        >
          {!ringing ? <span className="shrink-0">{callClock(elapsed)}</span> : null}
          <span className="truncate">{activity}</span>
        </div>
      </div>
      <CallVoicePicker />
      <Button
        variant="ghost"
        size="icon"
        className="size-8 shrink-0 rounded-full text-muted-foreground"
        aria-label={t`Settings`}
        onClick={onSettings}
      >
        <Settings className="size-4" />
      </Button>
      <Button
        variant={call.muted ? "default" : "secondary"}
        size="icon"
        className="size-8 shrink-0 rounded-full"
        aria-label={call.muted ? t`Unmute` : t`Mute`}
        aria-pressed={call.muted}
        onClick={toggleMute}
      >
        {call.muted ? <MicOff className="size-4" /> : <Mic className="size-4" />}
      </Button>
      <Button
        variant="destructive"
        size="icon"
        className="size-8 shrink-0 rounded-full"
        aria-label={t`Hang up`}
        onClick={endCall}
      >
        <PhoneOff className="size-4" />
      </Button>
    </div>
  );
}
