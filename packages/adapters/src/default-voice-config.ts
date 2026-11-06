/**
 * Operator defaults for auto-provisioning a self-hosted OpenAI-compatible speech
 * connection on signup (and for the one-time voice backfill). Unset base URL means
 * do not provision — never invent a LAN address in code.
 */
export interface DefaultVoiceConfig {
  baseUrl: string;
  ttsModel: string;
  sttModel: string;
  /** Optional Bearer for the speech gateway. Never log or return this. */
  apiKey?: string;
}

/** Fallback speech / transcription ids when the env leaves them blank. */
export const DEFAULT_PROVISIONED_TTS_MODEL = "kokoro";
export const DEFAULT_PROVISIONED_STT_MODEL = "whisper-1";
/** First Kokoro fallback voice; listVoices may replace it later in settings. */
export const DEFAULT_PROVISIONED_VOICE_ID = "af_heart";

export function resolveDefaultVoiceConfig(
  env: NodeJS.ProcessEnv = process.env,
): DefaultVoiceConfig | null {
  const baseUrl = env.RAKAZO_DEFAULT_VOICE_BASE_URL?.trim() ?? "";
  if (!baseUrl) return null;
  const apiKey = env.RAKAZO_DEFAULT_VOICE_API_KEY?.trim() || undefined;
  return {
    baseUrl,
    ttsModel: env.RAKAZO_DEFAULT_VOICE_TTS_MODEL?.trim() || DEFAULT_PROVISIONED_TTS_MODEL,
    sttModel: env.RAKAZO_DEFAULT_VOICE_STT_MODEL?.trim() || DEFAULT_PROVISIONED_STT_MODEL,
    ...(apiKey ? { apiKey } : {}),
  };
}
