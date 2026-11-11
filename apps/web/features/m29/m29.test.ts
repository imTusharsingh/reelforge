import { describe, expect, it } from "vitest";
import { parseRun } from "./api";
import { redacted, safeActions } from "./logic";
import type { WorkflowRun } from "./types";

const run = (state: WorkflowRun["state"], stepStatus = "SUCCEEDED"): WorkflowRun => ({
  id: "run-1",
  state,
  dispatchStatus: "DISPATCHED",
  budgetDecision: "ALLOWED",
  budgetReason: null,
  currentStepKey: null,
  nextAction: null,
  pausedReason: null,
  lastErrorCode: null,
  lastErrorMessage: null,
  createdAt: "2026-11-11T00:00:00.000Z",
  updatedAt: "2026-11-11T00:00:00.000Z",
  steps: [
    {
      id: "step-1",
      stepKey: "VERIFY_CONTEXT",
      status: stepStatus,
      attempts: 1,
      maxAttempts: 3,
      sideEffect: false,
      errorCode: null,
      errorMessage: null,
      startedAt: null,
      completedAt: null,
    },
  ],
  jobs: [],
  events: [],
});

describe("M29 contracts and permissions", () => {
  it("does not expose workflow mutations to viewers", () => {
    expect(safeActions(run("RUNNING"), "VIEWER")).toEqual([]);
    expect(safeActions(run("RUNNING"), "EDITOR")).toEqual(["cancel"]);
    expect(safeActions(run("FAILED", "FAILED"), "OWNER")).toEqual(["retry"]);
    expect(safeActions(run("WAITING_APPROVAL"), "EDITOR")).toEqual(["resume", "cancel"]);
  });

  it("redacts bounded failure details", () => {
    expect(redacted("Bearer secret-value token=abc")).toContain("[redacted]");
    expect(redacted("x".repeat(500))).toHaveLength(240);
  });

  it("rejects malformed workflow response shapes", () => {
    expect(() => parseRun({ id: "run-1" })).toThrow("Invalid run.steps");
  });
});
