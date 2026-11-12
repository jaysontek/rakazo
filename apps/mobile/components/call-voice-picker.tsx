import type { VoiceInfo } from "@rakazo/contracts";
import { useEffect, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { MenuView } from "@expo/ui/community/menu";
import { rpc } from "../lib/api";
import { useI18n } from "../lib/i18n";
import { useMobileTokens } from "../lib/native";
import { NativeSymbol } from "./native-symbol";

/** Compact voice menu for the in-call strip. */
export function CallVoicePicker() {
  const { t } = useI18n();
  const tokens = useMobileTokens();
  const [voices, setVoices] = useState<VoiceInfo[]>([]);
  const [voiceId, setVoiceId] = useState("");
  const [provider, setProvider] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const status = await rpc("voice/status", {});
        if (cancelled) return;
        setProvider(status.provider);
        setVoiceId(status.voiceId);
        if (!status.provider) {
          setVoices([]);
          return;
        }
        const listed = await rpc("voice/voices", { provider: status.provider });
        if (cancelled) return;
        setVoices(listed);
      } catch {
        if (!cancelled) setVoices([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);
  if (!voices.length) return null;
  const label = voices.find((voice) => voice.id === voiceId)?.label ?? t("Voice");
  return (
    <MenuView
      actions={voices.map((voice) => ({
        id: voice.id,
        title: voice.label,
        state: voice.id === voiceId ? ("on" as const) : ("off" as const),
      }))}
      onPressAction={(event) => {
        const next = event.nativeEvent.event;
        if (!next || next === voiceId) return;
        setVoiceId(next);
        void rpc("voice/setVoice", { voiceId: next, provider: provider ?? undefined }).catch(
          () => undefined,
        );
      }}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t("Voice")}
        hitSlop={6}
        style={{
          maxWidth: 88,
          flexDirection: "row",
          alignItems: "center",
          gap: 2,
          paddingHorizontal: 6,
          paddingVertical: 4,
          borderRadius: 8,
          borderWidth: 1,
          borderColor: tokens.border,
        }}
      >
        <Text numberOfLines={1} style={{ flexShrink: 1, color: tokens.foreground, fontSize: 12 }}>
          {label}
        </Text>
        <NativeSymbol
          ios="chevron.down"
          android="chevron-down"
          size={12}
          color={tokens.mutedForeground}
        />
      </Pressable>
    </MenuView>
  );
}
