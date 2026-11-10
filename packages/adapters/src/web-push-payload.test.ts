import { describe, expect, it } from "vitest";
import {
  buildWebPushPayload,
  MAX_WEB_PUSH_BODY_CHARS,
  MAX_WEB_PUSH_PAYLOAD_BYTES,
  MAX_WEB_PUSH_TITLE_CHARS,
  webPushOpenPath,
} from "./web-push-payload.js";

describe("buildWebPushPayload", () => {
  it("keeps title/body and a same-origin open path", () => {
    const payload = buildWebPushPayload(
      {
        kind: "completion",
        title: "Done",
        body: "Reply text",
        botId: "bot-1",
        threadId: "thread-1",
      },
      "space-1",
    );
    expect(payload.title).toBe("Done");
    expect(payload.body).toBe("Reply text");
    expect(payload.icon).toBe("/icon-192.png");
    expect(payload.data.url).toBe("/?space=space-1&bot=bot-1&thread=thread-1");
    expect(payload.data.url.startsWith("/")).toBe(true);
  });

  it("opens a group chat when groupId is set", () => {
    expect(
      webPushOpenPath(
        {
          kind: "help",
          title: "Help",
          body: "Need you",
          botId: "bot-1",
          threadId: "thread-1",
          groupId: "group-1",
        },
        "space-1",
      ),
    ).toBe("/?space=space-1&group=group-1&thread=thread-1");
  });

  it("caps oversized text inside the payload budget", () => {
    const payload = buildWebPushPayload(
      {
        kind: "failure",
        title: "x".repeat(MAX_WEB_PUSH_TITLE_CHARS + 50),
        body: "y".repeat(MAX_WEB_PUSH_BODY_CHARS * 4),
        botId: "b",
        threadId: "t",
      },
      "s",
    );
    expect(Array.from(payload.title).length).toBeLessThanOrEqual(MAX_WEB_PUSH_TITLE_CHARS);
    expect(Buffer.byteLength(JSON.stringify(payload), "utf8")).toBeLessThanOrEqual(
      MAX_WEB_PUSH_PAYLOAD_BYTES,
    );
  });
});
