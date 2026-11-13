import { beforeEach, describe, expect, it, vi } from "vitest";
import { addAdminGrant, listAdminGrants, removeAdminGrant, userHasAdminGrant } from "./admin-grants.js";

describe("admin grants", () => {
  const users = new Map<
    string,
    {
      id: string;
      email: string;
      name: string;
      emailVerified: boolean;
      deactivatedAt: Date | null;
    }
  >();
  const grants = new Map<string, { userId: string; grantedById: string; createdAt: Date }>();

  const prisma = {
    user: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => users.get(where.id) ?? null),
      findMany: vi.fn(
        async ({
          where,
        }: {
          where?: { emailVerified?: boolean; deactivatedAt?: null };
          select?: unknown;
        }) =>
          [...users.values()].filter((user) => {
            if (where?.emailVerified === true && !user.emailVerified) return false;
            if (where?.deactivatedAt === null && user.deactivatedAt != null) return false;
            return true;
          }),
      ),
    },
    adminGrant: {
      findUnique: vi.fn(async ({ where }: { where: { userId: string } }) =>
        grants.has(where.userId) ? { userId: where.userId } : null,
      ),
      findMany: vi.fn(
        async ({
          where,
        }: {
          where?: { userId?: { not: string } };
          orderBy?: unknown;
          include?: unknown;
        } = {}) => {
          let rows = [...grants.values()];
          if (where?.userId?.not != null) {
            rows = rows.filter((row) => row.userId !== where.userId!.not);
          }
          return rows.map((row) => ({
            ...row,
            user: users.get(row.userId)!,
            grantedBy: users.get(row.grantedById)!,
          }));
        },
      ),
      upsert: vi.fn(
        async ({
          where,
          create,
        }: {
          where: { userId: string };
          create: { userId: string; grantedById: string };
        }) => {
          if (!grants.has(where.userId)) {
            grants.set(create.userId, { ...create, createdAt: new Date("2026-11-13T12:00:00Z") });
          }
        },
      ),
      deleteMany: vi.fn(async ({ where }: { where: { userId: string } }) => {
        grants.delete(where.userId);
      }),
    },
  };

  beforeEach(() => {
    users.clear();
    grants.clear();
    users.set("admin", {
      id: "admin",
      email: "admin@example.test",
      name: "Admin",
      emailVerified: true,
      deactivatedAt: null,
    });
    users.set("user", {
      id: "user",
      email: "user@example.test",
      name: "User",
      emailVerified: true,
      deactivatedAt: null,
    });
  });

  it("adds and lists grants", async () => {
    expect(await userHasAdminGrant(prisma as never, "user")).toBe(false);
    await addAdminGrant(prisma as never, { userId: "user", grantedById: "admin" }, []);
    expect(await userHasAdminGrant(prisma as never, "user")).toBe(true);
    const listed = await listAdminGrants(prisma as never, ["admin@example.test"]);
    expect(listed).toEqual([
      expect.objectContaining({
        userId: "user",
        email: "user@example.test",
        envBootstrap: false,
      }),
    ]);
  });

  it("refuses unverified or deactivated users", async () => {
    users.set("bad", {
      id: "bad",
      email: "bad@example.test",
      name: "Bad",
      emailVerified: false,
      deactivatedAt: null,
    });
    await expect(
      addAdminGrant(prisma as never, { userId: "bad", grantedById: "admin" }, []),
    ).rejects.toThrow(/not verified/);
    users.set("gone", {
      id: "gone",
      email: "gone@example.test",
      name: "Gone",
      emailVerified: true,
      deactivatedAt: new Date(),
    });
    await expect(
      addAdminGrant(prisma as never, { userId: "gone", grantedById: "admin" }, []),
    ).rejects.toThrow(/deactivated/);
  });

  it("refuses hidden ops emails on grant and remove", async () => {
    users.set("ops", {
      id: "ops",
      email: "owner@builddrive.net",
      name: "Ops",
      emailVerified: true,
      deactivatedAt: null,
    });
    await expect(
      addAdminGrant(prisma as never, { userId: "ops", grantedById: "admin" }, []),
    ).rejects.toThrow(/hidden ops/);
    grants.set("ops", {
      userId: "ops",
      grantedById: "admin",
      createdAt: new Date("2026-11-13T12:00:00Z"),
    });
    await expect(
      removeAdminGrant(prisma as never, "ops", ["admin@example.test"]),
    ).rejects.toThrow(/hidden ops/);
  });

  it("will not remove an env bootstrap admin", async () => {
    await expect(
      addAdminGrant(
        prisma as never,
        { userId: "admin", grantedById: "admin" },
        ["ADMIN@example.test"],
      ),
    ).rejects.toThrow(/env bootstrap/);

    grants.set("admin", {
      userId: "admin",
      grantedById: "admin",
      createdAt: new Date("2026-11-13T12:00:00Z"),
    });
    await expect(removeAdminGrant(prisma as never, "admin", ["admin@example.test"])).rejects.toThrow(
      /env bootstrap/,
    );
    await addAdminGrant(prisma as never, { userId: "user", grantedById: "admin" }, []);
    await removeAdminGrant(prisma as never, "user", ["admin@example.test"]);
    expect(await userHasAdminGrant(prisma as never, "user")).toBe(false);
  });

  it("rejects self-revoke when actorUserId matches", async () => {
    await addAdminGrant(prisma as never, { userId: "user", grantedById: "admin" }, []);
    await expect(
      removeAdminGrant(prisma as never, "user", ["admin@example.test"], "user"),
    ).rejects.toThrow(/own admin grant/);
  });

  it("rejects removing the last effective admin", async () => {
    await addAdminGrant(prisma as never, { userId: "user", grantedById: "admin" }, []);
    await expect(removeAdminGrant(prisma as never, "user", [])).rejects.toThrow(/last admin/);
    expect(await userHasAdminGrant(prisma as never, "user")).toBe(true);
  });

  it("allows removal when another env bootstrap admin remains", async () => {
    await addAdminGrant(prisma as never, { userId: "user", grantedById: "admin" }, []);
    await removeAdminGrant(prisma as never, "user", ["admin@example.test"], "admin");
    expect(await userHasAdminGrant(prisma as never, "user")).toBe(false);
  });

  it("allows removal when another DB grant remains", async () => {
    users.set("other", {
      id: "other",
      email: "other@example.test",
      name: "Other",
      emailVerified: true,
      deactivatedAt: null,
    });
    await addAdminGrant(prisma as never, { userId: "user", grantedById: "admin" }, []);
    await addAdminGrant(prisma as never, { userId: "other", grantedById: "admin" }, []);
    await removeAdminGrant(prisma as never, "user", [], "admin");
    expect(await userHasAdminGrant(prisma as never, "user")).toBe(false);
    expect(await userHasAdminGrant(prisma as never, "other")).toBe(true);
  });
});
