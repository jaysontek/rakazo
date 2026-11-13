import { describe, expect, it } from "vitest";
import {
  effectiveSharedKeySpendUsd,
  formatSharedKeyBudgetResetAt,
  fullWeekShareUsd,
  midWeekJoinFraction,
  parseSharedKeyMonthlyBudgetInput,
  redivideWeeklyAllotments,
  SHARED_KEY_BUDGET_TIMEZONE,
  sharedKeyBudgetPercentUsed,
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

  it("gives a mid-week new user a proportional slice funded from headroom only", () => {
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
    // Headroom: (25-10)+(25-5)=35; joiner slice = min(fullShare×frac, 35/3).
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
    const cSlice = Math.min(35 / 3, newCap);
    expect(allotments.get("c")!).toBeLessThan(fullShare);
    expect(allotments.get("c")!).toBeCloseTo(cSlice, 5);
    // Continuing members are never raised above their prior allotment.
    expect(allotments.get("a")!).toBeLessThanOrEqual(25);
    expect(allotments.get("b")!).toBeLessThanOrEqual(25);
    expect(allotments.get("a")!).toBeCloseTo(25 - (cSlice * 15) / 35, 5);
    expect(allotments.get("b")!).toBeCloseTo(25 - (cSlice * 20) / 35, 5);
  });

  it("never raises continuing members when a user is removed", () => {
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
    // Freed headroom from c sits unused until a joiner arrives; a and b stay put.
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
    expect(allotments.get("a")!).toBeCloseTo(25, 5);
    expect(allotments.get("b")!).toBeCloseTo(25, 5);
    expect(allotments.has("c")).toBe(false);
  });

  it("never raises continuing members when only reserved changes the headroom picture", () => {
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
    // No joiners → prior allotments stand; reserved stays committed inside them.
    expect(allotments.get("a")!).toBeCloseTo(50, 5);
    expect(allotments.get("b")!).toBeCloseTo(50, 5);
  });

  it("re-bases on free = newPool − committed, never inventing budget above the pool", () => {
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
    // Pool $50; committed $12.5; free $37.5 split among members still under their want.
    const fullShare = fullWeekShareUsd(200, 3);
    const wantA = fullShare;
    const wantB = fullShare;
    const wantC = fullShare * midWeekJoinFraction(now, weekStart);
    const free = 50 - 12.5;
    // a spent 12.5 < want ≈16.67 so still a receiver.
    const wantSum = wantA + wantB + wantC;
    expect(allotments.get("a")).toBeCloseTo(12.5 + (free * wantA) / wantSum, 5);
    expect(allotments.get("b")).toBeCloseTo((free * wantB) / wantSum, 5);
    expect(allotments.get("c")).toBeCloseTo((free * wantC) / wantSum, 5);
    const committed =
      (allotments.get("a") ?? 0) + (allotments.get("b") ?? 0) + (allotments.get("c") ?? 0);
    expect(committed).toBeCloseTo(50, 5);
  });

  it("freezes mid-week join want-share at join time across later cap re-bases", () => {
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
    const wantA = fullShare;
    const wantC = fullShare * midWeekJoinFraction(joinedAt, weekStart);
    const free = Math.max(0, 100 - 15);
    // Neither is overspent vs want; free splits by join-time wants.
    expect(allotments.get("c")).toBeCloseTo(5 + (free * wantC) / (wantA + wantC), 5);
    expect(wantC).toBeGreaterThan(fullShare * weekFractionRemaining(laterSave, weekStart));
    expect(allotments.get("a")).toBeCloseTo(10 + (free * wantA) / (wantA + wantC), 5);
  });

  it("never raises an overspent member on rebase", () => {
    const weekStart = new Date("2026-11-02T05:00:00.000Z");
    const now = new Date("2026-11-05T17:00:00.000Z");
    // Same $100 cap re-save: A spent past new share, B under.
    const allotments = redivideWeeklyAllotments({
      monthlyCapUsd: 100,
      members: [
        { userId: "a", joinedAt: weekStart },
        { userId: "b", joinedAt: weekStart },
      ],
      weekStart,
      now,
      previousAllotments: new Map([
        ["a", 12.5],
        ["b", 12.5],
      ]),
      spentByUser: new Map([
        ["a", 12.5],
        ["b", 2],
      ]),
      rebaseOnMonthlyCap: true,
    });
    const fullShare = fullWeekShareUsd(100, 2); // 12.5
    const free = Math.max(0, 25 - 14.5);
    expect(allotments.get("a")).toBeCloseTo(12.5, 5);
    expect(allotments.get("a")!).toBeLessThanOrEqual(12.5 + 1e-9);
    expect(allotments.get("b")).toBeCloseTo(2 + free, 5);
    expect(fullShare).toBe(12.5);
  });

  it("never raises a drained continuing member when throwaway accounts enroll", () => {
    const weekStart = new Date("2026-11-02T05:00:00.000Z");
    const mid = new Date("2026-11-05T17:00:00.000Z");
    let previous = new Map([
      ["a", 50],
      ["b", 50],
    ]);
    const spent = new Map([
      ["a", 50],
      ["b", 0],
    ]);
    const members = [
      { userId: "a", joinedAt: weekStart },
      { userId: "b", joinedAt: weekStart },
    ];
    for (let i = 0; i < 5; i += 1) {
      const id = `t${i}`;
      members.push({ userId: id, joinedAt: mid });
      const allotments = redivideWeeklyAllotments({
        monthlyCapUsd: 100,
        members: [...members],
        weekStart,
        now: mid,
        previousAllotments: previous,
        spentByUser: spent,
      });
      expect(allotments.get("a")!).toBeLessThanOrEqual(50);
      const committed = [...allotments.values()].reduce((sum, value) => sum + value, 0);
      expect(committed).toBeLessThanOrEqual(100 + 1e-9);
      previous = new Map(allotments);
    }
    expect(previous.get("a")).toBeCloseTo(50, 5);
  });

  it("clamps rebase free at zero so spent above the new pool stays committed only", () => {
    const weekStart = new Date("2026-11-02T05:00:00.000Z");
    const now = new Date("2026-11-05T17:00:00.000Z");
    const allotments = redivideWeeklyAllotments({
      monthlyCapUsd: 100, // pool $25
      members: [
        { userId: "a", joinedAt: weekStart },
        { userId: "b", joinedAt: weekStart },
      ],
      weekStart,
      now,
      previousAllotments: new Map([
        ["a", 50],
        ["b", 50],
        ["gone", 10],
      ]),
      spentByUser: new Map([
        ["a", 20],
        ["b", 5],
        ["gone", 5],
      ]),
      rebaseOnMonthlyCap: true,
    });
    // committed = 20+5+5 = 30 > pool 25 → free 0; each member gets eff+res only.
    expect(allotments.get("a")).toBeCloseTo(20, 5);
    expect(allotments.get("b")).toBeCloseTo(5, 5);
    const committed = (allotments.get("a") ?? 0) + (allotments.get("b") ?? 0);
    expect(committed).toBeLessThanOrEqual(30 + 1e-9);
  });

  it("charges effective spend as Monday total minus the pre-join baseline", () => {
    expect(effectiveSharedKeySpendUsd(40, 40)).toBe(0);
    expect(effectiveSharedKeySpendUsd(40, 10)).toBe(30);
    expect(effectiveSharedKeySpendUsd(5, 10)).toBe(0);
    expect(effectiveSharedKeySpendUsd(0, 0)).toBe(0);
  });

  it("uses preJoin baselines when redistributing so mid-week prior spend is not charged", () => {
    const weekStart = new Date("2026-11-02T05:00:00.000Z");
    const mid = new Date("2026-11-05T17:00:00.000Z");
    const allotments = redivideWeeklyAllotments({
      monthlyCapUsd: 400,
      members: [
        { userId: "a", joinedAt: weekStart },
        { userId: "c", joinedAt: mid },
      ],
      weekStart,
      now: mid,
      previousAllotments: new Map([["a", 50]]),
      // Monday totals; c's $40 was before join.
      spentByUser: new Map([
        ["a", 10],
        ["c", 40],
      ]),
      preJoinSpendByUser: new Map([
        ["a", 0],
        ["c", 40],
      ]),
    });
    // Remaining from a: 50-10=40; c has no prior allotment → mid-week slice.
    // effective c = 0 so continuing a keeps 10 + evenRemaining.
    expect(allotments.get("c")!).toBeGreaterThan(0);
    expect(allotments.get("a")!).toBeGreaterThan(10);
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
