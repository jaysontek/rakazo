import { afterEach, describe, expect, it, vi } from "vitest";
import { cameraPreviewAlreadyGranted } from "./call-camera-preview";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("cameraPreviewAlreadyGranted", () => {
  it("is false when the Permissions API is missing", async () => {
    expect(await cameraPreviewAlreadyGranted(undefined)).toBe(false);
  });

  it("is false when camera permission is denied or still prompt", async () => {
    for (const state of ["denied", "prompt"] as const) {
      expect(
        await cameraPreviewAlreadyGranted({
          query: vi.fn(async () => ({ state }) as PermissionStatus),
        }),
      ).toBe(false);
    }
  });

  it("is true only when camera permission is already granted", async () => {
    expect(
      await cameraPreviewAlreadyGranted({
        query: vi.fn(async () => ({ state: "granted" }) as PermissionStatus),
      }),
    ).toBe(true);
  });

  it("is false when the browser rejects camera PermissionName", async () => {
    expect(
      await cameraPreviewAlreadyGranted({
        query: vi.fn(async () => {
          throw new TypeError("camera");
        }),
      }),
    ).toBe(false);
  });
});
