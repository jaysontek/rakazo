import { describe, expect, it } from "vitest";
import { humanizeModelId, resolveModelDisplay } from "./model-label";

describe("model-label", () => {
  it("humanizes slug ids when the catalog has no entry", () => {
    expect(humanizeModelId("gemini-2.5-pro")).toBe("Gemini 2.5 Pro");
    expect(resolveModelDisplay("google", "gemini-2.5-pro")).toEqual({
      name: "Gemini 2.5 Pro",
      providerName: "google",
      raw: "google/gemini-2.5-pro",
    });
  });

  it("prefers catalog label and provider display name", () => {
    expect(
      resolveModelDisplay("openai", "gpt-4.1", [
        {
          provider: "openai",
          id: "gpt-4.1",
          label: "GPT-4.1",
          providerName: "OpenAI",
          billing: "pay-as-you-go",
          auth: "api-key",
        },
      ]),
    ).toMatchObject({
      name: "GPT-4.1",
      providerName: "OpenAI",
      raw: "openai/gpt-4.1",
    });
  });
});
