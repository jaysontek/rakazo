/**
 * Exclusive wall-clock phase timings for one Pi runtime invocation.
 *
 * Phases are mutually exclusive: while any model request is open the clock is
 * model-bound; while any tool is in flight (and no model request is open) it is
 * tool-bound; otherwise it is framework/orchestration. Sandbox and computer work
 * runs inside tools, so it lands in tool wait. Overlapping helper streams share
 * one clock and are refcounted like tools.
 *
 * Client delivery and UI render are not observable from server events and are
 * intentionally omitted from the fields.
 */

export type RunPhase = "framework" | "model" | "tool";

export type RunPhaseTimingFields = {
  "run.model_wait_ms": number;
  "run.tool_wait_ms": number;
  "run.framework_ms": number;
  /**
   * Start of the model request that produced the first text token → that token.
   * Earlier tool-only model requests are excluded. Omitted when no text arrived.
   */
  "run.ttft_ms"?: number;
};

export interface RunPhaseTiming {
  start(): void;
  markModelStart(): void;
  markFirstToken(): void;
  markModelEnd(): void;
  markToolStart(): void;
  markToolEnd(): void;
  /** Flushes the open phase and returns log fields. Safe to call more than once. */
  finish(): RunPhaseTimingFields;
  fields(): RunPhaseTimingFields;
}

export function createRunPhaseTiming(now: () => number = Date.now): RunPhaseTiming {
  let started = false;
  let closed = false;
  let phase: RunPhase = "framework";
  let phaseStarted = 0;
  let modelsInFlight = 0;
  let toolsInFlight = 0;
  let firstModelStartAt: number | undefined;
  let firstTokenAt: number | undefined;
  let modelWaitMs = 0;
  let toolWaitMs = 0;
  let frameworkMs = 0;

  const flush = (at: number) => {
    const elapsed = Math.max(0, at - phaseStarted);
    if (phase === "model") modelWaitMs += elapsed;
    else if (phase === "tool") toolWaitMs += elapsed;
    else frameworkMs += elapsed;
    phaseStarted = at;
  };

  const desired = (): RunPhase => {
    if (modelsInFlight > 0) return "model";
    if (toolsInFlight > 0) return "tool";
    return "framework";
  };

  const enter = (next: RunPhase) => {
    if (!started || closed || next === phase) return;
    const at = now();
    flush(at);
    phase = next;
  };

  const snapshot = (): RunPhaseTimingFields => ({
    "run.model_wait_ms": modelWaitMs,
    "run.tool_wait_ms": toolWaitMs,
    "run.framework_ms": frameworkMs,
    ...(firstModelStartAt !== undefined && firstTokenAt !== undefined
      ? { "run.ttft_ms": Math.max(0, firstTokenAt - firstModelStartAt) }
      : {}),
  });

  return {
    start() {
      if (started || closed) return;
      started = true;
      phase = "framework";
      phaseStarted = now();
    },
    markModelStart() {
      if (closed) return;
      if (!started) this.start();
      modelsInFlight += 1;
      // Until text arrives, TTFT anchors to the current request so a prior
      // tool-only call cannot stretch across the tool gap.
      if (firstTokenAt === undefined) firstModelStartAt = now();
      enter(desired());
    },
    markFirstToken() {
      if (closed || firstTokenAt !== undefined) return;
      if (firstModelStartAt === undefined) return;
      firstTokenAt = now();
    },
    markModelEnd() {
      if (closed || modelsInFlight === 0) return;
      modelsInFlight -= 1;
      enter(desired());
    },
    markToolStart() {
      if (closed) return;
      if (!started) this.start();
      toolsInFlight += 1;
      enter(desired());
    },
    markToolEnd() {
      if (closed || toolsInFlight === 0) return;
      toolsInFlight -= 1;
      enter(desired());
    },
    finish() {
      if (!started) {
        closed = true;
        return snapshot();
      }
      if (!closed) {
        flush(now());
        closed = true;
        modelsInFlight = 0;
        toolsInFlight = 0;
      }
      return snapshot();
    },
    fields: snapshot,
  };
}
