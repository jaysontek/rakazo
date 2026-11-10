import { describe, expect, it } from "vitest";
import {
  appleStartupImageHtml,
  appleStartupImageLinks,
  splashFileName,
  splashMedia,
  SPLASH_DEVICES,
} from "./splash.js";
import { webManifest } from "./plugin.js";

describe("iOS splash screens", () => {
  it("covers light and dark portrait links for every device size", () => {
    const links = appleStartupImageLinks();
    expect(links.length).toBe(SPLASH_DEVICES.length * 2);
    expect(links.every((link) => link.rel === "apple-touch-startup-image")).toBe(true);
    expect(links.some((link) => link.media.includes("prefers-color-scheme: dark"))).toBe(true);
    expect(links.some((link) => link.media.includes("prefers-color-scheme: light"))).toBe(true);
    expect(links.every((link) => link.media.includes("orientation: portrait"))).toBe(true);
  });

  it("names files from pixel size, scale and theme", () => {
    const device = { width: 393, height: 852, scale: 3 };
    expect(splashFileName(device, "dark")).toBe("splash-1179x2556@3x-dark.png");
    expect(splashMedia(device, "light")).toContain("device-width: 393px");
    expect(splashMedia(device, "light")).toContain("-webkit-device-pixel-ratio: 3");
  });

  it("renders HTML link tags for injection", () => {
    const html = appleStartupImageHtml([SPLASH_DEVICES[0]!]);
    expect(html).toContain('rel="apple-touch-startup-image"');
    expect(html).toContain("/splash/");
  });
});

describe("webManifest maskable icons", () => {
  it("lists separate maskable icon files beside the any icons", () => {
    const manifest = webManifest();
    const maskable = manifest.icons.filter((icon) => icon.purpose === "maskable");
    const any = manifest.icons.filter((icon) => icon.purpose === "any");
    expect(any).toEqual([
      { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
    ]);
    expect(maskable).toEqual([
      {
        src: "/icon-maskable-192.png",
        sizes: "192x192",
        type: "image/png",
        purpose: "maskable",
      },
      {
        src: "/icon-maskable-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ]);
  });
});
