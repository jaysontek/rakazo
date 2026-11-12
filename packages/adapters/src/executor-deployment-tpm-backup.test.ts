import type { AgentRunRequest } from "@rakazo/adapter-kit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as ComputerLifecycleModule from "./computer-lifecycle.js";
import {
  clearDeploymentModelTpmWindows,
  markDeploymentModelTpmLimited,
} from "./deployment-tpm-window.js";
import { createRunExecutor } from "./executor.js";
import { withModelRoles } from "./testing/model-roles.js";

vi.mock("./computer-lifecycle.js", async (importOriginal) => ({
  ...(await importOriginal<typeof ComputerLifecycleModule>()),
  acquireComputerExecutionLease: async () => null,
  acquireDedicatedScreenLeaseFence: async (
    _prisma: unknown,
    input: { computerId: string; botId: string; runId: string },
  ) => ({ ...input, fence: 7 }),
  provisionComputer: async () => ({ id: "computer-1", kind: "desktop" }),
  renewComputerExecutionLease: async () => true,
}));

const USER_ID = "user-1";
const stamp = new Date("2026-08-30T00:00:00.000Z");

afterEach(() => {
  clearDeploymentModelTpmWindows();
  vi.unstubAllEnvs();
});

beforeEach(() => {
  vi.stubEnv("PI_DEFAULT_PROVIDER", "google");
  vi.stubEnv("PI_DEFAULT_MODEL", "gemini-3.8-flash");
  vi.stubEnv("GEMINI_API_KEY", "shared-gemini-key");
});

async function runDeploymentTurn(options?: { memberBackup?: boolean; tpmLimited?: boolean }) {
  const run: Record<string, unknown> = {
    id: "run-1",
    botId: "bot-1",
    threadId: "thread-1",
    taskId: "task-1",
    spaceId: "space-1",
    userId: USER_ID,
    status: "queued",
    trigger: "user",
    leaseFence: 0,
    modelPinned: false,
  };
  if (options?.tpmLimited) {
    markDeploymentModelTpmLimited(
      "google",
      "gemini-3.8-flash",
      {
        status: 429,
        message: "tokens per minute limit; try again in 30s.",
      },
      Date.now(),
    );
  }
  let request: AgentRunRequest | undefined;
  const runtimeRun = vi.fn(async function* (next: AgentRunRequest) {
    request = next;
    yield { type: "done" as const, text: "Done" };
  });
  const memberBackupCredential = {
    id: "member-backup-credential",
    userId: USER_ID,
    provider: "openrouter",
    label: "Backup",
    secretId: "missing-secret",
    supportsImages: false,
    createdAt: stamp,
    updatedAt: stamp,
  };
  const prisma = withModelRoles(
    {
      $transaction: vi.fn(async (work: (client: unknown) => Promise<unknown>) => work(prisma)),
      user: { findUnique: vi.fn(async () => null) },
      run: {
        findUnique: vi.fn(async () => run),
        findUniqueOrThrow: vi.fn(async () => run),
        findFirst: vi.fn(async () => ({
          bot: { notifyOnFinish: false },
          thread: { groupId: null },
        })),
        updateMany: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
          Object.assign(run, data);
          return { count: 1 };
        }),
      },
      chatGroup: { findMany: vi.fn(async () => []) },
      bot: {
        findUniqueOrThrow: vi.fn(async () => ({
          id: "bot-1",
          name: "Assistant",
          title: "Assistant",
          description: "Test assistant",
          modelProvider: null,
          modelId: null,
          thinkingLevel: null,
          computerId: "computer-1",
          computerSwitching: false,
          memoryScope: null,
          computer: { id: "computer-1", scope: "dedicated" },
        })),
        findMany: vi.fn(async () => []),
      },
      attempt: {
        create: vi.fn(async () => ({ id: "attempt-1" })),
        update: vi.fn(),
        updateMany: vi.fn(async () => ({ count: 1 })),
      },
      thread: {
        findUniqueOrThrow: vi.fn(async () => ({
          id: "thread-1",
          groupId: null,
          historyCompactionSummary: null,
          historyCompactedUpToSeq: null,
          nextMessageSeq: 2,
        })),
      },
      message: {
        findMany: vi.fn(async () => []),
        findUnique: vi.fn(async () => null),
        findFirst: vi.fn(async () => null),
      },
      task: { findUniqueOrThrow: vi.fn(async () => ({ id: "task-1", prompt: "hello" })) },
      computer: { updateMany: vi.fn(async () => ({ count: 1 })) },
      connection: { findMany: vi.fn(async () => []) },
      userModelPreference: {
        findMany: vi.fn(async () => []),
        findFirst: vi.fn(async () => null),
      },
      userModelCredential: {
        findMany: vi.fn(async () => (options?.memberBackup ? [memberBackupCredential] : [])),
        findFirst: vi.fn(async () => (options?.memberBackup ? memberBackupCredential : null)),
      },
      secret: {
        findMany: vi.fn(async () => []),
        findFirst: vi.fn(async () => null),
      },
      deploymentSettings: { findUnique: vi.fn(async () => null) },
      taughtSkill: { findMany: vi.fn(async () => []) },
      vaultCredential: { findMany: vi.fn(async () => []) },
      agentSkill: { findMany: vi.fn(async () => []) },
      scratchpadItem: { findMany: vi.fn(async () => []) },
      externalEffect: { findMany: vi.fn(async () => []) },
      userActionApprovalRule: { findMany: vi.fn(async () => []) },
      userActionAutoReviewPreference: { findUnique: vi.fn(async () => null) },
      artifact: { findMany: vi.fn(async () => []) },
    },
    options?.memberBackup
      ? [
          {
            userId: USER_ID,
            role: "main",
            position: 1,
            provider: "openrouter",
            modelId: "openai/gpt-4o",
            thinkingLevel: null,
          },
        ]
      : [],
  );
  const executor = createRunExecutor({
    prisma,
    billingEnabled: false,
    deploymentModelConfigured: true,
    deploymentModelKey: "shared-gemini-key",
    secretStore: {
      load: vi.fn(async () => {
        throw new Error("member secret should not load for deployment backups");
      }),
      put: vi.fn(async () => ({ ciphertext: "sealed" })),
      delete: vi.fn(async () => undefined),
    },
    runtime: { describe: () => ({ capabilities: { scripted: false } }), run: runtimeRun },
    sandbox: {
      describe: () => ({ capabilities: { graphical: false } }),
      listFiles: vi.fn(async () => []),
      readFile: vi.fn().mockRejectedValue(new Error("missing")),
      exportWorkspace: vi.fn(async function* () {
        yield* [];
      }),
    },
    home: { commit: vi.fn(async () => "fixture-revision") },
    memory: { read: async () => ({ documents: [] }) },
    memoryProviders: { resolve: async () => null },
    events: {
      append: vi.fn(async () => undefined),
      finalizeRun: vi.fn(async () => ({ continuationRunId: null })),
    },
    jobs: { enqueue: vi.fn(async () => undefined) },
    secrets: [],
  } as unknown as Parameters<typeof createRunExecutor>[0]);
  await executor.continueRun("run-1", "worker-1");
  return { request, run, prisma };
}

describe("deployment TPM backups", () => {
  it("offers gemini-3.7-flash on the shared key with a TPM-only trigger", async () => {
    const { request, run } = await runDeploymentTurn();
    expect(request?.model).toMatchObject({
      provider: "google",
      id: "gemini-3.8-flash",
      apiKey: "shared-gemini-key",
    });
    expect(request?.fallbackTrigger).toBe("tpm");
    expect(request?.fallbackModels).toEqual([{ provider: "google", id: "gemini-3.7-flash" }]);
    await expect(
      request?.resolveFallbackModel?.("google", "gemini-3.7-flash"),
    ).resolves.toMatchObject({
      provider: "google",
      id: "gemini-3.7-flash",
      apiKey: "shared-gemini-key",
    });
    expect(run).toMatchObject({ modelProvider: "google", modelId: "gemini-3.8-flash" });
  });

  it("starts on the backup while the primary's per-minute window is open", async () => {
    const { request, run } = await runDeploymentTurn({ tpmLimited: true });
    expect(request?.model).toMatchObject({
      provider: "google",
      id: "gemini-3.7-flash",
      apiKey: "shared-gemini-key",
    });
    expect(run).toMatchObject({ modelProvider: "google", modelId: "gemini-3.7-flash" });
    expect(request?.fallbackModels).toEqual([]);
  });

  it("lets a member's own backup win over the deployment shared-key backup", async () => {
    const { request } = await runDeploymentTurn({ memberBackup: true });
    // Member backups keep the broader failover trigger; they never get GEMINI_API_KEY.
    expect(request?.fallbackTrigger).toBeUndefined();
    expect(request?.fallbackModels).toEqual([{ provider: "openrouter", id: "openai/gpt-4o" }]);
  });
});
