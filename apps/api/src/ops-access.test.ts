import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it } from "vitest";
import { requireOpsDashboardAccess } from "./ops-access.js";

describe("requireOpsDashboardAccess", () => {
  const users = [
    { id: "admin", email: "admin@example.test", emailVerified: true },
    { id: "user", email: "user@example.test", emailVerified: true },
  ];
  const prisma = {
    user: {
      findUnique: async ({ where }: { where: { id: string } }) =>
        users.find((user) => user.id === where.id) ?? null,
    },
  } as unknown as PrismaClient;

  const deps = {
    prisma,
    env: {
      adminEmails: ["admin@example.test"],
      opsDashboardAllowlist: ["192.168.140.0/24", "100.64.0.0/10"],
    },
  };

  it("denies a non-admin even on an allowed LAN address", async () => {
    await expect(requireOpsDashboardAccess(deps, "user", "192.168.140.10")).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: "Admins only",
    });
  });

  it("denies an admin outside the CIDR allowlist", async () => {
    await expect(requireOpsDashboardAccess(deps, "admin", "203.0.113.50")).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: "Operations dashboard is limited to allowed networks",
    });
  });

  it("denies an admin when the client IP is missing", async () => {
    await expect(requireOpsDashboardAccess(deps, "admin", undefined)).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: "Operations dashboard is limited to allowed networks",
    });
  });

  it("allows an admin on the LAN allowlist", async () => {
    await expect(
      requireOpsDashboardAccess(deps, "admin", "192.168.140.10"),
    ).resolves.toBeUndefined();
  });

  it("allows an admin on loopback when the allowlist is empty", async () => {
    await expect(
      requireOpsDashboardAccess(
        { prisma, env: { adminEmails: ["admin@example.test"], opsDashboardAllowlist: [] } },
        "admin",
        "127.0.0.1",
      ),
    ).resolves.toBeUndefined();
  });
});
