import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  PrismaWebPushSubscriptionStore,
  validateWebPushSubscription,
  WebPushSubscriptionConflictError,
  WebPushSubscriptionValidationError,
} from "./web-push-subscription.js";

describe("validateWebPushSubscription", () => {
  const valid = {
    endpoint: "https://fcm.googleapis.com/fcm/send/abc",
    keys: {
      p256dh: "BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpDtYtVJzPZfYqk5SSXrU",
      auth: "tBHItJI5svbpez7KI4CCXg",
    },
  };

  it("accepts a well-formed HTTPS subscription", () => {
    expect(validateWebPushSubscription(valid)).toEqual(valid);
  });

  it("rejects http endpoints and malformed keys", () => {
    expect(() =>
      validateWebPushSubscription({ ...valid, endpoint: "http://example.com/push" }),
    ).toThrow(WebPushSubscriptionValidationError);
    expect(() =>
      validateWebPushSubscription({
        ...valid,
        keys: { ...valid.keys, auth: "not base64url!!" },
      }),
    ).toThrow(WebPushSubscriptionValidationError);
    expect(() => validateWebPushSubscription(null)).toThrow(WebPushSubscriptionValidationError);
  });

  it.each([
    "https://localhost/push",
    "https://10.1.2.3/push",
    "https://169.254.169.254/latest",
    "https://8.8.8.8/push",
    "https://fcm.googleapis.com:5432/fcm/send/abc",
    "https://user@fcm.googleapis.com/fcm/send/abc",
    "https://evil.example/push",
  ])("rejects disallowed endpoint %s", (endpoint) => {
    expect(() => validateWebPushSubscription({ ...valid, endpoint })).toThrow(
      WebPushSubscriptionValidationError,
    );
  });

  it("rejects save without a session id", async () => {
    const store = new PrismaWebPushSubscriptionStore({} as never);
    await expect(store.save("user-1", valid, "digest", "")).rejects.toThrow(
      WebPushSubscriptionValidationError,
    );
  });
});

describe("PrismaWebPushSubscriptionStore cross-user upsert", () => {
  type Row = {
    id: string;
    userId: string;
    sessionId: string;
    endpoint: string;
    p256dh: string;
    auth: string;
    vapidDigest: string;
    failureCount: number;
  };

  let rows: Row[];
  let store: PrismaWebPushSubscriptionStore;

  let liveSessionIds: Set<string>;

  beforeEach(() => {
    rows = [];
    liveSessionIds = new Set();
    const tx = {
      session: {
        findFirst: vi.fn(
          async ({ where }: { where: { id: string; userId: string; expiresAt: { gt: Date } } }) =>
            liveSessionIds.has(where.id) ? { id: where.id } : null,
        ),
      },
      webPushSubscription: {
        findUnique: vi.fn(
          async ({ where }: { where: { endpoint: string } }) =>
            rows.find((row) => row.endpoint === where.endpoint) ?? null,
        ),
        update: vi.fn(
          async ({ where, data }: { where: { endpoint: string }; data: Partial<Row> }) => {
            const row = rows.find((entry) => entry.endpoint === where.endpoint)!;
            Object.assign(row, data);
            return row;
          },
        ),
        updateMany: vi.fn(
          async ({
            where,
            data,
          }: {
            where: { userId: string; sessionId: string };
            data: { sessionId: string };
          }) => {
            let count = 0;
            for (const row of rows) {
              if (row.userId === where.userId && row.sessionId === where.sessionId) {
                row.sessionId = data.sessionId;
                count += 1;
              }
            }
            return { count };
          },
        ),
        deleteMany: vi.fn(async ({ where }: { where: { userId: string; sessionId: string } }) => {
          const before = rows.length;
          rows = rows.filter(
            (row) => !(row.userId === where.userId && row.sessionId === where.sessionId),
          );
          return { count: before - rows.length };
        }),
        count: vi.fn(async () => rows.length),
        findFirst: vi.fn(async () => rows[0] ?? null),
        create: vi.fn(async ({ data }: { data: Omit<Row, "id" | "failureCount"> }) => {
          const row = { id: `id-${rows.length + 1}`, failureCount: 0, ...data };
          rows.push(row);
          return row;
        }),
        delete: vi.fn(async () => undefined),
      },
    };
    const txWithLock = {
      ...tx,
      $queryRaw: vi.fn(async () => [{ "": "" }]),
    };
    const prisma = {
      $transaction: vi.fn(async (fn: (client: typeof txWithLock) => Promise<void>) =>
        fn(txWithLock),
      ),
      webPushSubscription: tx.webPushSubscription,
    };
    store = new PrismaWebPushSubscriptionStore(prisma as never);
  });

  it("rejects reassignment when p256dh+auth do not match", async () => {
    rows.push({
      id: "existing",
      userId: "user-a",
      sessionId: "session-a",
      endpoint: "https://fcm.googleapis.com/fcm/send/shared",
      p256dh: "owner-key",
      auth: "owner-auth",
      vapidDigest: "digest",
      failureCount: 0,
    });
    await expect(
      store.save(
        "user-b",
        {
          endpoint: "https://fcm.googleapis.com/fcm/send/shared",
          keys: { p256dh: "other-key", auth: "other-auth" },
        },
        "digest",
        "session-b",
      ),
    ).rejects.toBeInstanceOf(WebPushSubscriptionConflictError);
    expect(rows[0]?.userId).toBe("user-a");
  });

  it("reassigns when the same browser keys claim the endpoint", async () => {
    rows.push({
      id: "existing",
      userId: "user-a",
      sessionId: "session-a",
      endpoint: "https://fcm.googleapis.com/fcm/send/shared",
      p256dh: "same-key",
      auth: "same-auth",
      vapidDigest: "digest",
      failureCount: 2,
    });
    await store.save(
      "user-b",
      {
        endpoint: "https://fcm.googleapis.com/fcm/send/shared",
        keys: { p256dh: "same-key", auth: "same-auth" },
      },
      "digest-2",
      "session-b",
    );
    expect(rows[0]).toMatchObject({
      userId: "user-b",
      sessionId: "session-b",
      vapidDigest: "digest-2",
      failureCount: 0,
    });
  });

  it("retargets rows on endSession replace when the next session is live", async () => {
    liveSessionIds.add("session-b");
    rows.push({
      id: "existing",
      userId: "user-a",
      sessionId: "session-a",
      endpoint: "https://fcm.googleapis.com/fcm/send/shared",
      p256dh: "same-key",
      auth: "same-auth",
      vapidDigest: "digest",
      failureCount: 0,
    });
    await store.endSession("user-a", "session-a", "session-b");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.sessionId).toBe("session-b");
  });

  it("deletes rows on endSession without a next session", async () => {
    rows.push({
      id: "existing",
      userId: "user-a",
      sessionId: "session-a",
      endpoint: "https://fcm.googleapis.com/fcm/send/shared",
      p256dh: "same-key",
      auth: "same-auth",
      vapidDigest: "digest",
      failureCount: 0,
    });
    await store.endSession("user-a", "session-a");
    expect(rows).toHaveLength(0);
  });

  it("deletes rows when the replacement session is not live", async () => {
    rows.push({
      id: "existing",
      userId: "user-a",
      sessionId: "session-a",
      endpoint: "https://fcm.googleapis.com/fcm/send/shared",
      p256dh: "same-key",
      auth: "same-auth",
      vapidDigest: "digest",
      failureCount: 0,
    });
    await store.endSession("user-a", "session-a", "session-dead");
    expect(rows).toHaveLength(0);
  });
});
