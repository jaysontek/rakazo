import { describe, expect, it } from "vitest";
import { canonicalizeWebPushEndpoint } from "./web-push-endpoint.js";
import {
  validateWebPushSubscription,
  WebPushSubscriptionValidationError,
} from "./web-push-subscription.js";

const keys = {
  p256dh: "BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpDtYtVJzPZfYqk5SSXrU",
  auth: "tBHItJI5svbpez7KI4CCXg",
};

describe("canonicalizeWebPushEndpoint", () => {
  it("returns the same href for accepted push endpoints", () => {
    const endpoint = "https://fcm.googleapis.com/fcm/send/abc";
    expect(canonicalizeWebPushEndpoint(endpoint)).toBe(endpoint);
    expect(canonicalizeWebPushEndpoint("https://db5.notify.windows.com/?token=a%2Bb")).toBe(
      "https://db5.notify.windows.com/?token=a%2Bb",
    );
    expect(
      canonicalizeWebPushEndpoint("https://updates.push.services.mozilla.com/wpush/v2/gAAAA"),
    ).toBe("https://updates.push.services.mozilla.com/wpush/v2/gAAAA");
    expect(canonicalizeWebPushEndpoint("https://web.push.apple.com/abc")).toBe(
      "https://web.push.apple.com/abc",
    );
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
    ["empty labels", "https://fcm..googleapis.com/x"],
    ["leading dot host", "https://.fcm.googleapis.com/x"],
  ])("rejects parser-disagreement bypass via adapter path: %s", (_name, endpoint) => {
    expect(canonicalizeWebPushEndpoint(endpoint)).toBeNull();
    expect(() => validateWebPushSubscription({ endpoint, keys })).toThrow(
      WebPushSubscriptionValidationError,
    );
  });
});
