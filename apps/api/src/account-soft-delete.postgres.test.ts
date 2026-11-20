import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TransactionalEmailProvider } from "@rakazo/adapter-kit";
import { FakeSandboxProvider } from "@rakazo/adapters";
import type { PrismaClient } from "@rakazo/db";
import {
  ACCOUNT_PURGE_CLAIM_TIMEOUT_MS,
  ACCOUNT_RESTORE_RATE_LIMIT,
  asSystem,
  bootstrapUserSpace,
  claimAccountForPurge,
  createDb,
  finalizeAccountPurge,
  requestAccountSoftDelete,
  restoreAccountSoftDelete,
} from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { accountPurgeSweep } from "./account-purge.js";
import type { AppHandles } from "./app.js";
import { createApp } from "./app.js";

const databaseUrl = process.env.VERIFY_DATABASE === "1" ? process.env.DATABASE_URL : undefined;
const describePostgres = databaseUrl ? describe.sequential : describe.skip;
const webOrigin = "http://127.0.0.1:5173";
const authSecret = "soft-delete-test-secret-with-32-characters";
const adminEmail = "admin@soft-delete.test";
const password = "soft-delete-password-12345";

describePostgres("account soft-delete helpers (PostgreSQL)", { timeout: 120_000 }, () => {
  let db: ReturnType<typeof createDb>;
  let system: PrismaClient;

  beforeAll(() => {
    db = createDb(databaseUrl!);
    system = asSystem(db.prisma);
  });
  afterAll(async () => {
    await db?.prisma.$disconnect();
    await db?.pool.end();
  });

  async function person(label: string) {
    const id = randomUUID();
    const email = `${label}-${id.slice(0, 8)}@soft-delete.test`;
    const user = await system.user.create({
      data: { id, name: label, email, emailVerified: true },
    });
    await bootstrapUserSpace(system, user, { signupsEnabled: "true", signupAllowlist: "" });
    return user;
  }

  it("refuses OTP restore when the account was deactivated before deletion", async () => {
    const admin = await person("admin");
    const target = await person("pre-deactivated");
    const deactivatedAt = new Date("2026-01-01T00:00:00.000Z");
    await system.user.update({
      where: { id: target.id },
      data: { deactivatedAt },
    });
    await requestAccountSoftDelete(system, {
      userId: target.id,
      actorUserId: admin.id,
      now: new Date("2026-02-01T00:00:00.000Z"),
    });
    const row = await system.user.findUniqueOrThrow({
      where: { id: target.id },
      select: { deactivatedBeforeDeletion: true, deletionRequestedAt: true },
    });
    expect(row.deactivatedBeforeDeletion?.toISOString()).toBe(deactivatedAt.toISOString());

    const restoreNow = new Date("2026-02-10T00:00:00.000Z");
    const otp = await restoreAccountSoftDelete(system, {
      userId: target.id,
      actorUserId: target.id,
      via: "otp",
      now: restoreNow,
    });
    expect(otp).toEqual({ restored: false, reason: "admin_only" });

    const adminRestore = await restoreAccountSoftDelete(system, {
      userId: target.id,
      actorUserId: admin.id,
      via: "admin",
      now: restoreNow,
    });
    expect(adminRestore.restored).toBe(true);
    const after = await system.user.findUniqueOrThrow({
      where: { id: target.id },
      select: { deactivatedAt: true, deletionRequestedAt: true },
    });
    expect(after.deletionRequestedAt).toBeNull();
    expect(after.deactivatedAt?.toISOString()).toBe(deactivatedAt.toISOString());
  });

  it("purges idempotently and resumes after a mid-purge crash via the stale lease", async () => {
    const admin = await person("purge-admin");
    const target = await person("purge-target");
    const now = new Date("2026-03-01T00:00:00.000Z");
    await requestAccountSoftDelete(system, {
      userId: target.id,
      actorUserId: admin.id,
      now,
      retentionMs: 0,
    });
    await system.user.update({
      where: { id: target.id },
      data: { purgeAfter: new Date(now.getTime() - 1) },
    });

    const claimedAt = await claimAccountForPurge(system, target.id, now);
    expect(claimedAt).toEqual(now);
    await expect(
      claimAccountForPurge(system, target.id, new Date(now.getTime() + 60_000)),
    ).resolves.toBeNull();

    const later = new Date(now.getTime() + ACCOUNT_PURGE_CLAIM_TIMEOUT_MS + 1);
    const retaken = await claimAccountForPurge(system, target.id, later);
    expect(retaken).toEqual(later);
    expect(await finalizeAccountPurge(system, target.id, now, later)).toBe(false);
    expect(await finalizeAccountPurge(system, target.id, later, later)).toBe(true);
    expect(await system.user.findUnique({ where: { id: target.id } })).toBeNull();
    expect(await finalizeAccountPurge(system, target.id, later, later)).toBe(false);
  });

  it("lets restore win a race against an unclaimed purge", async () => {
    const admin = await person("race-admin");
    const target = await person("race-target");
    const now = new Date("2026-04-01T00:00:00.000Z");
    await requestAccountSoftDelete(system, {
      userId: target.id,
      actorUserId: admin.id,
      now,
      retentionMs: 60_000,
    });
    const restored = await restoreAccountSoftDelete(system, {
      userId: target.id,
      actorUserId: admin.id,
      via: "admin",
      now: new Date(now.getTime() + 1_000),
    });
    expect(restored.restored).toBe(true);
    await expect(
      claimAccountForPurge(system, target.id, new Date(now.getTime() + 120_000)),
    ).resolves.toBeNull();
  });

  it("dry-runs the purge sweep when the kill switch is off", async () => {
    const admin = await person("dry-admin");
    const target = await person("dry-target");
    const now = new Date("2026-05-01T00:00:00.000Z");
    await requestAccountSoftDelete(system, {
      userId: target.id,
      actorUserId: admin.id,
      now,
      retentionMs: 0,
    });
    await system.user.update({
      where: { id: target.id },
      data: { purgeAfter: new Date(now.getTime() - 1) },
    });
    await accountPurgeSweep(
      {
        prisma: system,
        sandbox: {} as never,
        home: {} as never,
        jobs: {} as never,
        artifacts: {} as never,
        dataDir: "/tmp",
      },
      { enabled: false },
    )(new AbortController().signal);
    expect(await system.user.findUnique({ where: { id: target.id } })).not.toBeNull();
  });
});

describePostgres("account soft-delete auth flows (PostgreSQL)", { timeout: 180_000 }, () => {
  let handles: AppHandles;
  let system: PrismaClient;
  let dataDir: string;
  const sent: string[] = [];
  const email: TransactionalEmailProvider = {
    describe: () => ({
      id: "offline-email",
      contractVersion: "1",
      adapterVersion: "1",
      capabilities: { transactional: true },
    }),
    send: async (message) => {
      sent.push(message.text);
    },
  };

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "rakazo-soft-delete-"));
    handles = await createApp({
      databaseUrl: databaseUrl!,
      dataDir,
      sandboxProvider: "docker",
      sandbox: new FakeSandboxProvider(),
      agentRuntime: "scripted",
      wakeupDriver: "memory",
      signupsEnabled: "true",
      signupAllowlist: "",
      webOrigin,
      authUrl: webOrigin,
      authSecret,
      adminEmails: [adminEmail],
      email,
    });
    system = asSystem(handles.prisma);
    // Seed the env-bootstrap admin so ops gate tests have a known admin id.
    const admin = await system.user.upsert({
      where: { email: adminEmail },
      create: {
        id: randomUUID(),
        email: adminEmail,
        name: "Admin",
        emailVerified: true,
      },
      update: { emailVerified: true },
    });
    await bootstrapUserSpace(system, admin, { signupsEnabled: "true", signupAllowlist: "" }).catch(
      () => undefined,
    );
  });
  afterAll(async () => {
    await handles?.stop();
    if (dataDir) await rm(dataDir, { recursive: true, force: true });
  });

  function auth(path: string, body?: object, cookie?: string) {
    return handles.app.request(`/api/auth${path}`, {
      method: body ? "POST" : "GET",
      headers: {
        origin: webOrigin,
        "content-type": "application/json",
        ...(cookie ? { cookie } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  }
  const cookieOf = (response: Response) =>
    response.headers
      .getSetCookie()
      .map((cookie) => cookie.split(";")[0])
      .join("; ");

  async function signUp(label: string) {
    const address = `${label}-${randomUUID().slice(0, 8)}@soft-delete.test`;
    const response = await auth("/sign-up/email", {
      email: address,
      password,
      name: label,
    });
    expect(response.status).toBe(200);
    const user = await system.user.findUniqueOrThrow({ where: { email: address } });
    await system.user.update({
      where: { id: user.id },
      data: { emailVerified: true },
    });
    return { ...user, email: address, password };
  }

  async function signInWithCode(address: string) {
    sent.length = 0;
    const requested = await auth("/email-otp/send-verification-otp", {
      email: address,
      type: "sign-in",
    });
    expect(requested.status).toBe(200);
    await expect.poll(() => sent.length).toBeGreaterThan(0);
    const otp = sent.at(-1)!.match(/\b\d{6}\b/)![0];
    return auth("/sign-in/email-otp", { email: address, otp });
  }

  it("restores via OTP sign-in", async () => {
    const admin = await system.user.findUniqueOrThrow({ where: { email: adminEmail } });
    const target = await signUp("otp-restore");
    await requestAccountSoftDelete(system, {
      userId: target.id,
      actorUserId: admin.id,
    });
    expect(
      (await system.user.findUniqueOrThrow({ where: { id: target.id } })).deletionRequestedAt,
    ).not.toBeNull();

    const restored = await signInWithCode(target.email);
    expect(restored.status).toBe(200);
    const after = await system.user.findUniqueOrThrow({ where: { id: target.id } });
    expect(after.deletionRequestedAt).toBeNull();
    expect(after.deactivatedAt).toBeNull();
  });

  it("restores via a second OTP after soft-delete (sign-up mailbox reclaim path)", async () => {
    const admin = await system.user.findUniqueOrThrow({ where: { email: adminEmail } });
    const target = await signUp("signup-restore");
    await requestAccountSoftDelete(system, {
      userId: target.id,
      actorUserId: admin.id,
    });
    // Unverified sign-up against the held address is refused; a verified code restores instead.
    const signup = await auth("/sign-up/email", {
      email: target.email,
      password: "different-password-12345",
      name: "Clone",
    });
    expect(signup.status).toBeGreaterThanOrEqual(400);

    const restored = await signInWithCode(target.email);
    expect(restored.status).toBe(200);
    expect(
      (await system.user.findUniqueOrThrow({ where: { id: target.id } })).deletionRequestedAt,
    ).toBeNull();
  });

  it("refuses password sign-in while pending deletion", async () => {
    const admin = await system.user.findUniqueOrThrow({ where: { email: adminEmail } });
    const target = await signUp("password-block");
    await requestAccountSoftDelete(system, {
      userId: target.id,
      actorUserId: admin.id,
    });
    const response = await auth("/sign-in/email", {
      email: target.email,
      password: target.password,
    });
    expect(response.status).toBeGreaterThanOrEqual(400);
    const body = (await response.json().catch(() => ({}))) as { code?: string; message?: string };
    expect(`${body.code ?? ""} ${body.message ?? ""}`).toMatch(
      /PENDING_DELETION|pending deletion|deactivated/i,
    );
  });

  it("enforces the restore rate limit against the target account", async () => {
    const admin = await system.user.findUniqueOrThrow({ where: { email: adminEmail } });
    const target = await signUp("rate-limit");
    await requestAccountSoftDelete(system, {
      userId: target.id,
      actorUserId: admin.id,
    });
    for (let i = 0; i < ACCOUNT_RESTORE_RATE_LIMIT; i++) {
      await system.securityEvent.create({
        data: {
          type: "auth.account.restore.attempted",
          userId: target.id,
          metadata: { via: "otp", attempts: i },
        },
      });
    }
    const limited = await signInWithCode(target.email);
    expect(limited.status).toBeGreaterThanOrEqual(400);
    expect(
      (await system.user.findUniqueOrThrow({ where: { id: target.id } })).deletionRequestedAt,
    ).not.toBeNull();
  });

  it("rejects ops soft-delete and restore for non-admins", async () => {
    const admin = await system.user.findUniqueOrThrow({ where: { email: adminEmail } });
    const target = await signUp("ops-gate-target");
    const member = await signUp("ops-gate-member");
    const memberSession = await auth("/sign-in/email", {
      email: member.email,
      password: member.password,
    });
    expect(memberSession.status).toBe(200);
    const cookie = cookieOf(memberSession);

    const forbidden = await handles.app.request("/rpc/ops/softDeleteAccount", {
      method: "POST",
      headers: {
        origin: webOrigin,
        "content-type": "application/json",
        cookie,
      },
      body: JSON.stringify({ userId: target.id, emailConfirmation: target.email }),
    });
    expect(forbidden.status).toBeGreaterThanOrEqual(400);

    await requestAccountSoftDelete(system, {
      userId: target.id,
      actorUserId: admin.id,
    });
    const restoreForbidden = await handles.app.request("/rpc/ops/restoreAccount", {
      method: "POST",
      headers: {
        origin: webOrigin,
        "content-type": "application/json",
        cookie,
      },
      body: JSON.stringify({ userId: target.id, emailConfirmation: target.email }),
    });
    expect(restoreForbidden.status).toBeGreaterThanOrEqual(400);
  });
});
