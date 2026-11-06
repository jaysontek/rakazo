import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_PROVISIONED_STT_MODEL,
  DEFAULT_PROVISIONED_TTS_MODEL,
  resolveDefaultVoiceConfig,
} from "./default-voice-config.js";

describe("resolveDefaultVoiceConfig", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("is off when the base URL is unset", () => {
    expect(resolveDefaultVoiceConfig({})).toBeNull();
    expect(resolveDefaultVoiceConfig({ RAKAZO_DEFAULT_VOICE_BASE_URL: "  " })).toBeNull();
  });

  it("reads operator defaults and fills speech model ids", () => {
    expect(
      resolveDefaultVoiceConfig({
        RAKAZO_DEFAULT_VOICE_BASE_URL: " http://192.168.140.157:8890/v1 ",
        RAKAZO_DEFAULT_VOICE_API_KEY: " gateway-key ",
      }),
    ).toEqual({
      baseUrl: "http://192.168.140.157:8890/v1",
      ttsModel: DEFAULT_PROVISIONED_TTS_MODEL,
      sttModel: DEFAULT_PROVISIONED_STT_MODEL,
      apiKey: "gateway-key",
    });
    expect(
      resolveDefaultVoiceConfig({
        RAKAZO_DEFAULT_VOICE_BASE_URL: "http://192.168.140.157:8890/v1",
        RAKAZO_DEFAULT_VOICE_TTS_MODEL: "kokoro",
        RAKAZO_DEFAULT_VOICE_STT_MODEL: "whisper-1",
      }),
    ).toEqual({
      baseUrl: "http://192.168.140.157:8890/v1",
      ttsModel: "kokoro",
      sttModel: "whisper-1",
    });
  });
});
