import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { SharedKeyPeriodKind, SharedKeyPeriodSchedule } from "./shared-key-budget.js";
import {
  clampSharedKeyOverrideRaises,
  DEFAULT_SHARED_KEY_PERIOD_SCHEDULE,
  effectiveSharedKeyPeriodStart,
  effectiveSharedKeySpendUsd,
  formatSharedKeyBudgetResetAt,
  fullWeekShareUsd,
  maxSharedKeyOverrideAllotmentUsd,
  midWeekJoinFraction,
  parseSharedKeyMonthlyBudgetInput,
  parseSharedKeyTimezone,
  projectSharedKeyBudgetDisplay,
  redivideWeeklyAllotments,
  resolveSharedKeyPeriodSchedule,
  SHARED_KEY_BUDGET_TIMEZONE,
  sharedKeyBudgetPercentUsed,
  sharedKeyPeriodEnd,
  sharedKeyPeriodPoolUsd,
  sharedKeyPeriodStart,
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
    // Negative pre-join baseline (credit adjustment before join) must not clamp to 0.
    // monday=15 (post usage 20 + pre adj −10), baseline=−10 → effective 25 = post-only.
    expect(effectiveSharedKeySpendUsd(15, -10)).toBe(25);
    expect(effectiveSharedKeySpendUsd(0, -10)).toBe(10);
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

  it("projects display percent including reserved and blocked headroom", () => {
    // Real-shaped case: ~85% spend-only, but headroom below worst-case → blocked; meters show 100%.
    const blocked = projectSharedKeyBudgetDisplay({
      spentUsd: 0.9565,
      reservedUsd: 0,
      weeklyCapUsd: 1.1215,
      hardStopEnabled: true,
      maxCallCostUsd: 0.2,
    });
    expect(blocked.status).toBe("blocked");
    expect(blocked.hardStopped).toBe(false);
    expect(blocked.usedPercent).toBe(100);
    expect(blocked.spentPercent).toBeCloseTo((0.9565 / 1.1215) * 100, 5);
    expect(blocked.remainingUsd).toBeCloseTo(0.165, 3);

    const held = projectSharedKeyBudgetDisplay({
      spentUsd: 0.5,
      reservedUsd: 0.25,
      weeklyCapUsd: 1,
      hardStopEnabled: true,
    });
    expect(held.usedPercent).toBe(75);
    expect(held.reservedPercent).toBe(25);
    expect(held.spentPercent).toBe(50);
    expect(held.status).toBe("ok");

    const hardStopped = projectSharedKeyBudgetDisplay({
      spentUsd: 1,
      reservedUsd: 0,
      weeklyCapUsd: 1,
      hardStopEnabled: true,
    });
    expect(hardStopped.hardStopped).toBe(true);
    expect(hardStopped.status).toBe("blocked");
    expect(hardStopped.usedPercent).toBe(100);
  });

  it("projects a $0 allotment after transfer from a $0-spend sender as exhausted", () => {
    // Transfer sets sender allotment to spent+reserved; $0 spend → weeklyCapUsd 0.
    const drained = projectSharedKeyBudgetDisplay({
      spentUsd: 0,
      reservedUsd: 0,
      weeklyCapUsd: 0,
      hardStopEnabled: true,
    });
    expect(drained.status).toBe("blocked");
    expect(drained.hardStopped).toBe(true);
    expect(drained.usedPercent).toBe(100);
    expect(drained.spentPercent).toBe(100);
    expect(drained.percentUsed).toBe(100);
    expect(drained.remainingUsd).toBe(0);
  });

  it("keeps 0% for feature-off and non-member projections", () => {
    // Callers pass hardStopEnabled=false when the feature is off or the user is not a member.
    expect(sharedKeyBudgetPercentUsed(0, 0)).toBe(0);
    const featureOff = projectSharedKeyBudgetDisplay({
      spentUsd: 0,
      reservedUsd: 0,
      weeklyCapUsd: 0,
      hardStopEnabled: false,
    });
    expect(featureOff.status).toBe("ok");
    expect(featureOff.hardStopped).toBe(false);
    expect(featureOff.usedPercent).toBe(0);
    expect(featureOff.percentUsed).toBe(0);
    expect(featureOff.remainingUsd).toBe(0);
  });

  it("formats the America/New_York reset label for the account menu", () => {
    // Monday 00:00 America/New_York on 2026-11-09 is 05:00 UTC.
    expect(formatSharedKeyBudgetResetAt("2026-11-09T05:00:00.000Z", "en-US")).toBe("Mon 12:00 AM");
    expect(parseSharedKeyMonthlyBudgetInput(50)).toBe(50);
    expect(parseSharedKeyMonthlyBudgetInput(0)).toBeNull();
    expect(parseSharedKeyMonthlyBudgetInput(2_000_000)).toBeNull();
  });
});

describe("shared-key period schedule math", () => {
  it("resolves null/partial input to today's Monday 00:00 America/New_York default", () => {
    expect(resolveSharedKeyPeriodSchedule(null)).toEqual(DEFAULT_SHARED_KEY_PERIOD_SCHEDULE);
    expect(resolveSharedKeyPeriodSchedule(undefined)).toEqual(DEFAULT_SHARED_KEY_PERIOD_SCHEDULE);
    expect(resolveSharedKeyPeriodSchedule({})).toEqual(DEFAULT_SHARED_KEY_PERIOD_SCHEDULE);
    expect(DEFAULT_SHARED_KEY_PERIOD_SCHEDULE).toEqual({
      period: "week",
      resetDow: 1,
      resetDom: 1,
      resetMinutes: 0,
      timezone: SHARED_KEY_BUDGET_TIMEZONE,
    });
  });

  it("matches existing Monday 00:00 America/New_York week boundaries via default schedule", () => {
    const midweek = new Date("2026-11-04T18:00:00.000Z");
    expect(sharedKeyPeriodStart(DEFAULT_SHARED_KEY_PERIOD_SCHEDULE, midweek).toISOString()).toBe(
      sharedKeyWeekStart(midweek).toISOString(),
    );
    expect(sharedKeyPeriodStart(DEFAULT_SHARED_KEY_PERIOD_SCHEDULE, midweek).toISOString()).toBe(
      "2026-11-02T05:00:00.000Z",
    );
    expect(
      sharedKeyPeriodEnd(
        DEFAULT_SHARED_KEY_PERIOD_SCHEDULE,
        sharedKeyPeriodStart(DEFAULT_SHARED_KEY_PERIOD_SCHEDULE, midweek),
      ).toISOString(),
    ).toBe("2026-11-09T05:00:00.000Z");

    const before = new Date("2026-11-09T04:59:59.000Z");
    const after = new Date("2026-11-09T05:00:00.000Z");
    expect(sharedKeyPeriodStart(DEFAULT_SHARED_KEY_PERIOD_SCHEDULE, before).toISOString()).toBe(
      "2026-11-02T05:00:00.000Z",
    );
    expect(sharedKeyPeriodStart(DEFAULT_SHARED_KEY_PERIOD_SCHEDULE, after).toISOString()).toBe(
      "2026-11-09T05:00:00.000Z",
    );
  });

  it("supports a custom Tuesday 03:00 Europe/London week", () => {
    const schedule: SharedKeyPeriodSchedule = {
      period: "week",
      resetDow: 2,
      resetDom: 1,
      resetMinutes: 3 * 60,
      timezone: "Europe/London",
    };
    // Tuesday 2026-11-03 03:00 GMT = 03:00Z; Monday evening is still prior period.
    const mondayEvening = new Date("2026-11-02T22:00:00.000Z");
    const tuesdayAfter = new Date("2026-11-03T03:00:00.000Z");
    expect(sharedKeyPeriodStart(schedule, mondayEvening).toISOString()).toBe(
      "2026-10-27T03:00:00.000Z",
    );
    expect(sharedKeyPeriodStart(schedule, tuesdayAfter).toISOString()).toBe(
      "2026-11-03T03:00:00.000Z",
    );
    expect(
      sharedKeyPeriodEnd(schedule, sharedKeyPeriodStart(schedule, tuesdayAfter)).toISOString(),
    ).toBe("2026-11-10T03:00:00.000Z");
    expect(formatSharedKeyBudgetResetAt("2026-11-03T03:00:00.000Z", "en-US", "Europe/London")).toBe(
      "Tue 3:00 AM",
    );
  });

  it("keeps week length DST-safe across America/New_York spring-forward", () => {
    // Spring forward 2026-03-08 02:00 → 03:00; week containing that Monday.
    const schedule = DEFAULT_SHARED_KEY_PERIOD_SCHEDULE;
    const mid = new Date("2026-03-11T15:00:00.000Z");
    const start = sharedKeyPeriodStart(schedule, mid);
    expect(start.toISOString()).toBe("2026-03-09T04:00:00.000Z"); // EDT
    const end = sharedKeyPeriodEnd(schedule, start);
    expect(end.toISOString()).toBe("2026-03-16T04:00:00.000Z");
    // Fixed 7*24h from the prior EST Monday would land an hour early.
    const prior = sharedKeyPeriodStart(schedule, new Date("2026-03-04T15:00:00.000Z"));
    expect(prior.toISOString()).toBe("2026-03-02T05:00:00.000Z"); // EST
    expect(sharedKeyPeriodEnd(schedule, prior).toISOString()).toBe(start.toISOString());
    expect(new Date(prior.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString()).not.toBe(
      start.toISOString(),
    );
  });

  it("keeps week length DST-safe across America/New_York fall-back", () => {
    const weekStart = sharedKeyPeriodStart(
      DEFAULT_SHARED_KEY_PERIOD_SCHEDULE,
      new Date("2026-10-28T12:00:00.000Z"),
    );
    expect(weekStart.toISOString()).toBe("2026-10-26T04:00:00.000Z");
    expect(sharedKeyPeriodEnd(DEFAULT_SHARED_KEY_PERIOD_SCHEDULE, weekStart).toISOString()).toBe(
      "2026-11-02T05:00:00.000Z",
    );
  });

  it("supports month periods with Dom=28 including February and March edges", () => {
    const schedule: SharedKeyPeriodSchedule = {
      period: "month",
      resetDow: 1,
      resetDom: 28,
      resetMinutes: 0,
      timezone: "America/New_York",
    };
    // After Feb 28 00:00 ET → period starts Feb 28; before that → Jan 28.
    const feb27 = new Date("2026-02-27T12:00:00.000Z");
    const feb28 = new Date("2026-02-28T05:00:00.000Z"); // 00:00 ET
    const mar1 = new Date("2026-03-01T12:00:00.000Z");
    const mar28 = new Date("2026-03-28T04:00:00.000Z"); // 00:00 EDT

    expect(sharedKeyPeriodStart(schedule, feb27).toISOString()).toBe("2026-01-28T05:00:00.000Z");
    expect(sharedKeyPeriodStart(schedule, feb28).toISOString()).toBe("2026-02-28T05:00:00.000Z");
    expect(sharedKeyPeriodStart(schedule, mar1).toISOString()).toBe("2026-02-28T05:00:00.000Z");
    expect(sharedKeyPeriodStart(schedule, mar28).toISOString()).toBe("2026-03-28T04:00:00.000Z");

    const febStart = sharedKeyPeriodStart(schedule, feb28);
    expect(sharedKeyPeriodEnd(schedule, febStart).toISOString()).toBe("2026-03-28T04:00:00.000Z");
  });

  it("handles month periods across America/New_York DST", () => {
    const schedule: SharedKeyPeriodSchedule = {
      period: "month",
      resetDow: 1,
      resetDom: 1,
      resetMinutes: 0,
      timezone: "America/New_York",
    };
    // March 1 2026 is still EST; April 1 is EDT.
    const marMid = new Date("2026-03-15T12:00:00.000Z");
    const start = sharedKeyPeriodStart(schedule, marMid);
    expect(start.toISOString()).toBe("2026-03-01T05:00:00.000Z");
    expect(sharedKeyPeriodEnd(schedule, start).toISOString()).toBe("2026-04-01T04:00:00.000Z");
  });

  it("keeps activePeriodStart until the next schedule boundary", () => {
    const oldSchedule = DEFAULT_SHARED_KEY_PERIOD_SCHEDULE;
    const active = sharedKeyPeriodStart(oldSchedule, new Date("2026-11-03T18:00:00.000Z"));
    expect(active.toISOString()).toBe("2026-11-02T05:00:00.000Z");

    const newSchedule: SharedKeyPeriodSchedule = {
      period: "week",
      resetDow: 3, // Wednesday
      resetDom: 1,
      resetMinutes: 0,
      timezone: SHARED_KEY_BUDGET_TIMEZONE,
    };
    // From a Monday active start, +8d then recompute lands on the following Wednesday.
    expect(sharedKeyPeriodEnd(newSchedule, active).toISOString()).toBe("2026-11-04T05:00:00.000Z");

    const beforeBoundary = new Date("2026-11-04T04:59:59.000Z");
    expect(
      effectiveSharedKeyPeriodStart({
        schedule: newSchedule,
        activePeriodStart: active,
        now: beforeBoundary,
      }).toISOString(),
    ).toBe(active.toISOString());

    const afterBoundary = new Date("2026-11-04T05:00:00.000Z");
    expect(
      effectiveSharedKeyPeriodStart({
        schedule: newSchedule,
        activePeriodStart: active,
        now: afterBoundary,
      }).toISOString(),
    ).toBe(sharedKeyPeriodStart(newSchedule, afterBoundary).toISOString());

    expect(
      effectiveSharedKeyPeriodStart({
        schedule: newSchedule,
        activePeriodStart: null,
        now: beforeBoundary,
      }).toISOString(),
    ).toBe(sharedKeyPeriodStart(newSchedule, beforeBoundary).toISOString());
  });

  it("parseSharedKeyTimezone rejects garbage and accepts known zones", () => {
    expect(parseSharedKeyTimezone(null)).toBeNull();
    expect(parseSharedKeyTimezone("")).toBeNull();
    expect(parseSharedKeyTimezone("   ")).toBeNull();
    expect(parseSharedKeyTimezone("Not/A_Zone")).toBeNull();
    expect(parseSharedKeyTimezone("America/New_York")).toBe("America/New_York");
    expect(parseSharedKeyTimezone("UTC")).toBe("UTC");
    expect(parseSharedKeyTimezone("  UTC  ")).toBe("UTC");
  });

  it("null settings equal today's Monday 00:00 America/New_York weekly behaviour exactly", () => {
    const midweek = new Date("2026-11-04T18:00:00.000Z");
    const fromNull = resolveSharedKeyPeriodSchedule(null);
    expect(fromNull).toEqual(DEFAULT_SHARED_KEY_PERIOD_SCHEDULE);
    expect(sharedKeyPeriodStart(fromNull, midweek).toISOString()).toBe(
      sharedKeyWeekStart(midweek).toISOString(),
    );
    expect(
      sharedKeyPeriodEnd(fromNull, sharedKeyPeriodStart(fromNull, midweek)).toISOString(),
    ).toBe(sharedKeyWeekEnd(sharedKeyWeekStart(midweek)).toISOString());
  });

  it("month periods use the full monthly pool and clamp resetDom 31 to month length", () => {
    const schedule: SharedKeyPeriodSchedule = {
      period: "month",
      resetDow: 1,
      resetDom: 31,
      resetMinutes: 0,
      timezone: "America/New_York",
    };
    // February 2026 has 28 days → Dom 31 clamps to 28.
    const feb15 = new Date("2026-02-15T12:00:00.000Z");
    const febStart = sharedKeyPeriodStart(schedule, feb15);
    expect(febStart.toISOString()).toBe("2026-01-31T05:00:00.000Z");
    const febEnd = sharedKeyPeriodEnd(schedule, febStart);
    expect(febEnd.toISOString()).toBe("2026-02-28T05:00:00.000Z");

    // March has 31 days.
    const mar15 = new Date("2026-03-15T12:00:00.000Z");
    expect(sharedKeyPeriodStart(schedule, mar15).toISOString()).toBe("2026-02-28T05:00:00.000Z");
    expect(sharedKeyPeriodEnd(schedule, sharedKeyPeriodStart(schedule, mar15)).toISOString()).toBe(
      "2026-03-31T04:00:00.000Z",
    );

    const periodStart = new Date("2026-03-01T05:00:00.000Z");
    const periodEnd = new Date("2026-04-01T04:00:00.000Z");
    const allotments = redivideWeeklyAllotments({
      monthlyCapUsd: 400,
      members: [
        { userId: "a", joinedAt: periodStart },
        { userId: "b", joinedAt: periodStart },
      ],
      weekStart: periodStart,
      now: periodStart,
      previousAllotments: new Map(),
      spentByUser: new Map(),
      period: "month",
      periodEnd,
    });
    expect(allotments.get("a")).toBe(200);
    expect(allotments.get("b")).toBe(200);
    expect([...allotments.values()].reduce((sum, v) => sum + v, 0)).toBe(400);
  });

  it("subtracts overrides from the pool before splitting; sum never exceeds the cap", () => {
    const weekStart = new Date("2026-11-02T05:00:00.000Z");
    const allotments = redivideWeeklyAllotments({
      monthlyCapUsd: 400, // week pool 100
      members: [
        { userId: "a", joinedAt: weekStart },
        { userId: "b", joinedAt: weekStart },
        { userId: "c", joinedAt: weekStart },
      ],
      weekStart,
      now: weekStart,
      previousAllotments: new Map(),
      spentByUser: new Map(),
      overrides: new Map([
        ["a", 40],
        ["b", 30],
      ]),
    });
    expect(allotments.get("a")).toBe(40);
    expect(allotments.get("b")).toBe(30);
    expect(allotments.get("c")).toBe(30); // remainder 30
    const sum = [...allotments.values()].reduce((acc, v) => acc + v, 0);
    expect(sum).toBeLessThanOrEqual(100);

    const over = redivideWeeklyAllotments({
      monthlyCapUsd: 400,
      members: [
        { userId: "a", joinedAt: weekStart },
        { userId: "b", joinedAt: weekStart },
      ],
      weekStart,
      now: weekStart,
      previousAllotments: new Map(),
      spentByUser: new Map(),
      overrides: new Map([
        ["a", 80],
        ["b", 80],
      ]),
    });
    const overSum = [...over.values()].reduce((acc, v) => acc + v, 0);
    expect(overSum).toBeLessThanOrEqual(100);
  });

  it("counts an overspent override as max(override, spent) so the gap is not handed to peers", () => {
    // Pool $100. X spent $50 with override $10. Without the floor take, a and b
    // would each get $45 and total spendable would be $140.
    const weekStart = new Date("2026-11-02T05:00:00.000Z");
    const mid = new Date("2026-11-05T12:00:00.000Z");
    const previous = new Map([
      ["x", 50],
      ["a", 25],
      ["b", 25],
    ]);
    const spent = new Map([
      ["x", 50],
      ["a", 0],
      ["b", 0],
    ]);
    const allotments = redivideWeeklyAllotments({
      monthlyCapUsd: 400, // week pool 100
      members: [
        { userId: "x", joinedAt: weekStart },
        { userId: "a", joinedAt: weekStart },
        { userId: "b", joinedAt: weekStart },
      ],
      weekStart,
      now: mid,
      previousAllotments: previous,
      spentByUser: spent,
      overrides: new Map([["x", 10]]),
      rebaseOnMonthlyCap: true,
    });
    // Override request $10 but spent $50 → allotment stays at the floor.
    expect(allotments.get("x")).toBe(50);
    // Remainder pool is 100 − max(10, 50) = 50 → $25 each, not $45.
    expect(allotments.get("a")).toBeCloseTo(25, 5);
    expect(allotments.get("b")).toBeCloseTo(25, 5);
    const spendable = [...allotments.entries()].reduce((sum, [userId, allotment]) => {
      return sum + Math.max(allotment, spent.get(userId) ?? 0);
    }, 0);
    expect(spendable).toBeLessThanOrEqual(100 + 1e-9);
  });

  it("keeps total spendable (max(allotment, spent)) ≤ pool for override/spend mixes", () => {
    const weekStart = new Date("2026-11-02T05:00:00.000Z");
    const mid = new Date("2026-11-05T12:00:00.000Z");
    const pool = 100;
    const monthlyCapUsd = 400;
    const ids = ["a", "b", "c", "d"] as const;
    const mixes: Array<{
      overrides: Map<string, number>;
      spent: Map<string, number>;
      previous: Map<string, number>;
      rebase: boolean;
    }> = [
      {
        overrides: new Map([["a", 10]]),
        spent: new Map([
          ["a", 50],
          ["b", 5],
          ["c", 0],
          ["d", 0],
        ]),
        previous: new Map(ids.map((id) => [id, 25])),
        rebase: true,
      },
      {
        overrides: new Map([
          ["a", 40],
          ["b", 5],
        ]),
        spent: new Map([
          ["a", 10],
          ["b", 20],
          ["c", 15],
          ["d", 0],
        ]),
        previous: new Map(ids.map((id) => [id, 25])),
        rebase: true,
      },
      {
        // Mid-period: no member already over their prior allotment, and sum(spent) ≤ pool
        // so unused prior slices cannot push spendable past the cap.
        overrides: new Map([["c", 0]]),
        spent: new Map([
          ["a", 20],
          ["b", 20],
          ["c", 25],
          ["d", 0],
        ]),
        previous: new Map(ids.map((id) => [id, 25])),
        rebase: false,
      },
      {
        overrides: new Map([
          ["a", 60],
          ["b", 30],
        ]),
        spent: new Map([
          ["a", 70],
          ["b", 5],
          ["c", 0],
          ["d", 0],
        ]),
        previous: new Map(ids.map((id) => [id, 25])),
        rebase: true,
      },
    ];
    for (const mix of mixes) {
      const allotments = redivideWeeklyAllotments({
        monthlyCapUsd,
        members: ids.map((userId) => ({ userId, joinedAt: weekStart })),
        weekStart,
        now: mid,
        previousAllotments: mix.previous,
        spentByUser: mix.spent,
        overrides: mix.overrides,
        rebaseOnMonthlyCap: mix.rebase,
      });
      const spendable = [...allotments.entries()].reduce((sum, [userId, allotment]) => {
        return sum + Math.max(allotment, mix.spent.get(userId) ?? 0);
      }, 0);
      expect(spendable).toBeLessThanOrEqual(pool + 1e-6);
    }
  });

  it("does not raise continuing peers when an override is lowered mid-period", () => {
    const weekStart = new Date("2026-11-02T05:00:00.000Z");
    const mid = new Date("2026-11-05T12:00:00.000Z");
    const previous = new Map([
      ["x", 50],
      ["a", 25],
      ["b", 25],
    ]);
    const allotments = redivideWeeklyAllotments({
      monthlyCapUsd: 400,
      members: [
        { userId: "x", joinedAt: weekStart },
        { userId: "a", joinedAt: weekStart },
        { userId: "b", joinedAt: weekStart },
      ],
      weekStart,
      now: mid,
      previousAllotments: previous,
      spentByUser: new Map([
        ["x", 10],
        ["a", 5],
        ["b", 0],
      ]),
      overrides: new Map([["x", 20]]),
      rebaseOnMonthlyCap: false,
    });
    expect(allotments.get("x")).toBe(20);
    expect(allotments.get("a")!).toBeLessThanOrEqual(25 + 1e-9);
    expect(allotments.get("b")!).toBeLessThanOrEqual(25 + 1e-9);
  });

  it("clamps mid-period override raises to free headroom so sum stays ≤ pool", () => {
    const weekStart = new Date("2026-11-02T05:00:00.000Z");
    const mid = new Date("2026-11-05T12:00:00.000Z");
    const previous = new Map([
      ["x", 33.33],
      ["a", 33.33],
      ["b", 33.34],
    ]);
    for (const raise of [60, 90]) {
      const allotments = redivideWeeklyAllotments({
        monthlyCapUsd: 400, // week pool 100
        members: [
          { userId: "x", joinedAt: weekStart },
          { userId: "a", joinedAt: weekStart },
          { userId: "b", joinedAt: weekStart },
        ],
        weekStart,
        now: mid,
        previousAllotments: previous,
        spentByUser: new Map(),
        overrides: new Map([["x", raise]]),
        rebaseOnMonthlyCap: false,
      });
      const sum = [...allotments.values()].reduce((acc, v) => acc + v, 0);
      expect(sum).toBeLessThanOrEqual(100 + 1e-9);
      expect(allotments.get("a")).toBeCloseTo(33.33, 5);
      expect(allotments.get("b")).toBeCloseTo(33.34, 5);
      expect(allotments.get("x")!).toBeLessThanOrEqual(33.33 + 1e-9);
    }
  });

  it("clamps raise after remove when removed spent still charges the pool (repro a)", () => {
    const weekStart = new Date("2026-11-02T05:00:00.000Z");
    const mid = new Date("2026-11-05T12:00:00.000Z");
    const previous = new Map([
      ["x", 33.33],
      ["a", 33.33],
      ["r", 33.34],
    ]);
    const spent = new Map([["r", 30]]);
    const allotments = redivideWeeklyAllotments({
      monthlyCapUsd: 400,
      members: [
        { userId: "x", joinedAt: weekStart },
        { userId: "a", joinedAt: weekStart },
      ],
      weekStart,
      now: mid,
      previousAllotments: previous,
      spentByUser: spent,
      overrides: new Map([["x", 66]]),
      rebaseOnMonthlyCap: false,
    });
    expect(allotments.get("x")!).toBeLessThan(66);
    const spendable =
      Math.max(allotments.get("x") ?? 0, 0) + Math.max(allotments.get("a") ?? 0, 0) + 30;
    expect(spendable).toBeLessThanOrEqual(100 + 1e-9);
    const max = maxSharedKeyOverrideAllotmentUsd({
      periodPoolUsd: 100,
      userId: "x",
      rows: [
        { userId: "x", allotmentUsd: 33.33, floorUsd: 0, onRoster: true },
        { userId: "a", allotmentUsd: 33.33, floorUsd: 0, onRoster: true },
        { userId: "r", allotmentUsd: 30, floorUsd: 30, onRoster: false },
      ],
    });
    expect(66).toBeGreaterThan(max + 1e-9);
  });

  it("clamps raise after remove+join so joiner-funded headroom is not double-counted (repro b)", () => {
    const weekStart = new Date("2026-11-02T05:00:00.000Z");
    const mid = new Date("2026-11-05T12:00:00.000Z");
    const previous = new Map([
      ["x", 33.33],
      ["a", 33.33],
      ["r", 33.34],
    ]);
    const allotments = redivideWeeklyAllotments({
      monthlyCapUsd: 400,
      members: [
        { userId: "x", joinedAt: weekStart },
        { userId: "a", joinedAt: weekStart },
        { userId: "j", joinedAt: mid },
      ],
      weekStart,
      now: mid,
      previousAllotments: previous,
      spentByUser: new Map(),
      overrides: new Map([["x", 66]]),
      rebaseOnMonthlyCap: false,
    });
    const sum = [...allotments.values()].reduce((acc, v) => acc + v, 0);
    expect(sum).toBeLessThanOrEqual(100 + 1e-9);
    expect(allotments.get("x")!).toBeLessThan(66);
  });

  it("clamps raise after join when the joiner already consumed free headroom", () => {
    const weekStart = new Date("2026-11-02T05:00:00.000Z");
    const mid = new Date("2026-11-05T12:00:00.000Z");
    const previous = new Map([
      ["x", 40],
      ["a", 40],
      ["b", 20],
    ]);
    const allotments = redivideWeeklyAllotments({
      monthlyCapUsd: 400,
      members: [
        { userId: "x", joinedAt: weekStart },
        { userId: "a", joinedAt: weekStart },
        { userId: "b", joinedAt: weekStart },
        { userId: "j", joinedAt: mid },
      ],
      weekStart,
      now: mid,
      previousAllotments: previous,
      spentByUser: new Map(),
      overrides: new Map([["x", 70]]),
      rebaseOnMonthlyCap: false,
    });
    const sum = [...allotments.values()].reduce((acc, v) => acc + v, 0);
    expect(sum).toBeLessThanOrEqual(100 + 1e-9);
  });

  it("clamps raise after remove when removed reserved still charges the pool", () => {
    const weekStart = new Date("2026-11-02T05:00:00.000Z");
    const mid = new Date("2026-11-05T12:00:00.000Z");
    const previous = new Map([
      ["x", 33.33],
      ["a", 33.33],
      ["r", 33.34],
    ]);
    const allotments = redivideWeeklyAllotments({
      monthlyCapUsd: 400,
      members: [
        { userId: "x", joinedAt: weekStart },
        { userId: "a", joinedAt: weekStart },
      ],
      weekStart,
      now: mid,
      previousAllotments: previous,
      spentByUser: new Map(),
      reservedByUser: new Map([["r", 20]]),
      overrides: new Map([["x", 66]]),
      rebaseOnMonthlyCap: false,
    });
    const spendable =
      Math.max(allotments.get("x") ?? 0, 0) + Math.max(allotments.get("a") ?? 0, 0) + 20;
    expect(spendable).toBeLessThanOrEqual(100 + 1e-9);
  });

  it("rebase applies overrides in full but never cuts a member below spent+reserved", () => {
    const weekStart = new Date("2026-11-02T05:00:00.000Z");
    const mid = new Date("2026-11-05T12:00:00.000Z");
    const allotments = redivideWeeklyAllotments({
      monthlyCapUsd: 200, // week pool 50
      members: [
        { userId: "x", joinedAt: weekStart },
        { userId: "a", joinedAt: weekStart },
        { userId: "b", joinedAt: weekStart },
      ],
      weekStart,
      now: mid,
      previousAllotments: new Map([
        ["x", 40],
        ["a", 40],
        ["b", 20],
      ]),
      spentByUser: new Map([
        ["x", 25],
        ["a", 10],
        ["b", 5],
      ]),
      overrides: new Map([["x", 30]]),
      rebaseOnMonthlyCap: true,
    });
    expect(allotments.get("x")!).toBeGreaterThanOrEqual(25 - 1e-9);
    expect(allotments.get("a")!).toBeGreaterThanOrEqual(10 - 1e-9);
    expect(allotments.get("b")!).toBeGreaterThanOrEqual(5 - 1e-9);
    const spendable = [...allotments.entries()].reduce((sum, [userId, allotment]) => {
      const spent = userId === "x" ? 25 : userId === "a" ? 10 : 5;
      return sum + Math.max(allotment, spent);
    }, 0);
    expect(spendable).toBeLessThanOrEqual(50 + 1e-9);
  });

  it("scales overcommitted overrides against pool minus others' committed (N6)", () => {
    const weekStart = new Date("2026-11-02T05:00:00.000Z");
    const allotments = redivideWeeklyAllotments({
      monthlyCapUsd: 200, // week pool 50
      members: [
        { userId: "a", joinedAt: weekStart },
        { userId: "b", joinedAt: weekStart },
        { userId: "c", joinedAt: weekStart },
      ],
      weekStart,
      now: weekStart,
      previousAllotments: new Map(),
      spentByUser: new Map([["b", 20]]),
      overrides: new Map([
        ["a", 40],
        ["c", 20],
      ]),
    });
    expect(allotments.get("a")).toBeCloseTo(20, 5);
    expect(allotments.get("c")).toBeCloseTo(10, 5);
    expect(allotments.get("b")).toBeCloseTo(20, 5);
    const sum = [...allotments.values()].reduce((acc, v) => acc + v, 0);
    expect(sum).toBeLessThanOrEqual(50 + 1e-9);
    const spendable = [...allotments.entries()].reduce((acc, [userId, allotment]) => {
      const spent = userId === "b" ? 20 : 0;
      return acc + Math.max(allotment, spent);
    }, 0);
    expect(spendable).toBeLessThanOrEqual(50 + 1e-9);
  });

  it("proves the old roster-only headroom formula allows repro (a) while the fix rejects it", () => {
    const pool = 100;
    const rosterAllot = 33.33 + 33.33;
    const oldMax = 33.33 + Math.max(0, pool - rosterAllot);
    expect(oldMax).toBeGreaterThan(66);
    const newMax = maxSharedKeyOverrideAllotmentUsd({
      periodPoolUsd: pool,
      userId: "x",
      rows: [
        { userId: "x", allotmentUsd: 33.33, floorUsd: 0, onRoster: true },
        { userId: "a", allotmentUsd: 33.33, floorUsd: 0, onRoster: true },
        { userId: "r", allotmentUsd: 30, floorUsd: 30, onRoster: false },
      ],
    });
    expect(newMax).toBeLessThan(66);
    const clamped = clampSharedKeyOverrideRaises({
      periodPoolUsd: pool,
      nonOverrideAllotments: new Map([
        ["a", 33.33],
        ["j", 33.34],
      ]),
      nonOverrideFloors: new Map([
        ["a", 0],
        ["j", 0],
      ]),
      removedFloors: new Map([["r", 0]]),
      overrides: [{ userId: "x", previousAllotmentUsd: 33.33, floorUsd: 0, requestedUsd: 66 }],
    });
    expect(clamped.get("x")!).toBeLessThanOrEqual(33.33 + 1e-9);
  });

  describe("property: shared-key allotment invariants", () => {
    const PROPERTY_SEED = 0x5a7eb003;
    const weekStart = new Date("2026-11-02T05:00:00.000Z");
    const mid = new Date("2026-11-05T12:00:00.000Z");
    const ids = ["a", "b", "c", "d"] as const;

    type Sim = {
      monthlyCapUsd: number;
      period: SharedKeyPeriodKind;
      members: Map<string, Date>;
      allotments: Map<string, number>;
      spent: Map<string, number>;
      reserved: Map<string, number>;
      overrides: Map<string, number>;
      capCutBelowCommitted: boolean;
    };

    const poolOf = (monthly: number, period: SharedKeyPeriodKind) =>
      sharedKeyPeriodPoolUsd(monthly, period);

    const periodEndOf = (period: SharedKeyPeriodKind) =>
      period === "month"
        ? sharedKeyPeriodEnd(
            {
              period: "month",
              resetDow: 1,
              resetDom: 1,
              resetMinutes: 0,
              timezone: SHARED_KEY_BUDGET_TIMEZONE,
            },
            weekStart,
          )
        : sharedKeyWeekEnd(weekStart);

    const spendableOf = (sim: Sim) => {
      let sum = 0;
      for (const [userId, allotment] of sim.allotments) {
        const floor = (sim.spent.get(userId) ?? 0) + (sim.reserved.get(userId) ?? 0);
        if (sim.members.has(userId)) sum += Math.max(allotment, floor);
        else sum += floor;
      }
      return sum;
    };

    const assertBounds = (sim: Sim) => {
      const pool = poolOf(sim.monthlyCapUsd, sim.period);
      const spendable = spendableOf(sim);
      if (sim.capCutBelowCommitted) {
        for (const [userId, allotment] of sim.allotments) {
          if (!sim.members.has(userId)) continue;
          const floor = (sim.spent.get(userId) ?? 0) + (sim.reserved.get(userId) ?? 0);
          expect(allotment).toBeLessThanOrEqual(floor + 1e-6);
        }
        return;
      }
      expect(spendable).toBeLessThanOrEqual(pool + 1e-6);
      const sumAllot = [...sim.members.keys()].reduce(
        (sum, id) => sum + (sim.allotments.get(id) ?? 0),
        0,
      );
      expect(sumAllot).toBeLessThanOrEqual(pool + 1e-6);
    };

    const redivide = (sim: Sim, rebaseOnMonthlyCap: boolean) => {
      const members = [...sim.members.entries()].map(([userId, joinedAt]) => ({
        userId,
        joinedAt,
      }));
      const previousAllotments = new Map(sim.allotments);
      const next = redivideWeeklyAllotments({
        monthlyCapUsd: sim.monthlyCapUsd,
        members,
        weekStart,
        now: mid,
        previousAllotments,
        spentByUser: new Map(sim.spent),
        reservedByUser: new Map(sim.reserved),
        overrides: new Map(sim.overrides),
        rebaseOnMonthlyCap,
        period: sim.period,
        periodEnd: periodEndOf(sim.period),
      });
      const merged = new Map<string, number>();
      for (const [userId, allotment] of next) merged.set(userId, allotment);
      for (const [userId] of previousAllotments) {
        if (sim.members.has(userId)) continue;
        const floor = (sim.spent.get(userId) ?? 0) + (sim.reserved.get(userId) ?? 0);
        merged.set(userId, floor);
      }
      sim.allotments = merged;
    };

    const maxRaiseFor = (sim: Sim, userId: string) => {
      const pool = poolOf(sim.monthlyCapUsd, sim.period);
      const rows = [...sim.allotments.entries()].map(([id, allotmentUsd]) => ({
        userId: id,
        allotmentUsd,
        floorUsd: (sim.spent.get(id) ?? 0) + (sim.reserved.get(id) ?? 0),
        onRoster: sim.members.has(id),
      }));
      return maxSharedKeyOverrideAllotmentUsd({ periodPoolUsd: pool, userId, rows });
    };

    const commandArb = fc.oneof(
      fc.record({
        kind: fc.constant("override" as const),
        user: fc.constantFrom(...ids),
        amount: fc.integer({ min: 0, max: 120 }),
      }),
      fc.record({
        kind: fc.constant("clearOverride" as const),
        user: fc.constantFrom(...ids),
      }),
      fc.record({
        kind: fc.constant("cap" as const),
        monthly: fc.constantFrom(100, 200, 400, 800),
      }),
      fc.record({
        kind: fc.constant("period" as const),
        period: fc.constantFrom("week" as const, "month" as const),
      }),
      fc.record({
        kind: fc.constant("join" as const),
        user: fc.constantFrom(...ids),
      }),
      fc.record({
        kind: fc.constant("prune" as const),
        user: fc.constantFrom(...ids),
      }),
      fc.record({
        kind: fc.constant("spend" as const),
        user: fc.constantFrom(...ids),
        amount: fc.integer({ min: 1, max: 40 }),
      }),
      fc.record({
        kind: fc.constant("reserve" as const),
        user: fc.constantFrom(...ids),
        amount: fc.integer({ min: 1, max: 20 }),
      }),
    );

    function runCommands(
      commands: Array<{
        kind: string;
        user?: string;
        amount?: number;
        monthly?: number;
        period?: SharedKeyPeriodKind;
      }>,
      mode: "api-filtered" | "raw-core",
    ) {
      const sim: Sim = {
        monthlyCapUsd: 400,
        period: "week",
        members: new Map(ids.slice(0, 3).map((id) => [id, weekStart])),
        allotments: new Map(),
        spent: new Map(),
        reserved: new Map(),
        overrides: new Map(),
        capCutBelowCommitted: false,
      };
      redivide(sim, true);
      assertBounds(sim);

      for (const cmd of commands) {
        switch (cmd.kind) {
          case "override": {
            if (!cmd.user || !sim.members.has(cmd.user)) break;
            const pool = poolOf(sim.monthlyCapUsd, sim.period);
            const othersSum = [...sim.overrides.entries()]
              .filter(([id]) => id !== cmd.user)
              .reduce((sum, [, v]) => sum + v, 0);
            const amount = cmd.amount ?? 0;
            if (othersSum + amount > pool) break;
            if (mode === "api-filtered") {
              const maxRaise = maxRaiseFor(sim, cmd.user);
              if (amount > maxRaise + 1e-9) break;
            }
            sim.overrides.set(cmd.user, amount);
            redivide(sim, false);
            break;
          }
          case "clearOverride": {
            if (!cmd.user) break;
            sim.overrides.delete(cmd.user);
            redivide(sim, false);
            break;
          }
          case "cap": {
            if (cmd.monthly == null) break;
            const pool = poolOf(cmd.monthly, sim.period);
            const overrideSum = [...sim.overrides.values()].reduce((sum, v) => sum + v, 0);
            if (overrideSum > pool) break;
            const committed = [...sim.allotments.keys()].reduce((sum, id) => {
              return sum + (sim.spent.get(id) ?? 0) + (sim.reserved.get(id) ?? 0);
            }, 0);
            sim.capCutBelowCommitted = committed > pool + 1e-9;
            sim.monthlyCapUsd = cmd.monthly;
            redivide(sim, true);
            break;
          }
          case "period": {
            if (!cmd.period) break;
            const pool = poolOf(sim.monthlyCapUsd, cmd.period);
            const overrideSum = [...sim.overrides.values()].reduce((sum, v) => sum + v, 0);
            if (overrideSum > pool) break;
            const committed = [...sim.allotments.keys()].reduce((sum, id) => {
              return sum + (sim.spent.get(id) ?? 0) + (sim.reserved.get(id) ?? 0);
            }, 0);
            sim.capCutBelowCommitted = committed > pool + 1e-9;
            sim.period = cmd.period;
            redivide(sim, true);
            break;
          }
          case "join": {
            if (!cmd.user || sim.members.has(cmd.user)) break;
            sim.members.set(cmd.user, mid);
            redivide(sim, false);
            break;
          }
          case "prune": {
            if (!cmd.user || !sim.members.has(cmd.user) || sim.members.size <= 1) break;
            sim.members.delete(cmd.user);
            sim.overrides.delete(cmd.user);
            redivide(sim, false);
            break;
          }
          case "spend": {
            if (!cmd.user || !sim.members.has(cmd.user)) break;
            const allotment = sim.allotments.get(cmd.user) ?? 0;
            const spent = sim.spent.get(cmd.user) ?? 0;
            const reserved = sim.reserved.get(cmd.user) ?? 0;
            const room = Math.max(0, allotment - spent - reserved);
            const delta = Math.min(cmd.amount ?? 0, room);
            if (delta <= 0) break;
            sim.spent.set(cmd.user, spent + delta);
            break;
          }
          case "reserve": {
            if (!cmd.user || !sim.members.has(cmd.user)) break;
            const allotment = sim.allotments.get(cmd.user) ?? 0;
            const spent = sim.spent.get(cmd.user) ?? 0;
            const reserved = sim.reserved.get(cmd.user) ?? 0;
            const room = Math.max(0, allotment - spent - reserved);
            const delta = Math.min(cmd.amount ?? 0, room);
            if (delta <= 0) break;
            sim.reserved.set(cmd.user, reserved + delta);
            break;
          }
        }
        const pool = poolOf(sim.monthlyCapUsd, sim.period);
        const floorsSum = [...sim.allotments.keys()].reduce((sum, id) => {
          return sum + (sim.spent.get(id) ?? 0) + (sim.reserved.get(id) ?? 0);
        }, 0);
        if (floorsSum > pool + 1e-9) {
          sim.capCutBelowCommitted = true;
          // Cap-cut exception: no allotment may exceed that member's spent+reserved.
          for (const [userId, allotment] of [...sim.allotments.entries()]) {
            if (!sim.members.has(userId)) continue;
            const floor = (sim.spent.get(userId) ?? 0) + (sim.reserved.get(userId) ?? 0);
            if (allotment > floor) sim.allotments.set(userId, floor);
          }
        } else if (spendableOf(sim) <= pool + 1e-9) {
          sim.capCutBelowCommitted = false;
        }
        assertBounds(sim);
      }
    }

    it("API-filtered raises keep spendable ≤ pool (fixed seed, ≥2000 steps)", () => {
      try {
        fc.assert(
          fc.property(fc.array(commandArb, { minLength: 40, maxLength: 80 }), (commands) => {
            runCommands(commands, "api-filtered");
          }),
          { seed: PROPERTY_SEED, numRuns: 50, endOnFailure: true },
        );
      } catch (error) {
        console.error(`shared-key property (api-filtered) failed with seed ${PROPERTY_SEED}`);
        throw error;
      }
    });

    it("raw-core raises are clamped so spendable ≤ pool (fixed seed, ≥2000 steps)", () => {
      try {
        fc.assert(
          fc.property(fc.array(commandArb, { minLength: 40, maxLength: 80 }), (commands) => {
            runCommands(commands, "raw-core");
          }),
          { seed: PROPERTY_SEED + 1, numRuns: 50, endOnFailure: true },
        );
      } catch (error) {
        console.error(`shared-key property (raw-core) failed with seed ${PROPERTY_SEED + 1}`);
        throw error;
      }
    });
  });
});
