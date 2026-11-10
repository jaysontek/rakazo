import { describe, expect, it } from "vitest";
import {
  validateWebPushSubscription,
  WebPushSubscriptionValidationError,
} from "./web-push-subscription.js";

describe("validateWebPushSubscription", () => {
  const valid = {
    endpoint: "https://fcm.googleapis.com/fcm/send/abc",
    keys: {
      p256dh: "BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpDtYtVJzPZfYqk5SSXrU",
      auth: "tBHItJI5svbpez7KI4CCXg",
    },
  };

  it("accepts a well-formed HTTPS subscription", () => {
    expect(validateWebPushSubscription(valid)).toEqual(valid);
  });

  it("rejects http endpoints and malformed keys", () => {
    expect(() =>
      validateWebPushSubscription({ ...valid, endpoint: "http://example.com/push" }),
    ).toThrow(WebPushSubscriptionValidationError);
    expect(() =>
      validateWebPushSubscription({
        ...valid,
        keys: { ...valid.keys, auth: "not base64url!!" },
      }),
    ).toThrow(WebPushSubscriptionValidationError);
    expect(() => validateWebPushSubscription(null)).toThrow(WebPushSubscriptionValidationError);
  });
});
