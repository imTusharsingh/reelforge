import { describe, expect, it } from "vitest";
import {
  assertTransition,
  canTransition,
  isTerminalRunState,
  isTerminalStepState,
  retryDelayMs,
} from "./orchestration.state.js";

describe("workflow state machines", () => {
  it("allows the documented run transitions", () => {
    expect(canTransition("RUN", "CREATED", "QUEUED")).toBe(true);
    expect(canTransition("RUN", "QUEUED", "RUNNING")).toBe(true);
    expect(canTransition("RUN", "RUNNING", "WAITING_APPROVAL")).toBe(true);
    expect(canTransition("RUN", "WAITING_APPROVAL", "QUEUED")).toBe(true);
    expect(canTransition("RUN", "RUNNING", "PAUSED")).toBe(true);
    expect(canTransition("RUN", "PAUSED", "QUEUED")).toBe(true);
    expect(canTransition("RUN", "RETRY_WAIT", "RUNNING")).toBe(true);
    expect(canTransition("RUN", "FAILED", "QUEUED")).toBe(true);
  });

  it("rejects illegal run transitions", () => {
    expect(canTransition("RUN", "SUCCEEDED", "RUNNING")).toBe(false);
    expect(canTransition("RUN", "CANCELED", "QUEUED")).toBe(false);
    expect(canTransition("RUN", "CREATED", "SUCCEEDED")).toBe(false);
  });

  it("allows step transitions including reconciliation", () => {
    expect(canTransition("STEP", "PENDING", "QUEUED")).toBe(true);
    expect(canTransition("STEP", "QUEUED", "RUNNING")).toBe(true);
    expect(canTransition("STEP", "RUNNING", "WAITING_APPROVAL")).toBe(true);
    expect(canTransition("STEP", "RUNNING", "RECONCILIATION_REQUIRED")).toBe(true);
    expect(canTransition("STEP", "RECONCILIATION_REQUIRED", "QUEUED")).toBe(true);
    expect(canTransition("STEP", "SUCCEEDED", "QUEUED")).toBe(false);
  });

  it("allows job transitions and dead-lettering", () => {
    expect(canTransition("JOB", "QUEUED", "RUNNING")).toBe(true);
    expect(canTransition("JOB", "RUNNING", "RETRY_WAIT")).toBe(true);
    expect(canTransition("JOB", "RUNNING", "DEAD_LETTER")).toBe(true);
    expect(canTransition("JOB", "DEAD_LETTER", "QUEUED")).toBe(false);
  });

  it("throws on an illegal asserted transition", () => {
    expect(() => assertTransition("RUN", "SUCCEEDED", "QUEUED")).toThrow(/Illegal RUN transition/);
  });

  it("identifies terminal states", () => {
    expect(isTerminalRunState("SUCCEEDED")).toBe(true);
    expect(isTerminalRunState("FAILED")).toBe(true);
    expect(isTerminalRunState("CANCELED")).toBe(true);
    expect(isTerminalRunState("RUNNING")).toBe(false);
    expect(isTerminalStepState("SKIPPED")).toBe(true);
    expect(isTerminalStepState("RETRY_WAIT")).toBe(false);
  });

  it("computes bounded exponential backoff", () => {
    expect(retryDelayMs(1, 1000, 60_000)).toBe(1000);
    expect(retryDelayMs(2, 1000, 60_000)).toBe(2000);
    expect(retryDelayMs(3, 1000, 60_000)).toBe(4000);
    expect(retryDelayMs(20, 1000, 60_000)).toBe(60_000);
    expect(retryDelayMs(0, 1000, 60_000)).toBe(1000);
  });
});
