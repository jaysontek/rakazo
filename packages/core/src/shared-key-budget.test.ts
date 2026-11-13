import { describe, expect, it } from "vitest";
import {
  formatSharedKeyBudgetResetAt,
  fullWeekShareUsd,
  midWeekJoinFraction,
  parseSharedKeyMonthlyBudgetInput,
  redivideWeeklyAllotments,
  SHARED_KEY_BUDGET_TIMEZONE,
  sharedKeyBudgetPercentUsed,
  sharedKeySpendWindowStart,
  sharedKeyWeekEnd,
  sharedKeyWeekStart,
  weekFractionRemaining,
} from "./shared-key-budget.js";

describe("shared-key weekly budget math", () => {
  it("documents the America/New_York week boundary", () => {
    expect(SHARED_KEY_BUDGET_TIMEZONE).toBe("America/New_York");
    // Wednesday evening UTC is still Tuesday local after the fall-back; week started Monday 05:00Z.
    const midweek = new Date("2026-11-04T18:00:00.000Z");
    expect(sharedKeyWeekStart(midweek).toISOString()).toBe("2026-11-02T05:00:00.000Z");
    expect(sharedKeyWeekEnd(sharedKeyWeekStart(midweek)).toISOString()).toBe(
      "2026-11-09T05:00:00.000Z",
    );
  });

  it("resets the week at the America/New_York Monday boundary", () => {
    const before = new Date("2026-11-09T04:59:59.000Z");
    const after = new Date("2026-11-09T05:00:00.000Z");
    expect(sharedKeyWeekStart(before).toISOString()).toBe("2026-11-02T05:00:00.000Z");
    expect(sharedKeyWeekStart(after).toISOString()).toBe("2026-11-09T05:00:00.000Z");
  });

  it("splits a configurable monthly cap evenly across users and by 4 weeks", () => {
    expect(fullWeekShareUsd(400, 4)).toBe(25);
    expect(fullWeekShareUsd(100, 5)).toBe(5);
    expect(fullWeekShareUsd(0, 4)).toBe(0);
    expect(fullWeekShareUsd(100, 0)).toBe(0);
  });

  it("assigns an even full-week share when opening a week", () => {
    const weekStart = new Date("2026-11-02T05:00:00.000Z");
    const allotments = redivideWeeklyAllotments({
      monthlyCapUsd: 400,
      members: [
        { userId: "a", joinedAt: weekStart },
        { userId: "b", joinedAt: weekStart },
        { userId: "c", joinedAt: weekStart },
        { userId: "d", joinedAt: weekStart },
      ],
      weekStart,
      now: weekStart,
      previousAllotments: new Map(),
      spentByUser: new Map(),
    });
    expect([...allotments.values()]).toEqual([25, 25, 25, 25]);
  });

  it("gives a mid-week new user a proportional slice, not a full week share", () => {
    const weekStart = new Date("2026-11-02T05:00:00.000Z");
    const mid = new Date("2026-11-05T17:00:00.000Z"); // halfway through the week
    const previous = new Map([
      ["a", 25],
      ["b", 25],
    ]);
    const spent = new Map([
      ["a", 10],
      ["b", 5],
    ]);
    // Remaining pool: (25-10)+(25-5)=35; three members → evenRemaining ≈ 11.666
    // Full share with 3 users: 400/3/4 ≈ 33.333; half week → proportional ≈ 16.666
    // New user capped at min(even, proportional) = even; no surplus clamp.
    const fraction = weekFractionRemaining(mid, weekStart);
    expect(fraction).toBeCloseTo(0.5, 1);

    const allotments = redivideWeeklyAllotments({
      monthlyCapUsd: 400,
      members: [
        { userId: "a", joinedAt: weekStart },
        { userId: "b", joinedAt: weekStart },
        { userId: "c", joinedAt: mid },
      ],
      weekStart,
      now: mid,
      previousAllotments: previous,
      spentByUser: spent,
    });

    const fullShare = fullWeekShareUsd(400, 3);
    const newCap = fullShare * fraction;
    expect(allotments.get("c")!).toBeLessThan(fullShare);
    expect(allotments.get("c")!).toBeCloseTo(Math.min(35 / 3, newCap), 5);
    // Continuing users keep their spent and receive an even remaining slice.
    expect(allotments.get("a")!).toBeCloseTo(10 + 35 / 3, 5);
    expect(allotments.get("b")!).toBeCloseTo(5 + 35 / 3, 5);
  });

  it("re-divides remaining budget when a user is removed", () => {
    const weekStart = new Date("2026-11-02T05:00:00.000Z");
    const now = new Date("2026-11-04T12:00:00.000Z");
    const previous = new Map([
      ["a", 25],
      ["b", 25],
      ["c", 25],
    ]);
    const spent = new Map([
      ["a", 20],
      ["b", 0],
      ["c", 10],
    ]);
    // Remaining including removed c: 5+25+15=45 → two users get 22.5 remaining each.
    const allotments = redivideWeeklyAllotments({
      monthlyCapUsd: 400,
      members: [
        { userId: "a", joinedAt: weekStart },
        { userId: "b", joinedAt: weekStart },
      ],
      weekStart,
      now,
      previousAllotments: previous,
      spentByUser: spent,
    });
    expect(allotments.get("a")!).toBeCloseTo(20 + 22.5, 5);
    expect(allotments.get("b")!).toBeCloseTo(0 + 22.5, 5);
    expect(allotments.has("c")).toBe(false);
  });

  it("keeps reservedUsd out of the redistributed pool", () => {
    const weekStart = new Date("2026-11-02T05:00:00.000Z");
    const now = new Date("2026-11-04T12:00:00.000Z");
    const allotments = redivideWeeklyAllotments({
      monthlyCapUsd: 400,
      members: [
        { userId: "a", joinedAt: weekStart },
        { userId: "b", joinedAt: weekStart },
      ],
      weekStart,
      now,
      previousAllotments: new Map([
        ["a", 50],
        ["b", 50],
      ]),
      spentByUser: new Map([
        ["a", 10],
        ["b", 0],
      ]),
      reservedByUser: new Map([
        ["a", 20],
        ["b", 0],
      ]),
    });
    // Remaining: (50-10-20)+(50-0-0)=70 → 35 each. Continuing a keeps spent+reserved.
    expect(allotments.get("a")!).toBeCloseTo(10 + 20 + 35, 5);
    expect(allotments.get("b")!).toBeCloseTo(0 + 0 + 35, 5);
  });

  it("re-bases on the new monthly cap instead of the old allotment pool", () => {
    const weekStart = new Date("2026-11-02T05:00:00.000Z");
    const now = new Date("2026-11-05T17:00:00.000Z");
    const allotments = redivideWeeklyAllotments({
      monthlyCapUsd: 200,
      members: [
        { userId: "a", joinedAt: weekStart },
        { userId: "b", joinedAt: weekStart },
        { userId: "c", joinedAt: now },
      ],
      weekStart,
      now,
      // Old $50 monthly → $12.50 each. Without rebaseOnMonthlyCap these would stick.
      previousAllotments: new Map([
        ["a", 12.5],
        ["b", 12.5],
      ]),
      spentByUser: new Map([
        ["a", 12.5],
        ["b", 0],
      ]),
      rebaseOnMonthlyCap: true,
    });
    // 200 / 3 / 4; mid-week joiner c is pro-rated by join-time remaining fraction.
    const fullShare = fullWeekShareUsd(200, 3);
    expect(allotments.get("a")).toBeCloseTo(fullShare, 5);
    expect(allotments.get("b")).toBeCloseTo(fullShare, 5);
    expect(allotments.get("c")).toBeCloseTo(fullShare * midWeekJoinFraction(now, weekStart), 5);
  });

  it("freezes mid-week join pro-rate at join time across later cap re-bases", () => {
    const weekStart = new Date("2026-11-02T05:00:00.000Z");
    const joinedAt = new Date("2026-11-05T17:00:00.000Z"); // ~50% of week left
    const laterSave = new Date("2026-11-08T05:00:00.000Z"); // ~14% left
    expect(midWeekJoinFraction(joinedAt, weekStart)).toBeCloseTo(0.5, 1);
    expect(weekFractionRemaining(laterSave, weekStart)).toBeLessThan(0.25);

    const allotments = redivideWeeklyAllotments({
      monthlyCapUsd: 400,
      members: [
        { userId: "a", joinedAt: weekStart },
        { userId: "c", joinedAt },
      ],
      weekStart,
      now: laterSave,
      previousAllotments: new Map([
        ["a", 50],
        ["c", 25],
      ]),
      spentByUser: new Map([
        ["a", 10],
        ["c", 5],
      ]),
      rebaseOnMonthlyCap: true,
    });
    const fullShare = fullWeekShareUsd(400, 2);
    // Must keep the join-time half-week slice, not shrink to laterSave's remainder.
    expect(allotments.get("c")).toBeCloseTo(fullShare * midWeekJoinFraction(joinedAt, weekStart), 5);
    expect(allotments.get("c")).toBeGreaterThan(fullShare * weekFractionRemaining(laterSave, weekStart));
    expect(allotments.get("a")).toBeCloseTo(fullShare, 5);
  });

  it("starts the spend window at join time for mid-week members", () => {
    const weekStart = new Date("2026-11-02T05:00:00.000Z");
    const joinedAt = new Date("2026-11-05T17:00:00.000Z");
    expect(sharedKeySpendWindowStart(weekStart, weekStart).toISOString()).toBe(
      weekStart.toISOString(),
    );
    expect(sharedKeySpendWindowStart(weekStart, joinedAt).toISOString()).toBe(
      joinedAt.toISOString(),
    );
  });

  it("ends the week at the next America/New_York Monday, not a fixed 7*24h", () => {
    // Fall-back week: Monday starts in EDT and the next Monday is EST (+1h in UTC).
    const weekStart = sharedKeyWeekStart(new Date("2026-10-28T12:00:00.000Z"));
    expect(weekStart.toISOString()).toBe("2026-10-26T04:00:00.000Z");
    expect(sharedKeyWeekEnd(weekStart).toISOString()).toBe("2026-11-02T05:00:00.000Z");
    expect(new Date(weekStart.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString()).toBe(
      "2026-11-02T04:00:00.000Z",
    );
  });

  it("clamps percent used to 0..100", () => {
    expect(sharedKeyBudgetPercentUsed(0, 25)).toBe(0);
    expect(sharedKeyBudgetPercentUsed(12.5, 25)).toBe(50);
    expect(sharedKeyBudgetPercentUsed(30, 25)).toBe(100);
    expect(sharedKeyBudgetPercentUsed(1, 0)).toBe(100);
  });

  it("formats the America/New_York reset label for the account menu", () => {
    // Monday 00:00 America/New_York on 2026-11-09 is 05:00 UTC.
    expect(formatSharedKeyBudgetResetAt("2026-11-09T05:00:00.000Z", "en-US")).toBe("Mon 12:00 AM");
    expect(parseSharedKeyMonthlyBudgetInput(50)).toBe(50);
    expect(parseSharedKeyMonthlyBudgetInput(0)).toBeNull();
    expect(parseSharedKeyMonthlyBudgetInput(2_000_000)).toBeNull();
  });
});
