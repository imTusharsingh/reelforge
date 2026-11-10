import type {
  WorkflowJobState,
  WorkflowRunState,
  WorkflowStepState,
} from "./orchestration.types.js";

export type WorkflowMachine = "RUN" | "STEP" | "JOB";

const runTransitions: Readonly<Record<WorkflowRunState, readonly WorkflowRunState[]>> = {
  CREATED: ["QUEUED", "PAUSED", "CANCELED", "FAILED"],
  QUEUED: [
    "RUNNING",
    "WAITING_APPROVAL",
    "SUCCEEDED",
    "RETRY_WAIT",
    "PAUSED",
    "CANCELED",
    "FAILED",
  ],
  RUNNING: [
    "QUEUED",
    "WAITING_APPROVAL",
    "SUCCEEDED",
    "RETRY_WAIT",
    "PAUSED",
    "CANCELED",
    "FAILED",
  ],
  WAITING_APPROVAL: ["QUEUED", "RUNNING", "SUCCEEDED", "PAUSED", "CANCELED", "FAILED"],
  SUCCEEDED: [],
  PAUSED: ["QUEUED", "RUNNING", "CANCELED", "FAILED"],
  RETRY_WAIT: [
    "QUEUED",
    "RUNNING",
    "WAITING_APPROVAL",
    "SUCCEEDED",
    "PAUSED",
    "CANCELED",
    "FAILED",
  ],
  FAILED: ["QUEUED", "CANCELED"],
  CANCELED: [],
};

const stepTransitions: Readonly<Record<WorkflowStepState, readonly WorkflowStepState[]>> = {
  PENDING: ["QUEUED", "SKIPPED", "CANCELED"],
  QUEUED: ["RUNNING", "CANCELED", "FAILED"],
  RUNNING: [
    "QUEUED",
    "SUCCEEDED",
    "SKIPPED",
    "WAITING_APPROVAL",
    "WAITING_EXTERNAL",
    "RETRY_WAIT",
    "FAILED",
    "RECONCILIATION_REQUIRED",
    "CANCELED",
  ],
  WAITING_APPROVAL: ["QUEUED", "RUNNING", "SUCCEEDED", "CANCELED", "FAILED"],
  WAITING_EXTERNAL: ["RUNNING", "QUEUED", "FAILED", "RECONCILIATION_REQUIRED", "CANCELED"],
  SUCCEEDED: [],
  RETRY_WAIT: ["QUEUED", "RUNNING", "FAILED", "CANCELED"],
  FAILED: ["QUEUED", "CANCELED"],
  CANCELED: [],
  SKIPPED: [],
  RECONCILIATION_REQUIRED: ["QUEUED", "FAILED", "CANCELED"],
};

const jobTransitions: Readonly<Record<WorkflowJobState, readonly WorkflowJobState[]>> = {
  QUEUED: ["RUNNING", "CANCELED"],
  RUNNING: ["SUCCEEDED", "RETRY_WAIT", "FAILED", "DEAD_LETTER", "CANCELED"],
  SUCCEEDED: [],
  RETRY_WAIT: ["QUEUED", "RUNNING", "FAILED", "DEAD_LETTER", "CANCELED"],
  FAILED: ["QUEUED", "DEAD_LETTER", "CANCELED"],
  DEAD_LETTER: [],
  CANCELED: [],
};

export function canTransition(
  machine: "RUN",
  from: WorkflowRunState,
  to: WorkflowRunState,
): boolean;
export function canTransition(
  machine: "STEP",
  from: WorkflowStepState,
  to: WorkflowStepState,
): boolean;
export function canTransition(
  machine: "JOB",
  from: WorkflowJobState,
  to: WorkflowJobState,
): boolean;
export function canTransition(
  machine: WorkflowMachine,
  from: WorkflowRunState | WorkflowStepState | WorkflowJobState,
  to: WorkflowRunState | WorkflowStepState | WorkflowJobState,
): boolean {
  if (machine === "RUN")
    return (runTransitions[from as WorkflowRunState] ?? []).includes(to as WorkflowRunState);
  if (machine === "STEP")
    return (stepTransitions[from as WorkflowStepState] ?? []).includes(to as WorkflowStepState);
  return (jobTransitions[from as WorkflowJobState] ?? []).includes(to as WorkflowJobState);
}

export function assertTransition(
  machine: WorkflowMachine,
  from: WorkflowRunState | WorkflowStepState | WorkflowJobState,
  to: WorkflowRunState | WorkflowStepState | WorkflowJobState,
): void {
  if (from === to) return;
  if (!canTransition(machine as "RUN", from as WorkflowRunState, to as WorkflowRunState))
    throw new Error(`Illegal ${machine} transition ${from} -> ${to}`);
}

/**
 * Validates every expected source state of a compare-and-swap against the transition table and
 * returns them, so the CAS `where` clause and the state machine cannot drift apart.
 */
export function transitionFrom<T extends WorkflowRunState | WorkflowStepState | WorkflowJobState>(
  machine: WorkflowMachine,
  from: readonly T[],
  to: T,
): T[] {
  for (const state of from) assertTransition(machine, state, to);
  return [...from];
}

export const CANCELABLE_RUN_STATES: readonly WorkflowRunState[] = [
  "CREATED",
  "QUEUED",
  "RUNNING",
  "WAITING_APPROVAL",
  "PAUSED",
  "RETRY_WAIT",
];

export const ACTIVE_STEP_STATES: readonly WorkflowStepState[] = [
  "PENDING",
  "QUEUED",
  "RUNNING",
  "WAITING_APPROVAL",
  "RETRY_WAIT",
  "WAITING_EXTERNAL",
  "RECONCILIATION_REQUIRED",
];

export const ACTIVE_JOB_STATES: readonly WorkflowJobState[] = ["QUEUED", "RUNNING", "RETRY_WAIT"];

export function isTerminalRunState(state: WorkflowRunState): boolean {
  return state === "SUCCEEDED" || state === "FAILED" || state === "CANCELED";
}

export function isTerminalStepState(state: WorkflowStepState): boolean {
  return state === "SUCCEEDED" || state === "FAILED" || state === "CANCELED" || state === "SKIPPED";
}

export function retryDelayMs(attempt: number, baseDelayMs: number, maxDelayMs: number): number {
  const exponential = baseDelayMs * Math.pow(2, Math.max(0, attempt - 1));
  return Math.min(maxDelayMs, Math.max(baseDelayMs, exponential));
}
