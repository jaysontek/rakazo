import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { clearSpace, rpc } from "../lib/api";
import { t, useI18n } from "../lib/i18n";
import { useMobileTokens } from "../lib/native";
import { clearQueries } from "../lib/query";
import { errorText } from "../lib/user-error";

type Impersonating = {
  targetName: string;
  targetEmail: string;
  expiresAt: string;
};

function formatExpiry(expiresAt: string, locale: string): string {
  const date = new Date(expiresAt);
  if (Number.isNaN(date.getTime())) return expiresAt;
  return date.toLocaleString(locale, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

async function hardReloadAfterStop(): Promise<void> {
  await clearSpace();
  clearQueries();
  try {
    const Updates = await import("expo-updates");
    if (Updates.isEnabled) {
      await Updates.reloadAsync();
      return;
    }
  } catch {
    // Development / Expo Go: fall through to a soft remount below.
  }
}

/** Persistent read-only banner while an admin session is viewing as another account. */
export function ImpersonationBanner() {
  const tokens = useMobileTokens();
  const insets = useSafeAreaInsets();
  const { locale } = useI18n();
  const [impersonating, setImpersonating] = useState<Impersonating | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    void rpc("me")
      .then((me) => {
        const next = me.impersonating;
        setImpersonating(
          next
            ? {
                targetName: next.targetName,
                targetEmail: next.targetEmail,
                expiresAt: next.expiresAt,
              }
            : null,
        );
      })
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, 30_000);
    return () => clearInterval(timer);
  }, [refresh]);

  if (!impersonating) return null;

  const endsAt = formatExpiry(impersonating.expiresAt, locale === "en" ? "en-US" : locale);
  const label = impersonating.targetName
    ? t("Read-only · Viewing as {name} ({email}) · Ends {time}", {
        name: impersonating.targetName,
        email: impersonating.targetEmail,
        time: endsAt,
      })
    : t("Read-only · Viewing as {email} · Ends {time}", {
        email: impersonating.targetEmail,
        time: endsAt,
      });

  async function stop() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await rpc("ops/stopImpersonation");
      await hardReloadAfterStop();
      // Soft remount when expo-updates reload is unavailable.
      setImpersonating(null);
      refresh();
    } catch (err) {
      setError(errorText(err, t("Could not stop impersonation")));
      setBusy(false);
    }
  }

  return (
    <View
      testID="impersonation-banner"
      style={[
        styles.banner,
        {
          paddingTop: Math.max(8, insets.top),
          backgroundColor: tokens.destructiveFill,
          borderBottomColor: tokens.destructive,
        },
      ]}
    >
      <Text style={[styles.copy, { color: tokens.destructiveForeground }]} numberOfLines={3}>
        {label}
      </Text>
      {error ? (
        <Text style={[styles.error, { color: tokens.destructiveForeground }]}>{error}</Text>
      ) : null}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t("Stop")}
        disabled={busy}
        onPress={() => void stop()}
        style={[styles.stop, { borderColor: tokens.destructiveForeground }]}
      >
        {busy ? (
          <ActivityIndicator color={tokens.destructiveForeground} />
        ) : (
          <Text style={{ color: tokens.destructiveForeground, fontWeight: "600" }}>{t("Stop")}</Text>
        )}
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  banner: {
    paddingHorizontal: 16,
    paddingBottom: 10,
    gap: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  copy: {
    fontSize: 13,
    lineHeight: 18,
  },
  error: {
    fontSize: 12,
  },
  stop: {
    alignSelf: "flex-start",
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 6,
    minWidth: 72,
    alignItems: "center",
  },
});
