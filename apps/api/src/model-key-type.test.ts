import { describe, expect, it, vi } from "vitest";
import { classifyGoogleModelKeyType, sharedKeyMaterialMatches } from "./model-key-type.js";

function fixture(options?: {
  credential?: { secretId: string } | null;
  secret?: { id: string; ciphertext: string } | null;
  plaintext?: string;
}) {
  const credential =
    options && "credential" in options ? options.credential : { secretId: "secret-1" };
  const secret =
    options && "secret" in options
      ? options.secret
      : { id: "secret-1", ciphertext: "encrypted-ref" };
  return {
    prisma: {
      userModelCredential: {
        findFirst: vi.fn(async () => credential),
      },
      secret: {
        findFirst: vi.fn(async () => secret),
      },
    },
    secrets: {
      load: vi.fn(async () => options?.plaintext ?? "personal-key"),
    },
  };
}

describe("Google model key classification", () => {
  it("compares equal key material without exposing it", () => {
    expect(sharedKeyMaterialMatches("same-key", "same-key")).toBe(true);
    expect(sharedKeyMaterialMatches("same-key", "different-key")).toBe(false);
  });

  it("uses the configured deployment key when no Google credential exists", async () => {
    const withKey = fixture({ credential: null });
    await expect(
      classifyGoogleModelKeyType(withKey.prisma as never, withKey.secrets, "user-1", "shared-key"),
    ).resolves.toBe("company");
    expect(withKey.secrets.load).not.toHaveBeenCalled();

    const withoutKey = fixture({ credential: null });
    await expect(
      classifyGoogleModelKeyType(withoutKey.prisma as never, withoutKey.secrets, "user-1", null),
    ).resolves.toBe("none");
  });

  it("classifies a stored copy of the deployment key as company", async () => {
    const { prisma, secrets } = fixture({
      plaintext: JSON.stringify({ kind: "api_key", key: "shared-key" }),
    });
    await expect(
      classifyGoogleModelKeyType(prisma as never, secrets, "user-1", "shared-key"),
    ).resolves.toBe("company");
    expect(secrets.load).toHaveBeenCalledWith("encrypted-ref", "secret-1");
  });

  it("reads API key material carried by an OAuth credential", async () => {
    const { prisma, secrets } = fixture({
      plaintext: JSON.stringify({
        type: "oauth",
        access: "access-token",
        refresh: "refresh-token",
        expires: Date.now() + 60_000,
        apiKey: "shared-key",
      }),
    });
    await expect(
      classifyGoogleModelKeyType(prisma as never, secrets, "user-1", "shared-key"),
    ).resolves.toBe("company");
  });

  it("classifies distinct or unavailable stored key material as personal", async () => {
    const distinct = fixture({
      plaintext: JSON.stringify({ kind: "api_key", key: "personal-key" }),
    });
    await expect(
      classifyGoogleModelKeyType(
        distinct.prisma as never,
        distinct.secrets,
        "user-1",
        "shared-key",
      ),
    ).resolves.toBe("personal");
    expect(sharedKeyMaterialMatches("personal-key", "shared-key")).toBe(false);

    const reconnect = fixture({
      plaintext: JSON.stringify({ kind: "oauth", reconnectRequired: true }),
    });
    await expect(
      classifyGoogleModelKeyType(
        reconnect.prisma as never,
        reconnect.secrets,
        "user-1",
        "shared-key",
      ),
    ).resolves.toBe("personal");

    const missing = fixture({ secret: null });
    await expect(
      classifyGoogleModelKeyType(missing.prisma as never, missing.secrets, "user-1", "shared-key"),
    ).resolves.toBe("personal");
    expect(missing.secrets.load).not.toHaveBeenCalled();
  });

  it("treats secret-store failures as personal rather than leaking or failing the summary", async () => {
    const { prisma, secrets } = fixture();
    secrets.load.mockRejectedValueOnce(new Error("unavailable"));
    await expect(
      classifyGoogleModelKeyType(prisma as never, secrets, "user-1", "shared-key"),
    ).resolves.toBe("personal");
  });
});
