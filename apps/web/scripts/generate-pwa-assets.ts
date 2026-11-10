/**
 * Regenerates maskable icons and iOS splash screens from the brand mark.
 * Run: pnpm --filter @rakazo/web generate:pwa-assets
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { webDarkTokens, webLightTokens } from "@rakazo/ui-tokens";
import sharp from "sharp";
import type { SplashTheme } from "../src/pwa/splash.ts";
import { SPLASH_DEVICES, splashFileName, splashPixelSize } from "../src/pwa/splash.ts";

const root = fileURLToPath(new URL("../../..", import.meta.url));
const source = join(root, "packages/ui-tokens/assets/Rakazo.icon/Assets/orange-bot.png");
const publicDir = join(root, "apps/web/public");
const splashDir = join(publicDir, "splash");

// Match export-brand: character sits 90 points below center on a dark plate.
const portrait = await sharp(source).resize(1024, 1024).png().toBuffer();

async function framed(background: string) {
  return sharp({ create: { width: 1024, height: 1114, channels: 4, background } })
    .composite([{ input: portrait, top: 90, left: 0 }])
    .extract({ left: 0, top: 0, width: 1024, height: 1024 })
    .png()
    .toBuffer();
}

/**
 * Maskable icons keep the glyph inside the center ~80% safe zone so launcher
 * masks do not clip the character.
 */
async function maskable(size: number) {
  const pad = Math.round(size * 0.12);
  const inner = size - pad * 2;
  const glyph = await sharp(await framed(webDarkTokens.background))
    .resize(inner, inner)
    .png()
    .toBuffer();
  return sharp({
    create: { width: size, height: size, channels: 4, background: webDarkTokens.background },
  })
    .composite([{ input: glyph, top: pad, left: pad }])
    .png({ compressionLevel: 9 })
    .toBuffer();
}

async function splashImage(width: number, height: number, theme: SplashTheme): Promise<Buffer> {
  const background = theme === "dark" ? webDarkTokens.background : webLightTokens.background;
  const markSize = Math.round(Math.min(width, height) * 0.28);
  const mark = await sharp(await framed("transparent"))
    .resize(markSize, markSize)
    .png()
    .toBuffer();
  return sharp({ create: { width, height, channels: 4, background } })
    .composite([
      {
        input: mark,
        top: Math.round((height - markSize) / 2),
        left: Math.round((width - markSize) / 2),
      },
    ])
    .png({ compressionLevel: 9, palette: true, colors: 64 })
    .toBuffer();
}

await mkdir(splashDir, { recursive: true });

for (const size of [192, 512] as const) {
  const out = join(publicDir, `icon-maskable-${size}.png`);
  await writeFile(out, await maskable(size));
  console.log(`wrote ${relative(root, out)}`);
}

for (const device of SPLASH_DEVICES) {
  const { width, height } = splashPixelSize(device);
  for (const theme of ["light", "dark"] as const) {
    const name = splashFileName(device, theme);
    const out = join(splashDir, name);
    await writeFile(out, await splashImage(width, height, theme));
    console.log(`wrote ${relative(root, out)}`);
  }
}

console.log(`generated ${SPLASH_DEVICES.length * 2} splash images and 2 maskable icons`);
