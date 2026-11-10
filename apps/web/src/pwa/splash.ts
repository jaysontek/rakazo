/**
 * Portrait apple-touch-startup-image sizes for current iPhones and iPads.
 * CSS points × scale → pixel image; device-width/height stay portrait values.
 */
export type SplashDevice = {
  /** CSS points (device-width × device-height). */
  width: number;
  height: number;
  scale: number;
};

export const SPLASH_DEVICES: readonly SplashDevice[] = [
  // iPhone
  { width: 440, height: 956, scale: 3 }, // 17 Pro Max / 16 Pro Max
  { width: 420, height: 912, scale: 3 }, // iPhone Air
  { width: 402, height: 874, scale: 3 }, // 17 Pro / 17 / 16 Pro
  { width: 430, height: 932, scale: 3 }, // 16 Plus / 15 Pro Max / 15 Plus / 14 Pro Max
  { width: 393, height: 852, scale: 3 }, // 16 / 15 Pro / 15 / 14 Pro
  { width: 428, height: 926, scale: 3 }, // 14 Plus / 13 Pro Max / 12 Pro Max
  { width: 390, height: 844, scale: 3 }, // 16e / 14 / 13 Pro / 13 / 12 Pro / 12
  { width: 375, height: 812, scale: 3 }, // 11 Pro / XS / X
  { width: 360, height: 780, scale: 3 }, // 13 mini / 12 mini
  { width: 414, height: 896, scale: 3 }, // 11 Pro Max / XS Max
  { width: 414, height: 896, scale: 2 }, // 11 / XR
  { width: 414, height: 736, scale: 3 }, // 8 Plus / 7 Plus / 6s Plus
  { width: 375, height: 667, scale: 2 }, // SE 2/3 / 8 / 7 / 6s
  // iPad
  { width: 1032, height: 1376, scale: 2 }, // Pro 13"
  { width: 1024, height: 1366, scale: 2 }, // Pro 12.9" / Air 13"
  { width: 834, height: 1210, scale: 2 }, // Pro 11" (M4)
  { width: 834, height: 1194, scale: 2 }, // Pro 11"
  { width: 820, height: 1180, scale: 2 }, // Air 11" / 10.9"
  { width: 834, height: 1112, scale: 2 }, // Pro / Air 10.5"
  { width: 810, height: 1080, scale: 2 }, // 10.2"
  { width: 744, height: 1133, scale: 2 }, // mini 8.3"
  { width: 768, height: 1024, scale: 2 }, // 9.7" / mini 7.9"
] as const;

export type SplashTheme = "light" | "dark";

export function splashPixelSize(device: SplashDevice): { width: number; height: number } {
  return { width: device.width * device.scale, height: device.height * device.scale };
}

export function splashFileName(device: SplashDevice, theme: SplashTheme): string {
  const { width, height } = splashPixelSize(device);
  return `splash-${width}x${height}@${device.scale}x-${theme}.png`;
}

export function splashHref(device: SplashDevice, theme: SplashTheme): string {
  return `/splash/${splashFileName(device, theme)}`;
}

export function splashMedia(device: SplashDevice, theme: SplashTheme): string {
  const scheme =
    theme === "dark" ? "(prefers-color-scheme: dark) and " : "(prefers-color-scheme: light) and ";
  return (
    `${scheme}(device-width: ${device.width}px) and (device-height: ${device.height}px) and ` +
    `(-webkit-device-pixel-ratio: ${device.scale}) and (orientation: portrait)`
  );
}

export type SplashLink = { rel: "apple-touch-startup-image"; href: string; media: string };

/** Every light and dark startup image link for index.html. */
export function appleStartupImageLinks(
  devices: readonly SplashDevice[] = SPLASH_DEVICES,
): SplashLink[] {
  const links: SplashLink[] = [];
  for (const device of devices) {
    for (const theme of ["light", "dark"] as const) {
      links.push({
        rel: "apple-touch-startup-image",
        href: splashHref(device, theme),
        media: splashMedia(device, theme),
      });
    }
  }
  return links;
}

/** HTML for the apple-touch-startup-image link set. */
export function appleStartupImageHtml(
  devices: readonly SplashDevice[] = SPLASH_DEVICES,
): string {
  return appleStartupImageLinks(devices)
    .map(
      (link) =>
        `<link rel="${link.rel}" href="${link.href}" media="${link.media}" />`,
    )
    .join("\n    ");
}
