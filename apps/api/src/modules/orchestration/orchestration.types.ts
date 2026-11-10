import type {
  WorkflowBudgetDecision,
  WorkflowDefinitionKey,
  WorkflowDispatchStatus,
  WorkflowJobStatus,
  WorkflowLeaseScope,
  WorkflowScheduleSlotStatus,
  WorkflowState,
  WorkflowStepStatus,
  WorkflowTrigger,
} from "@reelforge/database";
import type { WorkspaceContext } from "../identity/identity.types.js";

export const ORCHESTRATION_QUEUE_NAME = "workflow-orchestration";
export const WORKFLOW_QUEUE_PORT = Symbol("WORKFLOW_QUEUE_PORT");
export const WORKFLOW_BUDGET_POLICY = Symbol("WORKFLOW_BUDGET_POLICY");
export const WORKFLOW_STEP_DISPATCHER = Symbol("WORKFLOW_STEP_DISPATCHER");
export const ORCHESTRATION_CLOCK = Symbol("ORCHESTRATION_CLOCK");
export const WORKFLOW_LIMIT_CONFIG = Symbol("WORKFLOW_LIMIT_CONFIG");

export const WORKFLOW_STEP_KEYS = [
  "VERIFY_CONTEXT",
  "SELECT_IDEA",
  "GENERATE_SCRIPT",
  "GENERATE_SCENE_MEDIA",
  "COMPOSE_RENDER",
  "QUALITY_REVIEW",
  "PUBLISH",
  "ANALYTICS_FOLLOW_UP",
] as const;
export type WorkflowStepKey = (typeof WORKFLOW_STEP_KEYS)[number];

export type WorkflowTriggerValue = WorkflowTrigger;
export type WorkflowDefinition = WorkflowDefinitionKey;
export type WorkflowRunState = WorkflowState;
export type WorkflowStepState = WorkflowStepStatus;
export type WorkflowJobState = WorkflowJobStatus;
export type WorkflowBudgetDecisionValue = WorkflowBudgetDecision;
export type WorkflowDispatchStatusValue = WorkflowDispatchStatus;
export type WorkflowLeaseScopeValue = WorkflowLeaseScope;
export type WorkflowScheduleSlotStatusValue = WorkflowScheduleSlotStatus;

export type WorkflowRunInput = Readonly<Record<string, unknown>>;

export type WorkflowQueueJob = Readonly<{
  jobId: string;
  queueName: string;
  workspaceId: string;
  runId: string;
  stepId: string;
  attempt: number;
  correlationId: string;
  maxAttempts: number;
  delayMs: number;
  /** Limit waits + external polls; part of the deterministic job id, never an attempt. */
  wake?: number;
}>;

export type WorkflowQueueHealth = "CONFIGURED" | "NOT_CONFIGURED" | "UNREACHABLE";

export type WorkflowQueueEnqueueResult = "ENQUEUED" | "NOT_CONFIGURED" | "DUPLICATE";

export interface WorkflowQueuePort {
  readonly status: "CONFIGURED" | "NOT_CONFIGURED";
  enqueue(job: WorkflowQueueJob): Promise<WorkflowQueueEnqueueResult>;
  health(): Promise<WorkflowQueueHealth>;
  close(): Promise<void>;
}

export type WorkflowStepDispatchInput = Readonly<{
  context: WorkspaceContext;
  runId: string;
  stepId: string;
  stepKey: WorkflowStepKey;
  definitionKey: WorkflowDefinition;
  trigger: WorkflowTriggerValue;
  correlationId: string;
  idempotencyKey: string;
  attempt: number;
  input: WorkflowRunInput;
  /** Domain record persisted by an earlier attempt or poll of this step, if any. */
  previousResultRef: string | null;
}>;

export type WorkflowStepDispatchResult = Readonly<{
  resultRef: string;
  resultType: string;
  output?: Readonly<Record<string, unknown>>;
  waitingApproval?: boolean;
  /** The domain record exists but is not finished; re-check it later without using an attempt. */
  waitingExternal?: Readonly<{ reason: string; pollDelayMs?: number }>;
  skipped?: boolean;
}>;

export interface WorkflowStepDispatcherPort {
  dispatchStep(input: WorkflowStepDispatchInput): Promise<WorkflowStepDispatchResult>;
}

export type BudgetPolicyInput = Readonly<{
  workspaceId: string;
  channelId: string | null;
  definitionKey: WorkflowDefinition;
  trigger: WorkflowTriggerValue;
}>;

export type BudgetPolicyResult = Readonly<{
  decision: "ALLOWED" | "BLOCKED" | "NOT_CONFIGURED";
  reason: string | null;
}>;

export interface BudgetPolicyPort {
  evaluate(input: BudgetPolicyInput): Promise<BudgetPolicyResult>;
}

export type WorkflowLimitConfig = Readonly<{
  workspaceConcurrency: number;
  channelConcurrency: number;
  providerConcurrency: number;
  jobTypeConcurrency: number;
  rateLimitPerMinute: number;
  leaseTtlMs: number;
  retryBaseDelayMs: number;
  retryMaxDelayMs: number;
  stepLeaseTtlMs: number;
  heartbeatIntervalMs: number;
  stallGraceMs: number;
  minPollMs: number;
  maxPollMs: number;
}>;

export const DEFAULT_WORKFLOW_LIMIT_CONFIG: WorkflowLimitConfig = {
  workspaceConcurrency: 4,
  channelConcurrency: 2,
  providerConcurrency: 3,
  jobTypeConcurrency: 2,
  rateLimitPerMinute: 120,
  leaseTtlMs: 300_000,
  retryBaseDelayMs: 1_000,
  retryMaxDelayMs: 60_000,
  stepLeaseTtlMs: 60_000,
  heartbeatIntervalMs: 20_000,
  stallGraceMs: 120_000,
  minPollMs: 15_000,
  maxPollMs: 60_000,
};

export type WorkflowRunView = Readonly<{
  id: string;
  workspaceId: string;
  channelId: string | null;
  correlationId: string;
  definitionKey: WorkflowDefinition;
  trigger: WorkflowTriggerValue;
  triggeredByUserId: string | null;
  state: WorkflowRunState;
  dispatchStatus: WorkflowDispatchStatusValue;
  budgetDecision: WorkflowBudgetDecisionValue;
  budgetReason: string | null;
  currentStepKey: string | null;
  nextAction: string | null;
  pausedReason: string | null;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
  input: WorkflowRunInput;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
  steps: readonly WorkflowStepView[];
  jobs: readonly WorkflowJobView[];
  events: readonly WorkflowEventView[];
}>;

export type WorkflowStepView = Readonly<{
  id: string;
  runId: string;
  stepKey: string;
  sequence: number;
  status: WorkflowStepState;
  attempts: number;
  maxAttempts: number;
  retryGeneration: number;
  sideEffect: boolean;
  idempotencyKey: string;
  resultRef: string | null;
  resultType: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  leaseExpiresAt: string | null;
  nextAttemptAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}>;

export type WorkflowJobView = Readonly<{
  id: string;
  runId: string;
  stepId: string;
  jobId: string;
  queueName: string;
  attempt: number;
  status: WorkflowJobState;
  errorCode: string | null;
  errorMessage: string | null;
  deadLetteredAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}>;

export type WorkflowEventView = Readonly<{
  id: string;
  runId: string;
  stepId: string | null;
  jobId: string | null;
  eventType: string;
  correlationId: string;
  causationId: string | null;
  payload: Readonly<Record<string, unknown>>;
  occurredAt: string;
}>;

export type WorkflowSchedulerChannel = Readonly<{
  id: string;
  workspaceId: string;
  status: "ACTIVE" | "PAUSED" | "ARCHIVED";
  timezone: string;
  schedule: unknown;
  approvalPolicy: unknown;
}>;

export type WorkflowScheduleOccurrence = Readonly<{
  slotKey: string;
  localDate: string;
  localTime: string;
  scheduledFor: Date;
  definitionKey: WorkflowDefinition;
  timezone: string;
}>;

export type WorkflowSchedulerTickResult = Readonly<{
  evaluatedChannels: number;
  dueSlots: number;
  startedRuns: number;
  skippedSlots: number;
}>;

export class WorkflowStepError extends Error {
  public constructor(
    public readonly code: string,
    message: string,
    public readonly retryable: boolean,
    public readonly reconciliationRequired = false,
  ) {
    super(message);
    this.name = "WorkflowStepError";
  }
}

export type WorkflowJobProcessResult = Readonly<{
  status:
    | "NOOP"
    | "PAUSED"
    | "WAITING_APPROVAL"
    | "STEP_SUCCEEDED"
    | "RUN_SUCCEEDED"
    | "RETRY_WAIT"
    | "FAILED"
    | "LIMIT_WAIT"
    | "WAITING_EXTERNAL"
    | "RECONCILIATION_REQUIRED";
  runId: string;
  stepId: string;
  detail: string | null;
}>;
