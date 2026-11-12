import { describe, expect, it } from "vitest";
import { createRunPhaseTiming } from "./run-phase-timing.js";

function controllableClock() {
  let current = 0;
  return {
    now: () => current,
    at(ms: number) {
      current = ms;
    },
  };
}

describe("run phase timing", () => {
  it("attributes model wait, TTFT, tool wait, and leftover framework time", () => {
    const clock = controllableClock();
    const timing = createRunPhaseTiming(clock.now);
    timing.start();
    clock.at(10);
    timing.markModelStart();
    clock.at(40);
    timing.markFirstToken();
    clock.at(100);
    timing.markModelEnd();
    timing.markToolStart();
    clock.at(180);
    timing.markToolEnd();
    clock.at(200);
    expect(timing.finish()).toEqual({
      "run.ttft_ms": 30,
      "run.model_wait_ms": 90,
      "run.tool_wait_ms": 80,
      "run.framework_ms": 30,
    });
  });

  it("keeps overlapping tools on one exclusive tool phase", () => {
    const clock = controllableClock();
    const timing = createRunPhaseTiming(clock.now);
    timing.start();
    clock.at(5);
    timing.markToolStart();
    clock.at(10);
    timing.markToolStart();
    clock.at(20);
    timing.markToolEnd();
    clock.at(50);
    timing.markToolEnd();
    clock.at(60);
    expect(timing.finish()).toEqual({
      "run.model_wait_ms": 0,
      "run.tool_wait_ms": 45,
      "run.framework_ms": 15,
    });
  });

  it("counts time under an open model request as model-bound even if a tool marker arrives", () => {
    const clock = controllableClock();
    const timing = createRunPhaseTiming(clock.now);
    timing.start();
    timing.markModelStart();
    clock.at(5);
    timing.markToolStart();
    clock.at(15);
    timing.markToolEnd();
    clock.at(20);
    timing.markFirstToken();
    clock.at(30);
    timing.markModelEnd();
    expect(timing.finish()).toEqual({
      "run.ttft_ms": 20,
      "run.model_wait_ms": 30,
      "run.tool_wait_ms": 0,
      "run.framework_ms": 0,
    });
  });

  it("omits TTFT when the model never emits text", () => {
    const clock = controllableClock();
    const timing = createRunPhaseTiming(clock.now);
    timing.start();
    timing.markModelStart();
    clock.at(25);
    timing.markModelEnd();
    clock.at(40);
    expect(timing.finish()).toEqual({
      "run.model_wait_ms": 25,
      "run.tool_wait_ms": 0,
      "run.framework_ms": 15,
    });
  });

  it("records TTFT only once across later tokens", () => {
    const clock = controllableClock();
    const timing = createRunPhaseTiming(clock.now);
    timing.start();
    timing.markModelStart();
    clock.at(12);
    timing.markFirstToken();
    clock.at(18);
    timing.markFirstToken();
    clock.at(40);
    timing.markModelEnd();
    expect(timing.finish()["run.ttft_ms"]).toBe(12);
  });

  it("is safe to finish twice and ignores markers after finish", () => {
    const clock = controllableClock();
    const timing = createRunPhaseTiming(clock.now);
    timing.start();
    clock.at(10);
    const first = timing.finish();
    timing.markModelStart();
    timing.markToolStart();
    expect(timing.finish()).toEqual(first);
    expect(first).toEqual({
      "run.model_wait_ms": 0,
      "run.tool_wait_ms": 0,
      "run.framework_ms": 10,
    });
  });
});
