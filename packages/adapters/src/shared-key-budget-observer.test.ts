import type { ModelCallObserver } from "@rakazo/adapter-kit";
import { SHARED_KEY_WEEKLY_BUDGET_ERROR } from "@rakazo/core";
import {
  releaseSharedKeyBudgetHold,
  reserveSharedKeyBudget,
  SharedKeyWeeklyBudgetExceededError,
  sharedKeyMonthlyBudgetUsd,
} from "@rakazo/db";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  assertSharedKeyWeeklyBudget,
  composeSharedKeyBudgetObserver,
  SharedKeyWeeklyBudgetExceededRunError,
  sharedKeyBudgetObserver,
} from "./shared-key-budget-observer.js";

vi.mock("@rakazo/db", () => ({
  sharedKeyMonthlyBudgetUsd: vi.fn(),
  reserveSharedKeyBudget: vi.fn(),
  releaseSharedKeyBudgetHold: vi.fn(),
  SharedKeyWeeklyBudgetExceededError: class SharedKeyWeeklyBudgetExceededError extends Error {
    constructor() {
      super("shared key weekly budget exceeded");
      this.name = "SharedKeyWeeklyBudgetExceededError";
    }
  },
}));

const scope = { userId: "user-1" };
const call = {
  callId: "call-1",
  maxCostUsd: 0.02,
  provider: "test-provider",
  modelId: "test-model",
  runId: "run-1",
  inputTokensEstimate: 10,
  maxOutputTokens: 100,
} as Parameters<ModelCallObserver["beforeCall"]>[0];

beforeEach(() => {
  vi.resetAllMocks();
});

describe("shared-key budget observer", () => {
  it("does nothing when the monthly cap is unset", async () => {
    vi.mocked(sharedKeyMonthlyBudgetUsd).mockResolvedValue(null);
    await expect(sharedKeyBudgetObserver({} as never, scope)).resolves.toBeUndefined();
  });

  it("resolves the monthly cap with the env fallback, same as summary/ops", async () => {
    vi.mocked(sharedKeyMonthlyBudgetUsd).mockResolvedValue(50);
    await expect(sharedKeyBudgetObserver({} as never, scope, 50)).resolves.toBeDefined();
    expect(sharedKeyMonthlyBudgetUsd).toHaveBeenCalledWith({}, 50);
  });

  it("hard-stops a shared-key call at the weekly cap", async () => {
    vi.mocked(sharedKeyMonthlyBudgetUsd).mockResolvedValue(400);
    vi.mocked(reserveSharedKeyBudget).mockRejectedValue(new SharedKeyWeeklyBudgetExceededError());
    const observer = await sharedKeyBudgetObserver({} as never, scope);
    await expect(observer!.beforeCall(call)).rejects.toBeInstanceOf(
      SharedKeyWeeklyBudgetExceededRunError,
    );
    await expect(observer!.beforeCall(call)).rejects.toThrow(SHARED_KEY_WEEKLY_BUDGET_ERROR);
  });

  it("reserves and releases a hold around a successful call", async () => {
    vi.mocked(sharedKeyMonthlyBudgetUsd).mockResolvedValue(400);
    vi.mocked(reserveSharedKeyBudget).mockResolvedValue(undefined);
    vi.mocked(releaseSharedKeyBudgetHold).mockResolvedValue(undefined);
    const observer = await sharedKeyBudgetObserver({} as never, scope);
    const id = await observer!.beforeCall(call);
    expect(reserveSharedKeyBudget).toHaveBeenCalledWith({}, "user-1", 0.02);
    await observer!.afterCall(id, null);
    expect(releaseSharedKeyBudgetHold).toHaveBeenCalledWith({}, "user-1", 0.02);
  });

  it("lets personal-key paths skip the observer entirely", async () => {
    // resolveModelKey only attaches this observer when using the shared key.
    vi.mocked(sharedKeyMonthlyBudgetUsd).mockResolvedValue(400);
    expect(await sharedKeyBudgetObserver({} as never, scope)).toBeDefined();
    expect(reserveSharedKeyBudget).not.toHaveBeenCalled();
  });

  it("runs the weekly hard-stop before an inner credit/fallback observer", async () => {
    vi.mocked(sharedKeyMonthlyBudgetUsd).mockResolvedValue(400);
    vi.mocked(reserveSharedKeyBudget).mockRejectedValue(new SharedKeyWeeklyBudgetExceededError());
    const budget = await sharedKeyBudgetObserver({} as never, scope);
    const innerBefore = vi.fn(async () => "inner");
    const composed = composeSharedKeyBudgetObserver(budget, {
      beforeCall: innerBefore,
      afterCall: vi.fn(),
    });
    await expect(composed!.beforeCall(call)).rejects.toBeInstanceOf(
      SharedKeyWeeklyBudgetExceededRunError,
    );
    expect(innerBefore).not.toHaveBeenCalled();
  });

  it("exposes assertSharedKeyWeeklyBudget for model-fallback hooks", async () => {
    vi.mocked(sharedKeyMonthlyBudgetUsd).mockResolvedValue(400);
    vi.mocked(reserveSharedKeyBudget).mockRejectedValue(new SharedKeyWeeklyBudgetExceededError());
    await expect(assertSharedKeyWeeklyBudget({} as never, "user-1", 0.01)).rejects.toBeInstanceOf(
      SharedKeyWeeklyBudgetExceededRunError,
    );
  });
});
