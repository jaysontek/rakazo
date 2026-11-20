import type * as Db from "@rakazo/db";
import {
  claimOrganizationForDeletion,
  claimSpacesLeavingWithAccount,
  deleteClaimedSpace,
  deletePageShareSecrets,
  recordAuditEvent,
  setOrganizationDeletionLease,
} from "@rakazo/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deleteAccountContent, deleteOrganization } from "./account-deletion.js";

vi.mock("@rakazo/db", async (importOriginal) => ({
  ...(await importOriginal<typeof Db>()),
  claimOrganizationForDeletion: vi.fn(),
  claimSpacesLeavingWithAccount: vi.fn(),
  keepOrganizationTrialUse: vi.fn(async () => undefined),
  setOrganizationDeletionLease: vi.fn(),
  deleteClaimedSpace: vi.fn(),
  deleteEmptyOrganization: vi.fn(async () => undefined),
  deletePageShareSecrets: vi.fn(async () => []),
  releaseOrganizationDeletionClaim: vi.fn(async () => undefined),
  recordAuditEvent: vi.fn(async () => undefined),
}));

vi.mock("@rakazo/adapters", () => ({
  destroyBot: vi.fn(async () => undefined),
  forgetPageShareSecrets: vi.fn(async () => undefined),
  removeAgentHome: vi.fn(async () => undefined),
  removeDeletedBotsFromLegacyTeamHome: vi.fn(async () => undefined),
  toComputerRef: vi.fn(),
}));

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("deleteOrganization lease", () => {
  let spacesLeft: number;
  const prisma = {
    organization: { findUnique: vi.fn(async () => ({ name: "Work" })) },
    artifact: { findMany: vi.fn(async () => []) },
    bot: { findMany: vi.fn(async () => []) },
    computer: { findMany: vi.fn(async () => []) },
    space: { count: vi.fn(async () => spacesLeft) },
  };
  const deps = (overrides: Record<string, unknown> = {}) =>
    ({
      prisma,
      artifacts: { remove: vi.fn(async () => undefined) },
      ...overrides,
    }) as unknown as Parameters<typeof deleteOrganization>[0];

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    spacesLeft = 1;
    vi.mocked(claimOrganizationForDeletion).mockResolvedValue({
      claimId: "organization-deletion:org-1:attempt",
      spaceIds: ["space-1"],
      fresh: true,
    });
    vi.mocked(setOrganizationDeletionLease).mockImplementation(async () => spacesLeft > 0);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("finishes and records a deletion whose last file cleanup outlasts the lease", async () => {
    const cleanup = deferred();
    vi.mocked(deleteClaimedSpace).mockImplementation(async () => {
      spacesLeft = 0;
      return { artifactKeys: ["blob-1"], pageShareSecrets: [] };
    });
    const remove = vi.fn(() => cleanup.promise);

    const deleting = deleteOrganization(deps({ artifacts: { remove } }), "user-1", "org-1");
    await vi.waitFor(() => expect(remove).toHaveBeenCalledOnce());
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    cleanup.resolve();

    await expect(deleting).resolves.toBeUndefined();
    expect(recordAuditEvent).toHaveBeenCalledOnce();
  });

  it("stops before teardown once renewals fail for most of the lease", async () => {
    const billing = deferred();
    let billingCalled = false;
    vi.mocked(setOrganizationDeletionLease).mockRejectedValue(new Error("database unavailable"));

    const deleting = deleteOrganization(
      deps({
        billing: {
          cancelForDeletedOrganization: () => {
            billingCalled = true;
            return billing.promise;
          },
        },
      }),
      "user-1",
      "org-1",
    );
    deleting.catch(() => undefined);
    await vi.waitFor(() => expect(billingCalled).toBe(true));
    await vi.advanceTimersByTimeAsync(4 * 60_000);

    await expect(deleting).rejects.toThrow("lost its claim");
    billing.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(prisma.artifact.findMany).not.toHaveBeenCalled();
    expect(prisma.bot.findMany).not.toHaveBeenCalled();
    expect(recordAuditEvent).not.toHaveBeenCalled();
  });
});

describe("deleteAccountContent user-scoped purge rows", () => {
  it("deletes connections (and their secrets) plus other user-scoped rows idempotently", async () => {
    vi.mocked(claimSpacesLeavingWithAccount).mockResolvedValue({
      claimId: "claim",
      spaceIds: [],
      takenOver: [],
    });
    vi.mocked(deletePageShareSecrets).mockResolvedValue([]);
    const tx = {
      connection: {
        findMany: vi.fn(async () => [{ secretId: "sec-1" }, { secretId: null }]),
        deleteMany: vi.fn(async () => ({ count: 2 })),
      },
      secret: { deleteMany: vi.fn(async () => ({ count: 1 })) },
      modelOAuthSession: { deleteMany: vi.fn(async () => ({ count: 0 })) },
      cloudAgent: { deleteMany: vi.fn(async () => ({ count: 0 })) },
      sharedKeyWeekAllotment: { deleteMany: vi.fn(async () => ({ count: 0 })) },
      messagingLinkCode: { deleteMany: vi.fn(async () => ({ count: 0 })) },
      notificationPreference: { deleteMany: vi.fn(async () => ({ count: 0 })) },
      agentSkillSpace: { deleteMany: vi.fn(async () => ({ count: 0 })) },
      mcpServerSpace: { deleteMany: vi.fn(async () => ({ count: 0 })) },
      capabilityInstallSpace: { deleteMany: vi.fn(async () => ({ count: 0 })) },
    };
    const prisma = {
      $transaction: vi.fn(async (work: (client: typeof tx) => Promise<unknown>) => work(tx)),
      botDeletion: { findMany: vi.fn(async () => []) },
      space: { findMany: vi.fn(async () => []) },
      bot: { findMany: vi.fn(async () => []) },
      computer: { findMany: vi.fn(async () => []) },
      artifact: { findMany: vi.fn(async () => []) },
    };
    await deleteAccountContent(
      {
        prisma: prisma as never,
        sandbox: {} as never,
        home: {} as never,
        jobs: {} as never,
        artifacts: {} as never,
        dataDir: "/tmp",
      },
      "user-1",
    );
    expect(tx.connection.deleteMany).toHaveBeenCalledWith({ where: { userId: "user-1" } });
    expect(tx.secret.deleteMany).toHaveBeenCalledWith({ where: { id: { in: ["sec-1"] } } });
    for (const model of [
      tx.modelOAuthSession,
      tx.cloudAgent,
      tx.sharedKeyWeekAllotment,
      tx.messagingLinkCode,
      tx.notificationPreference,
      tx.agentSkillSpace,
      tx.mcpServerSpace,
      tx.capabilityInstallSpace,
    ]) {
      expect(model.deleteMany).toHaveBeenCalledWith({ where: { userId: "user-1" } });
    }
  });
});
