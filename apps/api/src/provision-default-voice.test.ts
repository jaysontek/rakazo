import {
  createSecretStore,
  OPENAI_COMPATIBLE_VOICE_PROVIDER_ID,
  resolveDeploymentModel,
} from "@rakazo/adapters";
import type { PrismaClient } from "@rakazo/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  accountHasVoiceConfig,
  backfillDefaultVoice,
  provisionDefaultVoiceForUser,
} from "./provision-default-voice.js";
import { toVoiceCredential } from "./voice.js";

const CONFIG = {
  baseUrl: "http://192.168.140.157:8890/v1",
  ttsModel: "kokoro",
  sttModel: "whisper-1",
  apiKey: "voice-gateway-secret",
};

function secretStore() {
  return createSecretStore("test-encryption-key-not-for-production", {});
}

describe("provisionDefaultVoiceForUser", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("provisions a self-hosted voice connection without exposing the key on the DTO", async () => {
    const secrets = secretStore();
    const created: {
      secret?: { id: string; ciphertext: string; kind: string };
      credential?: { provider: string; secretId: string };
      preference?: { voiceId: string };
    } = {};
    const prisma = {
      userVoiceCredential: {
        findFirst: vi.fn().mockResolvedValue(null),
        create: vi.fn(async ({ data }) => {
          created.credential = data;
          return { id: "cred-1", userId: "user-1", ...data };
        }),
      },
      spaceMember: {
        findFirst: vi.fn().mockResolvedValue({ spaceId: "space-1" }),
      },
      secret: {
        create: vi.fn(async ({ data }) => {
          created.secret = data;
          return data;
        }),
      },
      userVoicePreference: {
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
        upsert: vi.fn(async ({ create }) => {
          created.preference = create;
          return create;
        }),
      },
      spaceVoicePreference: {
        updateMany: vi.fn(),
        upsert: vi.fn(),
      },
      $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(prisma)),
    } as unknown as PrismaClient;

    const result = await provisionDefaultVoiceForUser(
      { prisma, secrets, allowPrivateEndpoint: true },
      "user-1",
      { config: CONFIG },
    );
    expect(result).toEqual({ status: "provisioned", credentialId: "cred-1" });
    expect(created.credential?.provider).toBe(OPENAI_COMPATIBLE_VOICE_PROVIDER_ID);
    expect(created.preference?.voiceId).toBe("af_heart");
    expect(created.secret?.kind).toBe("voice");

    const plaintext = await secrets.load(created.secret!.ciphertext, created.secret!.id);
    expect(JSON.parse(plaintext)).toEqual({
      kind: "openai_compatible",
      baseUrl: "http://192.168.140.157:8890/v1",
      ttsModel: "kokoro",
      sttModel: "whisper-1",
      apiKey: "voice-gateway-secret",
    });

    const dto = toVoiceCredential({
      id: "cred-1",
      provider: OPENAI_COMPATIBLE_VOICE_PROVIDER_ID,
      isDefault: true,
      voiceId: "af_heart",
      server: {
        endpoint: "http://192.168.140.157:8890/v1",
        ttsModel: "kokoro",
        sttModel: "whisper-1",
      },
    });
    expect(dto).toMatchObject({
      hasKey: true,
      endpoint: "http://192.168.140.157:8890/v1",
      ttsModel: "kokoro",
      sttModel: "whisper-1",
    });
    expect(dto).not.toHaveProperty("apiKey");
    expect(JSON.stringify(dto)).not.toContain("voice-gateway-secret");
  });

  it("skips when voice config is already set", async () => {
    const prisma = {
      userVoiceCredential: {
        findFirst: vi.fn().mockResolvedValue({ id: "existing" }),
      },
      spaceMember: { findFirst: vi.fn() },
    } as unknown as PrismaClient;
    await expect(
      provisionDefaultVoiceForUser(
        { prisma, secrets: secretStore(), allowPrivateEndpoint: true },
        "user-1",
        { config: CONFIG },
      ),
    ).resolves.toEqual({ status: "skipped", reason: "already-set" });
    expect(prisma.spaceMember.findFirst).not.toHaveBeenCalled();
  });

  it("skips when operator defaults are disabled", async () => {
    const prisma = {
      userVoiceCredential: { findFirst: vi.fn() },
    } as unknown as PrismaClient;
    await expect(
      provisionDefaultVoiceForUser(
        { prisma, secrets: secretStore(), allowPrivateEndpoint: true },
        "user-1",
        { config: null },
      ),
    ).resolves.toEqual({ status: "skipped", reason: "disabled" });
    expect(prisma.userVoiceCredential.findFirst).not.toHaveBeenCalled();
  });
});

describe("backfillDefaultVoice", () => {
  it("dry-run counts accounts that would be touched without mutating", async () => {
    const secrets = secretStore();
    const put = vi.spyOn(secrets, "put");
    const prisma = {
      user: {
        findMany: vi
          .fn()
          .mockResolvedValueOnce([{ id: "u1" }, { id: "u2" }, { id: "u3" }])
          .mockResolvedValueOnce([]),
      },
      userVoiceCredential: {
        findFirst: vi
          .fn()
          .mockResolvedValueOnce(null)
          .mockResolvedValueOnce({ id: "have" })
          .mockResolvedValueOnce(null),
      },
      spaceMember: {
        findFirst: vi.fn().mockResolvedValueOnce({ id: "m1" }).mockResolvedValueOnce(null),
      },
      secret: { create: vi.fn() },
      $transaction: vi.fn(),
    } as unknown as PrismaClient;

    vi.stubEnv("RAKAZO_DEFAULT_VOICE_BASE_URL", CONFIG.baseUrl);
    vi.stubEnv("RAKAZO_DEFAULT_VOICE_TTS_MODEL", CONFIG.ttsModel);
    vi.stubEnv("RAKAZO_DEFAULT_VOICE_STT_MODEL", CONFIG.sttModel);
    try {
      const result = await backfillDefaultVoice(
        { prisma, secrets, allowPrivateEndpoint: true },
        { dryRun: true },
      );
      expect(result).toMatchObject({
        scanned: 3,
        wouldTouch: 1,
        provisioned: 0,
        skippedAlreadySet: 1,
        skippedNoSpace: 1,
        failed: 0,
      });
      expect(put).not.toHaveBeenCalled();
      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(prisma.secret.create).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("accountHasVoiceConfig", () => {
  it("is true once any voice credential exists", async () => {
    expect(
      await accountHasVoiceConfig(
        { userVoiceCredential: { findFirst: vi.fn().mockResolvedValue({ id: "x" }) } } as never,
        "u",
      ),
    ).toBe(true);
    expect(
      await accountHasVoiceConfig(
        { userVoiceCredential: { findFirst: vi.fn().mockResolvedValue(null) } } as never,
        "u",
      ),
    ).toBe(false);
  });
});

describe("deployment Gemini key handling", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("keeps GEMINI_API_KEY as a shared server secret and never returns it from resolveDeploymentModel callers' public DTOs", () => {
    const deployment = resolveDeploymentModel({
      PI_DEFAULT_PROVIDER: "google",
      PI_DEFAULT_MODEL: "gemini-3.8-flash",
      GEMINI_API_KEY: "gemini-shared-key",
    });
    expect(deployment).toMatchObject({
      provider: "google",
      model: "gemini-3.8-flash",
      configured: true,
    });
    // me / models list expose provider+model ids only — never the env key.
    const publicMe = {
      needsModel: false,
      defaultProvider: deployment.provider,
      defaultModel: deployment.model,
    };
    expect(JSON.stringify(publicMe)).not.toContain("gemini-shared-key");
    expect(JSON.stringify(publicMe)).not.toContain("GEMINI_API_KEY");
  });
});
