import type { AdapterContext, SecretStore } from "@rakazo/adapter-kit";
import type { DefaultVoiceConfig } from "@rakazo/adapters";
import {
  DEFAULT_PROVISIONED_VOICE_ID,
  OPENAI_COMPATIBLE_VOICE_PROVIDER_ID,
  resolveDefaultVoiceConfig,
  serializeOpenAiCompatibleVoiceSecret,
} from "@rakazo/adapters";
import type { PrismaClient } from "@rakazo/db";
import { Prisma, selectVoicePreference } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { withSerializableRetry } from "./serializable-retry.js";

export type ProvisionDefaultVoiceDeps = {
  prisma: PrismaClient;
  secrets: SecretStore;
  /** Instance flag (`MCP_ALLOW_PRIVATE_ENDPOINT`). Private LAN speech URLs need this. */
  allowPrivateEndpoint?: boolean;
};

export type ProvisionDefaultVoiceResult =
  | { status: "skipped"; reason: "disabled" | "already-set" | "no-space" }
  | { status: "provisioned"; credentialId: string };

function provisionContext(userId: string, spaceId: string): AdapterContext {
  return {
    operationId: "provision-default-voice",
    traceId: "provision-default-voice",
    spaceId,
    userId,
    signal: new AbortController().signal,
  };
}

function voicePlaintext(
  config: DefaultVoiceConfig,
  allowPrivateEndpoint: boolean | undefined,
): string {
  return serializeOpenAiCompatibleVoiceSecret(
    {
      baseUrl: config.baseUrl,
      apiKey: config.apiKey,
      ttsModel: config.ttsModel,
      sttModel: config.sttModel,
    },
    undefined,
    { allowPrivate: allowPrivateEndpoint === true },
  );
}

/** True when the account already has any voice connection. */
export async function accountHasVoiceConfig(
  prisma: Pick<PrismaClient, "userVoiceCredential">,
  userId: string,
): Promise<boolean> {
  const existing = await prisma.userVoiceCredential.findFirst({
    where: { userId },
    select: { id: true },
  });
  return Boolean(existing);
}

/**
 * Writes the operator's default self-hosted speech connection for one account.
 * Skips when the env is unset or the account already has voice config. Does not call
 * the speech server (signup must not depend on LAN reachability).
 */
export async function provisionDefaultVoiceForUser(
  deps: ProvisionDefaultVoiceDeps,
  userId: string,
  options: { config?: DefaultVoiceConfig | null; env?: NodeJS.ProcessEnv } = {},
): Promise<ProvisionDefaultVoiceResult> {
  const config =
    options.config !== undefined ? options.config : resolveDefaultVoiceConfig(options.env);
  if (!config) return { status: "skipped", reason: "disabled" };
  if (await accountHasVoiceConfig(deps.prisma, userId)) {
    return { status: "skipped", reason: "already-set" };
  }
  const membership = await deps.prisma.spaceMember.findFirst({
    where: { userId, space: { deletingAt: null } },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: { spaceId: true },
  });
  if (!membership) return { status: "skipped", reason: "no-space" };

  let plaintext: string;
  try {
    plaintext = voicePlaintext(config, deps.allowPrivateEndpoint);
  } catch (error) {
    getLogger().warn("default voice provision skipped: connection settings rejected", {
      userId,
      message: error instanceof Error ? error.message : "invalid",
    });
    return { status: "skipped", reason: "disabled" };
  }
  const stored = await deps.secrets.put(plaintext, provisionContext(userId, membership.spaceId));
  const credentialId = await withSerializableRetry(() =>
    deps.prisma.$transaction(
      async (tx) => {
        if (await accountHasVoiceConfig(tx, userId)) return null;
        const secret = await tx.secret.create({
          data: {
            id: stored.id,
            userId,
            spaceId: null,
            kind: "voice",
            ciphertext: stored.ciphertext,
          },
        });
        const credential = await tx.userVoiceCredential.create({
          data: {
            userId,
            provider: OPENAI_COMPATIBLE_VOICE_PROVIDER_ID,
            secretId: secret.id,
          },
        });
        await selectVoicePreference(
          tx,
          { userId, spaceId: membership.spaceId, scope: "account" },
          credential.id,
          DEFAULT_PROVISIONED_VOICE_ID,
        );
        return credential.id;
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    ),
  );
  if (!credentialId) return { status: "skipped", reason: "already-set" };
  return { status: "provisioned", credentialId };
}

export type BackfillVoiceDefaultsResult = {
  scanned: number;
  wouldTouch: number;
  provisioned: number;
  skippedAlreadySet: number;
  skippedNoSpace: number;
  failed: number;
};

/**
 * One-time idempotent pass over active accounts missing voice config. Dry-run only
 * counts who would be touched; it never writes.
 */
export async function backfillDefaultVoice(
  deps: ProvisionDefaultVoiceDeps,
  options: { dryRun?: boolean; env?: NodeJS.ProcessEnv; signal?: AbortSignal } = {},
): Promise<BackfillVoiceDefaultsResult> {
  const config = resolveDefaultVoiceConfig(options.env);
  const counts: BackfillVoiceDefaultsResult = {
    scanned: 0,
    wouldTouch: 0,
    provisioned: 0,
    skippedAlreadySet: 0,
    skippedNoSpace: 0,
    failed: 0,
  };
  if (!config) return counts;

  const signal = options.signal ?? new AbortController().signal;
  let cursor: string | undefined;
  for (;;) {
    signal.throwIfAborted();
    const users = await deps.prisma.user.findMany({
      where: {
        deactivatedAt: null,
        ...(cursor ? { id: { gt: cursor } } : {}),
      },
      orderBy: { id: "asc" },
      take: 100,
      select: { id: true },
    });
    for (const user of users) {
      counts.scanned++;
      if (await accountHasVoiceConfig(deps.prisma, user.id)) {
        counts.skippedAlreadySet++;
        continue;
      }
      const membership = await deps.prisma.spaceMember.findFirst({
        where: { userId: user.id, space: { deletingAt: null } },
        select: { id: true },
      });
      if (!membership) {
        counts.skippedNoSpace++;
        continue;
      }
      counts.wouldTouch++;
      if (options.dryRun) continue;
      try {
        const result = await provisionDefaultVoiceForUser(deps, user.id, { config });
        if (result.status === "provisioned") counts.provisioned++;
        else if (result.reason === "already-set") counts.skippedAlreadySet++;
        else if (result.reason === "no-space") counts.skippedNoSpace++;
      } catch (error) {
        signal.throwIfAborted();
        counts.failed++;
        // Never include secret material; the message is enough for operators.
        getLogger().error("default voice backfill failed for account", error, { userId: user.id });
      }
    }
    if (users.length < 100) return counts;
    cursor = users.at(-1)?.id;
  }
}

/** Safe to call from every sign-in: no-ops when unset or already provisioned. */
export async function provisionDefaultVoiceAfterSignIn(
  deps: ProvisionDefaultVoiceDeps,
  userId: string,
): Promise<void> {
  try {
    await provisionDefaultVoiceForUser(deps, userId);
  } catch (error) {
    getLogger().error("default voice provision after sign-in failed", error, { userId });
  }
}
