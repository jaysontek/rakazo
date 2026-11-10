import { describe, expect, it } from "vitest";
import { isAllowedWebPushEndpoint } from "./web-push-endpoint.js";

describe("isAllowedWebPushEndpoint", () => {
  it("accepts known browser push hosts over https", () => {
    expect(isAllowedWebPushEndpoint("https://fcm.googleapis.com/fcm/send/abc")).toBe(true);
    expect(isAllowedWebPushEndpoint("https://android.googleapis.com/gcm/send/abc")).toBe(true);
    expect(
      isAllowedWebPushEndpoint("https://updates.push.services.mozilla.com/wpush/v2/gAAAA"),
    ).toBe(true);
    expect(isAllowedWebPushEndpoint("https://db5.notify.windows.com/?token=abc")).toBe(true);
    expect(isAllowedWebPushEndpoint("https://web.push.apple.com/abc")).toBe(true);
    expect(isAllowedWebPushEndpoint("https://push.apple.com/abc")).toBe(true);
  });

  it.each([
    ["http", "http://fcm.googleapis.com/fcm/send/abc"],
    ["localhost", "https://localhost/push"],
    ["private 10.x", "https://10.0.0.1/push"],
    ["cloud metadata", "https://169.254.169.254/latest/meta-data"],
    ["IP literal", "https://8.8.8.8/push"],
    ["explicit non-443 port", "https://fcm.googleapis.com:5432/fcm/send/abc"],
    ["userinfo", "https://user@fcm.googleapis.com/fcm/send/abc"],
    ["user:pass", "https://user:pass@fcm.googleapis.com/fcm/send/abc"],
    ["evil host", "https://evil.example/push"],
    ["lookalike mozilla", "https://updates.push.services.mozilla.com.evil.example/x"],
    ["empty", ""],
    ["not a url", "not-a-url"],
  ])("rejects %s", (_name, endpoint) => {
    expect(isAllowedWebPushEndpoint(endpoint)).toBe(false);
  });

  it("allows an explicit 443 port", () => {
    expect(isAllowedWebPushEndpoint("https://fcm.googleapis.com:443/fcm/send/abc")).toBe(true);
  });
});
