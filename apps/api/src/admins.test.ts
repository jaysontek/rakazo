import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it } from "vitest";
import { effectiveAdminUserId, isAdmin, isEnvBootstrapAdmin } from "./admins.js";

describe("isAdmin", () => {
  const users = [
    {
      id: "verified",
      email: "Admin@Example.test",
      emailVerified: true,
      deactivatedAt: null,
    },
    {
      id: "unverified",
      email: "admin@example.test",
      emailVerified: false,
      deactivatedAt: null,
    },
    {
      id: "granted",
      email: "granted@example.test",
      emailVerified: true,
      deactivatedAt: null,
    },
    {
      id: "deactivated-grant",
      email: "deactivated@example.test",
      emailVerified: true,
      deactivatedAt: new Date(),
    },
  ];
  const grants = new Set(["granted", "deactivated-grant"]);
  const prisma = {
    user: {
      findUnique: async ({ where }: { where: { id: string } }) => {
        const user = users.find((candidate) => candidate.id === where.id);
        return user
          ? { ...user, adminGrant: grants.has(user.id) ? { userId: user.id } : null }
          : null;
      },
    },
  } as unknown as PrismaClient;

  it("accepts a verified environment bootstrap admin", async () => {
    const deps = { prisma, env: { adminEmails: ["admin@example.test"] } as never };
    expect(await isAdmin(deps, "verified")).toBe(true);
    expect(await isAdmin(deps, "unverified")).toBe(false);
    expect(await isEnvBootstrapAdmin(deps, "verified")).toBe(true);
    expect(await isEnvBootstrapAdmin(deps, "unverified")).toBe(false);
  });

  it("accepts only active, verified database grants", async () => {
    expect(await isAdmin({ prisma, env: {} as never }, "verified")).toBe(false);
    expect(await isAdmin({ prisma, env: {} as never }, "granted")).toBe(true);
    expect(await isAdmin({ prisma, env: {} as never }, "deactivated-grant")).toBe(false);
  });

  it("keeps the original admin effective during impersonation", () => {
    expect(effectiveAdminUserId({ userId: "current" })).toBe("current");
    expect(effectiveAdminUserId({ userId: "target", impersonatedBy: "admin" })).toBe("admin");
  });
});
