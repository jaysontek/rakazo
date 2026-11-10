import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { isAllowedWebPushEndpoint, isRfc1123Hostname } from "./web-push-endpoint.js";

describe("isAllowedWebPushEndpoint", () => {
  it("accepts canonical FCM, Mozilla, WNS, and Apple endpoints", () => {
    expect(isAllowedWebPushEndpoint("https://fcm.googleapis.com/fcm/send/abc")).toBe(true);
    expect(isAllowedWebPushEndpoint("https://android.googleapis.com/gcm/send/abc")).toBe(true);
    expect(
      isAllowedWebPushEndpoint("https://updates.push.services.mozilla.com/wpush/v2/gAAAA"),
    ).toBe(true);
    expect(isAllowedWebPushEndpoint("https://foo.push.services.mozilla.com/w")).toBe(true);
    // Real WNS tokens percent-encode characters such as '+' in the query.
    expect(isAllowedWebPushEndpoint("https://db5.notify.windows.com/?token=a%2Bb")).toBe(true);
    expect(isAllowedWebPushEndpoint("https://web.push.apple.com/abc")).toBe(true);
    expect(isAllowedWebPushEndpoint("https://api.push.apple.com/abc")).toBe(true);
  });

  it.each([
    ["http", "http://fcm.googleapis.com/fcm/send/abc"],
    ["localhost", "https://localhost/push"],
    ["private 10.x", "https://10.0.0.1/push"],
    ["cloud metadata", "https://169.254.169.254/latest/meta-data"],
    ["IP literal", "https://8.8.8.8/push"],
    ["explicit non-443 port", "https://fcm.googleapis.com:5432/fcm/send/abc"],
    ["explicit 443 port (non-canonical href)", "https://fcm.googleapis.com:443/fcm/send/abc"],
    ["userinfo", "https://user@fcm.googleapis.com/fcm/send/abc"],
    ["user:pass", "https://user:pass@fcm.googleapis.com/fcm/send/abc"],
    ["evil host", "https://evil.example/push"],
    ["generic googleapis subdomain", "https://postgres.googleapis.com/x"],
    ["googleapis apex", "https://googleapis.com/x"],
    ["notify.windows apex", "https://notify.windows.com/x"],
    ["push.apple apex", "https://push.apple.com/abc"],
    ["lookalike mozilla", "https://updates.push.services.mozilla.com.evil.example/x"],
    ["empty labels", "https://fcm..googleapis.com/x"],
    ["leading dot host", "https://.fcm.googleapis.com/x"],
    ["empty", ""],
    ["not a url", "not-a-url"],
  ])("rejects %s", (_name, endpoint) => {
    expect(isAllowedWebPushEndpoint(endpoint)).toBe(false);
  });

  it.each([
    ["percent-encoded dot host", "https://postgres%2Egoogleapis%2Ecom/x"],
    ["quote before allowed suffix", 'https://127.0.0.1"x{fcm.googleapis.com/x'],
    ["metadata quote bypass", 'https://169.254.169.254"x{fcm.googleapis.com/latest/meta-data'],
    ["brace before suffix", "https://127.0.0.1{x}fcm.googleapis.com/x"],
    ["backtick before suffix", "https://evil`fcm.googleapis.com/x"],
    ["backslash in authority", "https://fcm.googleapis.com\\@evil.example/x"],
    ["full-width dot", "https://fcm\u3002googleapis.com/fcm/send/abc"],
    ["zero-width space", "https://fcm.googleapis.com\u200b/fcm/send/abc"],
  ])("rejects parser-disagreement bypass: %s", (_name, endpoint) => {
    expect(isAllowedWebPushEndpoint(endpoint)).toBe(false);
  });
});

describe("isRfc1123Hostname", () => {
  it("rejects empty labels and leading dots", () => {
    expect(isRfc1123Hostname("fcm.googleapis.com")).toBe(true);
    expect(isRfc1123Hostname("fcm..googleapis.com")).toBe(false);
    expect(isRfc1123Hostname(".fcm.googleapis.com")).toBe(false);
    expect(isRfc1123Hostname("fcm.googleapis.com.")).toBe(false);
  });
});

describe("contracts package browser boundary", () => {
  it("does not import node: modules from packages/contracts/src", async () => {
    const root = fileURLToPath(new URL(".", import.meta.url));
    const files: string[] = [];
    async function walk(dir: string) {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) await walk(path);
        else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) files.push(path);
      }
    }
    await walk(root);
    const offenders: string[] = [];
    for (const file of files) {
      const source = await readFile(file, "utf8");
      if (/\bfrom\s+["']node:/.test(source) || /\bimport\s*\(\s*["']node:/.test(source)) {
        offenders.push(file.slice(root.length));
      }
    }
    expect(offenders).toEqual([]);
  });
});
