import { describe, expect, it, vi } from "vitest";
import { createAuth } from "./index.js";

describe("impersonation auth hooks", () => {
  it("strips expiresAt refresh while impersonating", async () => {
    const sessionRow = {
      impersonatedBy: "admin",
      impersonationExpiresAt: new Date("2026-01-01T00:30:00Z"),
      expiresAt: new Date("2026-01-01T00:20:00Z"),
    };
    const prisma = {
      session: {
        findUnique: vi.fn(async () => sessionRow),
      },
    };
    const auth = createAuth(prisma as never, {
      secret: "offline-auth-secret-at-least-32-characters",
      baseURL: "https://api.example.test",
      webOrigin: "https://app.example.test",
      signupsEnabled: "true",
      signupAllowlist: "",
    });
    const hook = auth.options.databaseHooks!.session!.update!.before!;
    const result = await hook({
      id: "session-1",
      expiresAt: new Date("2026-01-08T00:00:00Z"),
    } as never);
    expect(result).toMatchObject({
      data: {
        expiresAt: sessionRow.expiresAt,
        impersonationExpiresAt: sessionRow.impersonationExpiresAt,
      },
    });
    expect((result as { data: { expiresAt: Date } }).data.expiresAt.getTime()).toBe(
      sessionRow.expiresAt.getTime(),
    );
  });

  it("leaves ordinary session refresh alone", async () => {
    const prisma = {
      session: {
        findUnique: vi.fn(async () => ({
          impersonatedBy: null,
          impersonationExpiresAt: null,
          expiresAt: new Date(),
        })),
      },
    };
    const auth = createAuth(prisma as never, {
      secret: "offline-auth-secret-at-least-32-characters",
      baseURL: "https://api.example.test",
      webOrigin: "https://app.example.test",
      signupsEnabled: "true",
      signupAllowlist: "",
    });
    const hook = auth.options.databaseHooks!.session!.update!.before!;
    const next = new Date("2026-02-01T00:00:00Z");
    await expect(hook({ id: "session-1", expiresAt: next } as never)).resolves.toBeUndefined();
  });
});
