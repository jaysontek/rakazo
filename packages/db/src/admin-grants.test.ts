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
    },
    adminGrant: {
      findUnique: vi.fn(async ({ where }: { where: { userId: string } }) =>
        grants.has(where.userId) ? { userId: where.userId } : null,
      ),
      findMany: vi.fn(async () =>
        [...grants.values()].map((row) => ({
          ...row,
          user: users.get(row.userId)!,
          grantedBy: users.get(row.grantedById)!,
        })),
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
    await removeAdminGrant(prisma as never, "user", ["admin@example.test"]);
    expect(await userHasAdminGrant(prisma as never, "user")).toBe(false);
  });
});
