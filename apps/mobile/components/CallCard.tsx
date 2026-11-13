import { accountDisplay } from "@rakazo/core";
import { typeScale } from "@rakazo/ui-tokens";
import { AudioModule } from "expo-audio";
import { useKeepAwake } from "expo-keep-awake";
import { useLocalSearchParams, useRouter } from "expo-router";
import type { ComponentProps } from "react";
import { useEffect, useRef, useState } from "react";
import { Platform, Pressable, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { rpc } from "../lib/api";
import { startCallBackground, stopCallBackground } from "../lib/call-background";
import { endCall, toggleMute, useCallSession } from "../lib/call-session";
import { useI18n } from "../lib/i18n";
import { useMobileTokens } from "../lib/native";
import { HEADER_CONTROL_SIZE } from "../lib/native-controls";
import { currentSessionGeneration, subscribeSessionGeneration } from "../lib/session";
import { setVoiceBackgroundPlayback } from "../lib/voice";
import { BotAvatar } from "./bot-avatar";
import { CallVoicePicker } from "./call-voice-picker";
import { GlassIconButton } from "./glass-icon-button";
import { GlassSurface } from "./glass-surface";
import type { NativeSymbol } from "./native-symbol";

const START_RETRY_MS = 3000;
const START_ATTEMPTS = 20;

let cachedInitial: string | null = null;

/** Fallback until the native call service owns the call. */
function KeepCallAwake() {
  useKeepAwake("rakazo-call");
  return null;
}

/** The signed-in user's initial for the user video tile. */
export function useCallUserInitial(onCall: boolean): string {
  const { t } = useI18n();
  const [initial, setInitial] = useState(cachedInitial ?? "");
  useEffect(() => {
    if (!onCall || cachedInitial !== null) return;
    const generation = currentSessionGeneration();
    void rpc("me")
      .then((me) => {
        if (generation !== currentSessionGeneration()) return;
        cachedInitial = accountDisplay(me, t("You")).initial ?? "";
        setInitial(cachedInitial);
      })
      .catch(() => undefined);
  }, [onCall, t]);
  useEffect(
    () =>
      subscribeSessionGeneration(() => {
        cachedInitial = null;
        setInitial("");
      }),
    [],
  );
  return initial;
}

/**
 * Keeps call audio/wake side effects alive for the whole call, and shows a compact
 * dock only when the thread composer is not hosting the strip.
 */
export function CallCard() {
  const call = useCallSession();
  const tokens = useMobileTokens();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const params = useLocalSearchParams<{ botId?: string }>();
  const initial = useCallUserInitial(Boolean(call));
  const [serviceStarted, setServiceStarted] = useState(false);
  const serviceStartedFor = useRef<string | null>(null);
  const startSeq = useRef(0);
  const onCall = Boolean(call);
  const mountedCall = useRef(false);
  mountedCall.current = onCall;
  useEffect(
    () => () => {
      if (mountedCall.current) void stopCallBackground();
    },
    [],
  );

  useEffect(() => {
    if (!onCall) return;
    setVoiceBackgroundPlayback(true);
    return () => setVoiceBackgroundPlayback(false);
  }, [onCall]);

  useEffect(() => {
    if (!call) {
      startSeq.current += 1;
      serviceStartedFor.current = null;
      setServiceStarted(false);
      void stopCallBackground();
      return;
    }
    if (Platform.OS !== "android" || serviceStartedFor.current === call.botId) return;
    startSeq.current += 1;
    const seq = startSeq.current;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let attempts = 0;
    const retry = () => {
      if (cancelled || attempts >= START_ATTEMPTS) return;
      attempts += 1;
      timer = setTimeout(() => void attempt(), START_RETRY_MS);
    };
    const attempt = async () => {
      try {
        const permission = await AudioModule.getRecordingPermissionsAsync();
        if (cancelled || seq !== startSeq.current) return;
        if (!permission.granted) return retry();
        const started = await startCallBackground(call.botName);
        if (cancelled || seq !== startSeq.current) return;
        if (!started) return retry();
        serviceStartedFor.current = call.botId;
        setServiceStarted(true);
      } catch {
        // Keep the screen-awake fallback when the native service is unavailable.
      }
    };
    void attempt();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [call?.botId, call?.botName, call?.phase]);

  const keepAwake = onCall && (Platform.OS !== "android" || !serviceStarted);
  // The matching bot thread's composer hosts the strip.
  if (!call || params.botId === call.botId) {
    return keepAwake ? <KeepCallAwake /> : null;
  }

  // Clear the floating/native header controls; safe-top alone sits under Back/title.
  const cardTop = insets.top + HEADER_CONTROL_SIZE + 8;
  return (
    <GlassSurface
      shape="roundedRectangle"
      style={[styles.card, { top: cardTop }]}
      fallbackStyle={[
        styles.cardFallback,
        {
          backgroundColor: tokens.glassFill,
          borderColor: tokens.glassStroke,
          shadowColor: tokens.foreground,
        },
      ]}
    >
      {keepAwake ? <KeepCallAwake /> : null}
      <CallStripBody
        botId={call.botId}
        botName={call.botName}
        botColor={call.botColor}
        botAvatarSet={call.botAvatarSet}
        muted={call.muted}
        initial={initial}
        onOpenThread={() =>
          router.push({ pathname: "/thread", params: { botId: call.botId, name: call.botName } })
        }
        onSettings={() => router.push("/voice")}
      />
    </GlassSurface>
  );
}

/** Shared in-call row used by CallCard and the thread composer. */
export function CallStripBody({
  botId,
  botName,
  botColor,
  botAvatarSet,
  muted,
  initial,
  onOpenThread,
  onSettings,
}: {
  botId: string;
  botName: string;
  botColor: string;
  botAvatarSet?: ComponentProps<typeof BotAvatar>["avatarSet"];
  muted: boolean;
  initial: string;
  onOpenThread?: () => void;
  onSettings: () => void;
}) {
  const { t } = useI18n();
  const tokens = useMobileTokens();
  const call = useCallSession();
  const speaking = call?.phase === "speaking";
  return (
    <View testID="call-view" style={styles.strip}>
      <View style={styles.tiles}>
        <View style={[styles.tile, { backgroundColor: tokens.muted }]}>
          <Text style={[styles.initialText, { color: tokens.mutedForeground }]}>
            {initial || "·"}
          </Text>
        </View>
        <View
          style={[
            styles.tile,
            { backgroundColor: tokens.muted },
            speaking ? { borderColor: tokens.foreground, borderWidth: 2 } : null,
          ]}
        >
          <BotAvatar
            color={botColor}
            avatarSet={botAvatarSet}
            identity={botId}
            size={36}
            motion="live"
          />
        </View>
      </View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t("On a call with {name}", { name: botName })}
        onPress={onOpenThread}
        style={styles.namePress}
      >
        <Text numberOfLines={1} style={[styles.name, { color: tokens.foreground }]}>
          {botName}
        </Text>
      </Pressable>
      <CallVoicePicker />
      <RoundButton
        label={t("Settings")}
        ios="gearshape"
        android="settings-outline"
        color={tokens.foreground}
        border={tokens.border}
        onPress={onSettings}
      />
      <RoundButton
        label={muted ? t("Unmute") : t("Mute")}
        ios={muted ? "mic.slash" : "mic"}
        android={muted ? "mic-off-outline" : "mic-outline"}
        selected={muted}
        color={muted ? tokens.mutedForeground : tokens.foreground}
        border={tokens.border}
        onPress={toggleMute}
      />
      <RoundButton
        label={t("Hang up")}
        ios="phone.down.fill"
        android="call-outline"
        color={tokens.destructiveForeground}
        border={tokens.destructiveFill}
        background={tokens.destructiveFill}
        onPress={endCall}
      />
    </View>
  );
}

function RoundButton({
  label,
  ios,
  android,
  color,
  border,
  background,
  selected,
  onPress,
}: {
  label: string;
  ios: string;
  android: ComponentProps<typeof NativeSymbol>["android"];
  color: string;
  border: string;
  background?: string;
  selected?: boolean;
  onPress: () => void;
}) {
  return (
    <GlassIconButton
      accessibilityLabel={label}
      ios={ios}
      android={android}
      size={36}
      color={color}
      tint={background}
      selected={selected}
      onPress={onPress}
      fallbackStyle={[
        styles.buttonFallback,
        { borderColor: border, backgroundColor: background ?? "transparent" },
      ]}
    />
  );
}

const styles = StyleSheet.create({
  card: {
    position: "absolute",
    alignSelf: "center",
    width: "92%",
    maxWidth: 420,
    padding: 10,
    zIndex: 50,
    overflow: "hidden",
  },
  cardFallback: {
    borderRadius: 18,
    borderWidth: StyleSheet.hairlineWidth,
    shadowOpacity: 0.18,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
    elevation: 6,
  },
  strip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    minWidth: 0,
    overflow: "hidden",
  },
  tiles: { flexDirection: "row", alignItems: "center", gap: 6, flexShrink: 0 },
  tile: {
    width: 36,
    height: 36,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
  },
  initialText: { fontSize: 13, fontWeight: "600" },
  // No minWidth: on ~375 the voice picker + three controls already fill the row.
  namePress: { flexShrink: 1, minWidth: 0, maxWidth: 96 },
  name: { ...typeScale.cardTitle, writingDirection: "auto" },
  buttonFallback: { borderWidth: StyleSheet.hairlineWidth },
});
