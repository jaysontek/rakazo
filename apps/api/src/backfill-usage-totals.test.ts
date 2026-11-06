import { describe, expect, it, vi } from "vitest";
import { backfillUsageTotals, usageTotalsPatch } from "./backfill-usage-totals.js";

describe("usageTotalsPatch", () => {
  it("derives totalTokens and catalog cost when both are null", () => {
    expect(
      usageTotalsPatch({
        id: "row",
        inputTokens: 100,
        outputTokens: 20,
        cacheReadTokens: null,
        cacheWriteTokens: null,
        cacheWrite1hTokens: null,
        totalTokens: null,
        costUsd: null,
        costSource: null,
        pricingVersion: null,
        pricingSnapshot: { input: 0.75, output: 3.75, cacheRead: 0.075, cacheWrite: 0 },
      }),
    ).toEqual({
      totalTokens: 120,
      costUsd: 0.00015,
      costSource: "pi-catalog-estimate",
      pricingVersion: "pi-ai-1.3.0",
    });
  });

  it("leaves provider-reported cost alone and only fills totalTokens", () => {
    expect(
      usageTotalsPatch({
        id: "row",
        inputTokens: 10,
        outputTokens: 2,
        cacheReadTokens: null,
        cacheWriteTokens: null,
        cacheWrite1hTokens: null,
        totalTokens: null,
        costUsd: 0.42,
        costSource: "provider-reported",
        pricingVersion: null,
        pricingSnapshot: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
      }),
    ).toEqual({ totalTokens: 12 });
  });

  it("skips rows that cannot be recomputed", () => {
    expect(
      usageTotalsPatch({
        id: "row",
        inputTokens: 10,
        outputTokens: null,
        cacheReadTokens: null,
        cacheWriteTokens: null,
        cacheWrite1hTokens: null,
        totalTokens: null,
        costUsd: null,
        costSource: null,
        pricingVersion: null,
        pricingSnapshot: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
      }),
    ).toBeNull();
    expect(
      usageTotalsPatch({
        id: "row",
        inputTokens: 10,
        outputTokens: 2,
        cacheReadTokens: null,
        cacheWriteTokens: null,
        cacheWrite1hTokens: null,
        totalTokens: 12,
        costUsd: null,
        costSource: null,
        pricingVersion: null,
        pricingSnapshot: null,
      }),
    ).toBeNull();
  });
});

describe("backfillUsageTotals", () => {
  it("dry-run counts patches without writing", async () => {
    const update = vi.fn();
    const prisma = {
      usageRecord: {
        findMany: async () => [
          {
            id: "a",
            inputTokens: 100,
            outputTokens: 20,
            cacheReadTokens: null,
            cacheWriteTokens: null,
            cacheWrite1hTokens: null,
            totalTokens: null,
            costUsd: null,
            costSource: null,
            pricingVersion: null,
            pricingSnapshot: { input: 0.75, output: 3.75, cacheRead: 0.075, cacheWrite: 0 },
          },
          {
            id: "b",
            inputTokens: 1,
            outputTokens: 1,
            cacheReadTokens: null,
            cacheWriteTokens: null,
            cacheWrite1hTokens: null,
            totalTokens: 2,
            costUsd: null,
            costSource: null,
            pricingVersion: null,
            pricingSnapshot: null,
          },
        ],
        update,
      },
    };
    await expect(backfillUsageTotals(prisma, { dryRun: true })).resolves.toEqual({
      scanned: 2,
      wouldTouch: 1,
      updated: 0,
      skipped: 1,
    });
    expect(update).not.toHaveBeenCalled();
  });
});
