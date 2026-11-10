import { randomUUID } from "node:crypto";
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { Prisma } from "@reelforge/database";
import type { Database, WorkspaceContext } from "../identity/identity.types.js";
import { ChannelService } from "../channel/channel.service.js";
import { QualityService } from "../quality/quality.service.js";
import {
  firstStep,
  stepDefinition,
  stepIdempotencyKey,
  workflowDefinition,
} from "./orchestration.definitions.js";
import { WorkflowLimitsService } from "./orchestration.limits.js";
import { deterministicJobId } from "./orchestration.queue.js";
import { dueScheduleOccurrences, parseChannelSchedule } from "./orchestration.schedule.js";
import {
  ACTIVE_JOB_STATES,
  ACTIVE_STEP_STATES,
  CANCELABLE_RUN_STATES,
  retryDelayMs,
  transitionFrom,
} from "./orchestration.state.js";
import {
  ORCHESTRATION_CLOCK,
  ORCHESTRATION_QUEUE_NAME,
  WORKFLOW_BUDGET_POLICY,
  WORKFLOW_QUEUE_PORT,
  WORKFLOW_STEP_DISPATCHER,
  WorkflowStepError,
  type BudgetPolicyPort,
  type WorkflowDefinition,
  type WorkflowJobProcessResult,
  type WorkflowJobView,
  type WorkflowQueueEnqueueResult,
  type WorkflowQueueHealth,
  type WorkflowQueueJob,
  type WorkflowQueuePort,
  type WorkflowRunInput,
  type WorkflowRunState,
  type WorkflowRunView,
  type WorkflowScheduleOccurrence,
  type WorkflowSchedulerChannel,
  type WorkflowSchedulerTickResult,
  type WorkflowStepDispatchResult,
  type WorkflowStepDispatcherPort,
  type WorkflowStepKey,
  type WorkflowStepState,
  type WorkflowStepView,
  type WorkflowEventView,
} from "./orchestration.types.js";
import { manualRunInput, parseManualRunBody, parseRunId } from "./orchestration.validation.js";

const runInclude = {
  steps: { orderBy: { sequence: "asc" } },
  jobs: { orderBy: { createdAt: "asc" } },
  events: { orderBy: { occurredAt: "asc" } },
} satisfies Prisma.WorkflowRunInclude;

type RunRecord = Prisma.WorkflowRunGetPayload<{ include: typeof runInclude }>;
type StepRecord = RunRecord["steps"][number];
type JobRecord = RunRecord["jobs"][number];
type EventRecord = RunRecord["events"][number];

const editableRoles = new Set(["OWNER", "EDITOR"]);
const schedulerWindowMs = 5 * 60 * 1000;

function asRecord(value: Prisma.JsonValue): WorkflowRunInput {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

type WorkflowStepStatusValue = WorkflowStepState;

type StepFailure = Readonly<{
  code: string;
  message: string;
  retryable: boolean;
  reconciliationRequired: boolean;
}>;

/** Tolerates small clock skew between the queue's delay and the database clock. */
const CLAIM_SKEW_MS = 1_000;

const CLAIMABLE_STEP_STATES: readonly WorkflowStepState[] = [
  "QUEUED",
  "RETRY_WAIT",
  "WAITING_EXTERNAL",
];

function isUniqueViolation(error: unknown): boolean {
  return (
    (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") ||
    (typeof error === "object" && error !== null && (error as { code?: unknown }).code === "P2002")
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Workflow step failed";
}

@Injectable()
export class OrchestrationService {
  public constructor(
    @Inject("DATABASE") private readonly db: Database,
    @Inject(WORKFLOW_QUEUE_PORT) private readonly queue: WorkflowQueuePort,
    @Inject(WORKFLOW_STEP_DISPATCHER) private readonly dispatcher: WorkflowStepDispatcherPort,
    @Inject(WORKFLOW_BUDGET_POLICY) private readonly budget: BudgetPolicyPort,
    private readonly limits: WorkflowLimitsService,
    private readonly channels: ChannelService,
    private readonly quality: QualityService,
    @Inject(ORCHESTRATION_CLOCK) private readonly clock: () => Date,
  ) {}

  /** Releases the queue connection owned by this service. */
  public async close(): Promise<void> {
    await this.queue.close();
  }

  public async startManualRun(context: WorkspaceContext, body: unknown): Promise<WorkflowRunView> {
    this.requireEditor(context);
    const request = parseManualRunBody(body);
    const input = manualRunInput(request);
    const channelId = typeof input["channelId"] === "string" ? input["channelId"] : null;
    if (channelId !== null) {
      const channel = await this.channels.get(context, channelId);
      if (channel.status === "ARCHIVED") throw new BadRequestException("Channel is archived");
      if (channel.status !== "ACTIVE")
        throw new ConflictException("Channel is paused; resume the channel before starting a run");
    }
    const budget = await this.budget.evaluate({
      workspaceId: context.workspaceId,
      channelId,
      definitionKey: request.definitionKey,
      trigger: "MANUAL",
    });
    if (budget.decision === "BLOCKED")
      throw new ConflictException(
        `Budget policy blocked the manual run: ${budget.reason ?? "BUDGET_BLOCKED"}`,
      );
    const idempotencyKey = request.idempotencyKey ?? `manual:${randomUUID()}`;
    const existing = await this.db.workflowRun.findUnique({
      where: { workspaceId_idempotencyKey: { workspaceId: context.workspaceId, idempotencyKey } },
      select: { id: true },
    });
    if (existing) return this.getRun(context, existing.id);
    const runParams = {
      workspaceId: context.workspaceId,
      channelId,
      definitionKey: request.definitionKey,
      trigger: "MANUAL",
      triggeredByUserId: context.userId,
      input,
      idempotencyKey,
      state: "QUEUED",
      budgetDecision: budget.decision,
      budgetReason: budget.reason,
      pausedReason: null,
      nextAction: null,
      dispatchFirst: this.queue.status === "CONFIGURED",
    } as const;
    let run: RunRecord;
    try {
      run = await this.createRun(runParams);
    } catch (error) {
      // Two requests raced on the same idempotency key: return the run that won.
      if (!isUniqueViolation(error)) throw error;
      const winner = await this.db.workflowRun.findUnique({
        where: { workspaceId_idempotencyKey: { workspaceId: context.workspaceId, idempotencyKey } },
        select: { id: true },
      });
      if (!winner) throw error;
      return this.getRun(context, winner.id);
    }
    await this.recordEvent(run, "WORKFLOW_RUN_CREATED", {
      definitionKey: run.definitionKey,
      trigger: run.trigger,
      budgetDecision: run.budgetDecision,
    });
    if (this.queue.status === "CONFIGURED") {
      const first = run.steps[0];
      if (first) await this.enqueueCurrent(run, first);
    }
    return this.getRun(context, run.id);
  }

  public async listRuns(context: WorkspaceContext): Promise<WorkflowRunView[]> {
    const runs = await this.db.workflowRun.findMany({
      where: { workspaceId: context.workspaceId },
      include: runInclude,
      orderBy: { createdAt: "desc" },
      take: 100,
    });
    return runs.map((run) => this.presentRun(run));
  }

  /**
   * @internal Cross-workspace strict keyset read (rows after `(at, id)` in `(timestamp, id)` order) of run history events for the M17 notification
   * intake only. Read-only; never expose it through a controller or call it with a user context.
   */
  public async listEventsAfter(query: {
    readonly eventTypes: readonly string[];
    readonly after: Readonly<{ at: Date; id: string }> | null;
    readonly until: Date;
    readonly limit: number;
  }): Promise<
    Array<{
      id: string;
      workspaceId: string;
      runId: string;
      channelId: string | null;
      eventType: string;
      correlationId: string;
      payload: WorkflowRunInput;
      occurredAt: Date;
    }>
  > {
    const events = await this.db.workflowEvent.findMany({
      where: {
        eventType: { in: [...query.eventTypes] },
        occurredAt: { lte: query.until },
        ...(query.after === null
          ? {}
          : {
              OR: [
                { occurredAt: { gt: query.after.at } },
                { occurredAt: query.after.at, id: { gt: query.after.id } },
              ],
            }),
      },
      include: { run: { select: { channelId: true } } },
      orderBy: [{ occurredAt: "asc" }, { id: "asc" }],
      take: query.limit,
    });
    return events.map((event) => ({
      id: event.id,
      workspaceId: event.workspaceId,
      runId: event.runId,
      channelId: event.run.channelId,
      eventType: event.eventType,
      correlationId: event.correlationId,
      payload: asRecord(event.payload),
      occurredAt: event.occurredAt,
    }));
  }

  /**
   * Read-only outcome counts of a channel's runs that completed in [from, to), for M17 reports.
   */
  public async countRunOutcomes(
    context: WorkspaceContext,
    channelId: string,
    from: Date,
    to: Date,
  ): Promise<{ byState: Record<string, number>; failedRunIds: string[] }> {
    const where = {
      workspaceId: context.workspaceId,
      channelId,
      completedAt: { gte: from, lt: to },
    } satisfies Prisma.WorkflowRunWhereInput;
    const [groups, failed] = await Promise.all([
      this.db.workflowRun.groupBy({ by: ["state"], where, _count: { _all: true } }),
      this.db.workflowRun.findMany({
        where: { ...where, state: "FAILED" },
        select: { id: true },
        orderBy: [{ completedAt: "asc" }, { id: "asc" }],
        take: 50,
      }),
    ]);
    const byState: Record<string, number> = {};
    for (const group of groups) byState[group.state] = group._count._all;
    return { byState, failedRunIds: failed.map((run) => run.id) };
  }

  public async getRun(context: WorkspaceContext, runId: string): Promise<WorkflowRunView> {
    const id = parseRunId(runId);
    const run = await this.db.workflowRun.findUnique({
      where: { workspaceId_id: { workspaceId: context.workspaceId, id } },
      include: runInclude,
    });
    if (!run) throw new NotFoundException("Workflow run not found");
    return this.presentRun(run);
  }

  public async cancelRun(context: WorkspaceContext, runId: string): Promise<WorkflowRunView> {
    this.requireEditor(context);
    const id = parseRunId(runId);
    const run = await this.db.workflowRun.findUnique({
      where: { workspaceId_id: { workspaceId: context.workspaceId, id } },
      select: { id: true, state: true },
    });
    if (!run) throw new NotFoundException("Workflow run not found");
    if (run.state === "CANCELED") return this.getRun(context, id);
    if (run.state === "SUCCEEDED")
      throw new ConflictException("Cannot cancel a succeeded workflow run");
    if (!CANCELABLE_RUN_STATES.includes(run.state) && run.state !== "FAILED")
      throw new ConflictException(`Cannot cancel a ${run.state.toLowerCase()} workflow run`);
    const now = this.now();
    // Compare-and-swap on the observed state: a concurrent retry/resume/worker transition wins
    // and this cancel returns 409 instead of silently overriding it.
    const canceled = await this.db.workflowRun.updateMany({
      where: {
        workspaceId: context.workspaceId,
        id,
        state: run.state,
      },
      data: {
        state: "CANCELED",
        completedAt: now,
        nextAction: null,
        currentStepKey: null,
        pausedReason: null,
      },
    });
    if (canceled.count === 0) throw new ConflictException("Workflow run state changed");
    await this.db.$transaction([
      this.db.workflowStep.updateMany({
        where: {
          workspaceId: context.workspaceId,
          runId: id,
          status: { in: [...ACTIVE_STEP_STATES, "FAILED"] },
        },
        data: { status: "CANCELED", leaseOwner: null, leaseExpiresAt: null, completedAt: now },
      }),
      this.db.workflowJob.updateMany({
        where: {
          workspaceId: context.workspaceId,
          runId: id,
          status: { in: [...ACTIVE_JOB_STATES] },
        },
        data: { status: "CANCELED", completedAt: now },
      }),
    ]);
    await this.recordEventById(context.workspaceId, id, "WORKFLOW_RUN_CANCELED", {});
    return this.getRun(context, id);
  }

  public async retryFromFailedStep(
    context: WorkspaceContext,
    runId: string,
  ): Promise<WorkflowRunView> {
    this.requireEditor(context);
    const id = parseRunId(runId);
    const run = await this.db.workflowRun.findUnique({
      where: { workspaceId_id: { workspaceId: context.workspaceId, id } },
      include: { steps: { orderBy: { sequence: "asc" } } },
    });
    if (!run) throw new NotFoundException("Workflow run not found");
    if (run.state !== "FAILED")
      throw new ConflictException("Only a failed workflow run can retry from its failed step");
    const failedStep = run.steps.find(
      (step) => step.status === "FAILED" || step.status === "RECONCILIATION_REQUIRED",
    );
    if (!failedStep) throw new ConflictException("No failed workflow step exists to retry");
    const now = this.now();
    const resumed = await this.db.workflowRun.updateMany({
      where: {
        workspaceId: context.workspaceId,
        id,
        state: { in: transitionFrom("RUN", ["FAILED"], "QUEUED") },
      },
      data: {
        state: "QUEUED",
        lastErrorCode: null,
        lastErrorMessage: null,
        nextAction: "Retry requested from failed step",
        currentStepKey: failedStep.stepKey,
        completedAt: null,
      },
    });
    if (resumed.count === 0) throw new ConflictException("Workflow run state changed");
    const reset = await this.db.workflowStep.updateMany({
      where: {
        workspaceId: context.workspaceId,
        id: failedStep.id,
        status: { in: transitionFrom("STEP", ["FAILED", "RECONCILIATION_REQUIRED"], "QUEUED") },
      },
      data: {
        status: "QUEUED",
        attempts: 0,
        limitWaits: 0,
        externalPolls: 0,
        externalDeadlineAt: null,
        retryGeneration: { increment: 1 },
        errorCode: null,
        errorMessage: null,
        leaseOwner: null,
        leaseExpiresAt: null,
        nextAttemptAt: now,
        completedAt: null,
      },
    });
    if (reset.count === 0) throw new ConflictException("Workflow step state changed");
    const refreshed = await this.requireRun(context.workspaceId, id);
    const step = refreshed.steps.find((item) => item.id === failedStep.id);
    if (step) await this.enqueueCurrent(refreshed, step);
    await this.recordEventById(context.workspaceId, id, "WORKFLOW_RUN_RETRIED", {
      stepKey: failedStep.stepKey,
    });
    return this.getRun(context, id);
  }

  public async resumeRun(context: WorkspaceContext, runId: string): Promise<WorkflowRunView> {
    this.requireEditor(context);
    const id = parseRunId(runId);
    const run = await this.requireRun(context.workspaceId, id);
    const now = this.now();
    if (run.state === "WAITING_APPROVAL") {
      const waiting = run.steps.find((step) => step.status === "WAITING_APPROVAL");
      if (!waiting || waiting.resultRef === null)
        throw new ConflictException("No approval step is waiting to resume");
      const review = await this.quality.get(context, waiting.resultRef);
      if (review.status === "APPROVED" || review.status === "AUTO_APPROVED") {
        // Approval completes the step, moves the run and queues the next step atomically.
        const outcome = await this.completeAndAdvance({
          run,
          step: waiting,
          guard: { workspaceId: context.workspaceId, id: waiting.id, status: "WAITING_APPROVAL" },
          targetState: "SUCCEEDED",
          resultRef: waiting.resultRef,
          resultType: waiting.resultType,
          mergedInput: asRecord(run.input),
          jobId: null,
          jobRowId: null,
          skipped: false,
          now,
          runFrom: ["WAITING_APPROVAL"],
          extraEvent: {
            type: "WORKFLOW_APPROVAL_GRANTED",
            payload: {
              stepKey: waiting.stepKey,
              qualityReviewRunId: waiting.resultRef,
              qualityStatus: review.status,
            },
          },
        });
        if (outcome === "RACED") throw new ConflictException("Workflow step state changed");
        return this.getRun(context, id);
      }
      if (
        review.status === "REJECTED" ||
        review.status === "CHANGES_REQUESTED" ||
        review.status === "BLOCKED"
      ) {
        await this.db.workflowStep.updateMany({
          where: { workspaceId: context.workspaceId, id: waiting.id, status: "WAITING_APPROVAL" },
          data: { status: "FAILED", errorCode: "QUALITY_REJECTED", completedAt: now },
        });
        await this.db.workflowRun.updateMany({
          where: { workspaceId: context.workspaceId, id, state: "WAITING_APPROVAL" },
          data: {
            state: "FAILED",
            lastErrorCode: "QUALITY_REJECTED",
            lastErrorMessage: `Quality review is ${review.status.toLowerCase()}`,
            completedAt: now,
            nextAction: "Reject the run or create a new workflow run",
          },
        });
        throw new ConflictException(`Quality review is ${review.status.toLowerCase()}`);
      }
      throw new ConflictException("Quality approval is still pending");
    }
    if (run.state !== "PAUSED")
      throw new ConflictException("Only a paused or approval-waiting workflow run can resume");
    if (run.channelId !== null) {
      const channel = await this.channels.get(context, run.channelId);
      if (channel.status !== "ACTIVE")
        throw new ConflictException("Channel must be active before the run can resume");
    }
    if (run.trigger === "SCHEDULED") {
      const budget = await this.budget.evaluate({
        workspaceId: run.workspaceId,
        channelId: run.channelId,
        definitionKey: run.definitionKey,
        trigger: "SCHEDULED",
      });
      if (budget.decision !== "ALLOWED")
        throw new ConflictException(
          `Scheduled run cannot resume: ${budget.reason ?? "BUDGET_POLICY_UNAVAILABLE"}`,
        );
    }
    const resumed = await this.db.workflowRun.updateMany({
      where: { workspaceId: context.workspaceId, id, state: "PAUSED" },
      data: { state: "QUEUED", pausedReason: null, nextAction: null, completedAt: null },
    });
    if (resumed.count === 0) throw new ConflictException("Workflow run state changed");
    const pending = run.steps.find(
      (step) =>
        step.status === "PENDING" ||
        step.status === "QUEUED" ||
        step.status === "RETRY_WAIT" ||
        step.status === "FAILED" ||
        step.status === "RECONCILIATION_REQUIRED",
    );
    if (!pending) {
      await this.db.workflowRun.updateMany({
        where: { workspaceId: context.workspaceId, id, state: "QUEUED" },
        data: { state: "SUCCEEDED", completedAt: now },
      });
      return this.getRun(context, id);
    }
    await this.db.workflowStep.updateMany({
      where: {
        workspaceId: context.workspaceId,
        id: pending.id,
        status: {
          in: ["PENDING", "QUEUED", "RETRY_WAIT", "FAILED", "RECONCILIATION_REQUIRED"],
        },
      },
      data: {
        status: "QUEUED",
        attempts: 0,
        limitWaits: 0,
        externalPolls: 0,
        externalDeadlineAt: null,
        retryGeneration: { increment: 1 },
        errorCode: null,
        errorMessage: null,
        leaseOwner: null,
        leaseExpiresAt: null,
        nextAttemptAt: now,
        completedAt: null,
      },
    });
    const refreshed = await this.requireRun(context.workspaceId, id);
    const step = refreshed.steps.find((item) => item.id === pending.id);
    if (step) await this.enqueueCurrent(refreshed, step);
    await this.recordEventById(context.workspaceId, id, "WORKFLOW_RUN_RESUMED", {
      stepKey: pending.stepKey,
    });
    return this.getRun(context, id);
  }

  /** Reports the queue adapter state for /health: CONFIGURED, NOT_CONFIGURED, or UNREACHABLE. */
  public async queueHealth(): Promise<WorkflowQueueHealth> {
    return this.queue.health();
  }

  public async processJob(
    payload: WorkflowQueueJob,
    workerId: string,
  ): Promise<WorkflowJobProcessResult> {
    const now = this.now();
    const run = await this.db.workflowRun.findUnique({
      where: { workspaceId_id: { workspaceId: payload.workspaceId, id: payload.runId } },
      include: runInclude,
    });
    if (!run) return this.noop(payload, "run not found");
    const step = run.steps.find((item) => item.id === payload.stepId);
    if (!step) return this.noop(payload, "step not found");
    if (step.status === "SUCCEEDED" || step.status === "SKIPPED")
      return this.noop(payload, "step already completed");
    if (run.state === "SUCCEEDED" || run.state === "FAILED")
      return this.noop(payload, `run is ${run.state}`);
    if (run.state === "CANCELED") {
      await this.markJobCanceled(run.workspaceId, step.id, now);
      return this.noop(payload, "run canceled");
    }
    if (run.state === "PAUSED") return { ...this.noop(payload, "run paused"), status: "PAUSED" };
    if (!CLAIMABLE_STEP_STATES.includes(step.status))
      return this.noop(payload, `step is ${step.status}`);
    // Only the job id the step currently expects may claim it; older deliveries are superseded.
    if (payload.jobId !== this.expectedJobId(run.id, step))
      return this.noop(payload, "superseded job");
    const due = new Date(now.getTime() + CLAIM_SKEW_MS);
    if (step.nextAttemptAt !== null && step.nextAttemptAt.getTime() > due.getTime())
      return this.noop(payload, "step is not due yet");
    const fromState = step.status;
    const fromExternal = fromState === "WAITING_EXTERNAL";
    const config = this.limits.limits();
    const claimed = await this.db.workflowStep.updateMany({
      where: {
        workspaceId: run.workspaceId,
        id: step.id,
        status: { in: transitionFrom("STEP", [fromState], "RUNNING") },
        attempts: step.attempts,
        retryGeneration: step.retryGeneration,
        limitWaits: step.limitWaits,
        externalPolls: step.externalPolls,
        AND: [
          { OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lt: now } }] },
          { OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: due } }] },
        ],
      },
      data: {
        status: "RUNNING",
        leaseOwner: workerId,
        leaseExpiresAt: new Date(now.getTime() + config.stepLeaseTtlMs),
        startedAt: step.startedAt ?? now,
        // Re-checking external work (a poll) never consumes an attempt.
        ...(fromExternal ? {} : { attempts: { increment: 1 } }),
        errorCode: null,
        errorMessage: null,
        nextAttemptAt: null,
      },
    });
    if (claimed.count === 0) return this.noop(payload, "step claim lost");
    const attempt = fromExternal ? step.attempts : step.attempts + 1;
    const claimedStep: StepRecord = { ...step, status: "RUNNING", attempts: attempt };
    // Every write from here on is fenced by this worker's lease and attempt (B2).
    const guard: Prisma.WorkflowStepWhereInput = {
      workspaceId: run.workspaceId,
      id: step.id,
      status: "RUNNING",
      leaseOwner: workerId,
      attempts: attempt,
    };
    const actor = await this.actorFor(run);
    if (actor === null) {
      await this.failStep(run, claimedStep, guard, null, now, {
        code: "NO_WORKSPACE_ACTOR",
        message: "No workspace member can act for this run",
        retryable: false,
        reconciliationRequired: false,
      });
      return { status: "FAILED", runId: run.id, stepId: step.id, detail: "no actor" };
    }
    const definition = stepDefinition(run.definitionKey, step.stepKey as WorkflowStepKey);
    const provider = definition?.provider ?? "internal";
    const leases = await this.acquireLimits(run, claimedStep, provider, now, payload.jobId);
    if (leases === null) return this.limitWait(run, claimedStep, guard, fromState, now);
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    try {
      await this.db.workflowRun.updateMany({
        where: {
          workspaceId: run.workspaceId,
          id: run.id,
          state: { in: transitionFrom("RUN", ["QUEUED", "RETRY_WAIT"], "RUNNING") },
        },
        data: { state: "RUNNING", currentStepKey: step.stepKey, startedAt: run.startedAt ?? now },
      });
      const jobRow = await this.db.workflowJob.upsert({
        where: { workspaceId_jobId: { workspaceId: run.workspaceId, jobId: payload.jobId } },
        create: {
          id: randomUUID(),
          workspaceId: run.workspaceId,
          runId: run.id,
          stepId: step.id,
          jobId: payload.jobId,
          queueName: ORCHESTRATION_QUEUE_NAME,
          attempt,
          status: "RUNNING",
          payload: payload as unknown as Prisma.InputJsonValue,
          startedAt: now,
        },
        update: { status: "RUNNING", startedAt: now, errorCode: null, errorMessage: null },
        select: { id: true },
      });
      await this.recordEvent(
        run,
        fromExternal ? "WORKFLOW_STEP_POLLED" : "WORKFLOW_STEP_STARTED",
        { stepKey: step.stepKey, attempt, jobId: payload.jobId, workerId },
        step.id,
        jobRow.id,
      );
      heartbeat = this.startHeartbeat(guard);
      let result: WorkflowStepDispatchResult;
      try {
        result = await this.dispatcher.dispatchStep({
          context: { workspaceId: run.workspaceId, userId: actor.userId, role: actor.role },
          runId: run.id,
          stepId: step.id,
          stepKey: step.stepKey as WorkflowStepKey,
          definitionKey: run.definitionKey,
          trigger: run.trigger,
          correlationId: run.correlationId,
          idempotencyKey: step.idempotencyKey,
          attempt,
          input: asRecord(run.input),
          previousResultRef: step.resultRef,
        });
      } catch (error) {
        clearInterval(heartbeat);
        heartbeat = undefined;
        return await this.handleFailure(
          run,
          claimedStep,
          guard,
          payload.jobId,
          now,
          this.classify(error, claimedStep),
        );
      }
      clearInterval(heartbeat);
      heartbeat = undefined;
      // Step completion and advancing are no longer inside the failure path (B4): an error
      // here leaves the step RUNNING for lease recovery and the sweep, never marks it FAILED.
      return await this.applyResult(run, claimedStep, guard, payload, jobRow.id, result, now);
    } finally {
      if (heartbeat) clearInterval(heartbeat);
      await this.releaseLimits(run.workspaceId, leases);
    }
  }

  /**
   * Recovery sweep (B4), run by every worker tick. Re-enqueues work that is due but has no live
   * queue job: QUEUED/RETRY_WAIT/WAITING_EXTERNAL steps whose due time is older than the stall
   * grace (lost Redis jobs, enqueue failures), and the next PENDING step of an active run with no
   * active step (a crash between completion and advance, or a run created while the queue was
   * NOT_CONFIGURED). Uses the same deterministic job id, so a still-pending job is a DUPLICATE.
   */
  public async reconcileStalledWork(
    now: Date = this.now(),
    options: { readonly workspaceId?: string } = {},
  ): Promise<number> {
    if (this.queue.status !== "CONFIGURED") return 0;
    const config = this.limits.limits();
    const grace = new Date(now.getTime() - config.stallGraceMs);
    const scope = options.workspaceId === undefined ? {} : { workspaceId: options.workspaceId };
    let redispatched = 0;
    const stalled = await this.db.workflowStep.findMany({
      where: {
        ...scope,
        status: { in: ["QUEUED", "RETRY_WAIT", "WAITING_EXTERNAL"] },
        run: { state: { in: ["QUEUED", "RUNNING", "RETRY_WAIT"] } },
        AND: [
          { OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lt: now } }] },
          {
            OR: [
              { nextAttemptAt: { lt: grace } },
              { nextAttemptAt: null, updatedAt: { lt: grace } },
              {
                run: { dispatchStatus: "NOT_CONFIGURED" },
                OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }],
              },
            ],
          },
        ],
      },
      include: { run: { select: { id: true, workspaceId: true, correlationId: true } } },
      orderBy: { updatedAt: "asc" },
      take: 100,
    });
    for (const step of stalled) {
      if ((await this.enqueueCurrent(step.run, step)) === "ENQUEUED") redispatched += 1;
    }
    const idle = await this.db.workflowRun.findMany({
      where: {
        ...scope,
        state: { in: ["QUEUED", "RUNNING", "RETRY_WAIT"] },
        OR: [{ updatedAt: { lt: grace } }, { dispatchStatus: "NOT_CONFIGURED" }],
        steps: {
          none: {
            status: {
              in: ["QUEUED", "RUNNING", "RETRY_WAIT", "WAITING_EXTERNAL", "WAITING_APPROVAL"],
            },
          },
        },
      },
      include: { steps: { orderBy: { sequence: "asc" } } },
      orderBy: { updatedAt: "asc" },
      take: 100,
    });
    for (const run of idle) {
      const next = run.steps.find(
        (item) => item.status !== "SUCCEEDED" && item.status !== "SKIPPED",
      );
      if (!next) {
        const finished = await this.db.workflowRun.updateMany({
          where: {
            workspaceId: run.workspaceId,
            id: run.id,
            state: { in: transitionFrom("RUN", ["QUEUED", "RUNNING", "RETRY_WAIT"], "SUCCEEDED") },
          },
          data: { state: "SUCCEEDED", currentStepKey: null, nextAction: null, completedAt: now },
        });
        if (finished.count > 0)
          await this.recordEventById(run.workspaceId, run.id, "WORKFLOW_RUN_SUCCEEDED", {
            recoveredBy: "sweep",
          });
        continue;
      }
      if (next.status !== "PENDING") continue;
      const promoted = await this.db.$transaction(async (tx) => {
        const queued = await tx.workflowStep.updateMany({
          where: {
            workspaceId: run.workspaceId,
            id: next.id,
            status: { in: transitionFrom("STEP", ["PENDING"], "QUEUED") },
          },
          data: { status: "QUEUED", nextAttemptAt: null },
        });
        if (queued.count === 0) return false;
        await tx.workflowRun.updateMany({
          where: { workspaceId: run.workspaceId, id: run.id, state: run.state },
          data: { currentStepKey: next.stepKey, nextAction: null },
        });
        await tx.workflowEvent.create({
          data: this.eventData(run, "WORKFLOW_STEP_QUEUED", { stepKey: next.stepKey }, next.id),
        });
        return true;
      });
      if (!promoted) continue;
      if ((await this.enqueueCurrent(run, next)) === "ENQUEUED") redispatched += 1;
    }
    return redispatched;
  }

  /** Kept for callers of the phase-1 API; the recovery sweep covers undispatched runs. */
  public async dispatchUndispatchedRuns(
    options: { readonly workspaceId?: string } = {},
  ): Promise<number> {
    return this.reconcileStalledWork(this.now(), options);
  }

  public async recoverStaleLeases(
    now: Date = this.now(),
    options: { readonly workspaceId?: string } = {},
  ): Promise<number> {
    const stale = await this.db.workflowStep.findMany({
      where: {
        status: "RUNNING",
        leaseExpiresAt: { lt: now },
        ...(options.workspaceId === undefined ? {} : { workspaceId: options.workspaceId }),
      },
      orderBy: { leaseExpiresAt: "asc" },
      take: 100,
    });
    let recovered = 0;
    for (const step of stale) {
      const run = await this.db.workflowRun.findUnique({
        where: { workspaceId_id: { workspaceId: step.workspaceId, id: step.runId } },
        select: { id: true, workspaceId: true, correlationId: true, state: true },
      });
      if (!run) continue;
      // A crashed external poll was only a read: go back to waiting. A crashed side effect may
      // have happened, so it needs reconciliation. Anything else retries.
      const pollOnly = step.externalPolls > 0;
      const reconciliation = !pollOnly && (step.sideEffect || step.attempts >= step.maxAttempts);
      const nextState = pollOnly
        ? "WAITING_EXTERNAL"
        : reconciliation
          ? "RECONCILIATION_REQUIRED"
          : "RETRY_WAIT";
      const nextAttemptAt = reconciliation
        ? null
        : new Date(now.getTime() + (pollOnly ? 0 : this.limits.limits().retryBaseDelayMs));
      const updated = await this.db.workflowStep.updateMany({
        where: {
          workspaceId: step.workspaceId,
          id: step.id,
          status: { in: transitionFrom("STEP", ["RUNNING"], nextState) },
          leaseOwner: step.leaseOwner,
          attempts: step.attempts,
          leaseExpiresAt: { lt: now },
        },
        data: {
          status: nextState,
          leaseOwner: null,
          leaseExpiresAt: null,
          nextAttemptAt,
          ...(pollOnly ? { externalPolls: { increment: 1 } } : {}),
          errorCode: "STALE_LEASE",
          errorMessage: "The step lease expired before completion",
        },
      });
      if (updated.count === 0) continue;
      await this.db.workflowJob.updateMany({
        where: { workspaceId: step.workspaceId, stepId: step.id, status: "RUNNING" },
        data: {
          status: reconciliation ? "FAILED" : "RETRY_WAIT",
          errorCode: "STALE_LEASE",
          errorMessage: "The step lease expired before completion",
        },
      });
      if (!pollOnly)
        await this.db.workflowRun.updateMany({
          where: {
            workspaceId: step.workspaceId,
            id: step.runId,
            state: {
              in: transitionFrom(
                "RUN",
                ["QUEUED", "RUNNING", "RETRY_WAIT"],
                reconciliation ? "FAILED" : "RETRY_WAIT",
              ),
            },
          },
          data: {
            state: reconciliation ? "FAILED" : "RETRY_WAIT",
            lastErrorCode: "STALE_LEASE",
            lastErrorMessage: "A workflow step lease expired",
            nextAction: reconciliation
              ? "Reconcile the external side effect, then retry from the failed step"
              : "The step will retry automatically",
            ...(reconciliation ? { completedAt: now } : {}),
          },
        });
      await this.recordEventById(
        step.workspaceId,
        step.runId,
        reconciliation ? "WORKFLOW_STEP_RECONCILIATION_REQUIRED" : "WORKFLOW_STEP_RETRY_WAIT",
        { stepKey: step.stepKey, attempts: step.attempts, code: "STALE_LEASE" },
        step.id,
      );
      if (!reconciliation) {
        const refreshed = await this.db.workflowStep.findUnique({
          where: { workspaceId_id: { workspaceId: step.workspaceId, id: step.id } },
        });
        if (refreshed)
          await this.enqueueCurrent(
            run,
            refreshed,
            pollOnly ? 0 : this.limits.limits().retryBaseDelayMs,
          );
      }
      recovered += 1;
    }
    return recovered;
  }

  public async runSchedulerTick(now: Date = this.now()): Promise<WorkflowSchedulerTickResult> {
    const channels = await this.channels.listSchedulerCandidates();
    const from = new Date(now.getTime() - schedulerWindowMs);
    let dueSlots = 0;
    let startedRuns = 0;
    let skippedSlots = 0;
    for (const channel of channels) {
      const schedule = parseChannelSchedule(channel.schedule, channel.timezone, "GENERATION");
      if (!schedule) continue;
      const occurrences = dueScheduleOccurrences(schedule, from, now);
      for (const occurrence of occurrences) {
        dueSlots += 1;
        const claimed = await this.claimSlot(channel, occurrence);
        if (!claimed) continue;
        if (channel.status !== "ACTIVE") {
          await this.skipSlot(
            channel.workspaceId,
            claimed.id,
            channel.status === "ARCHIVED" ? "CHANNEL_ARCHIVED" : "CHANNEL_PAUSED",
          );
          skippedSlots += 1;
          continue;
        }
        const scheduledInput = this.validScheduleInput(channel, occurrence, schedule.input);
        if (scheduledInput === null) {
          await this.skipSlot(channel.workspaceId, claimed.id, "INVALID_SCHEDULE_INPUT");
          skippedSlots += 1;
          continue;
        }
        // Without an allowing budget policy no run is created at all, so nothing counts toward
        // maxRunsPerDay and nothing waits to be resumed.
        let budget: Awaited<ReturnType<BudgetPolicyPort["evaluate"]>>;
        try {
          budget = await this.budget.evaluate({
            workspaceId: channel.workspaceId,
            channelId: channel.id,
            definitionKey: occurrence.definitionKey,
            trigger: "SCHEDULED",
          });
        } catch {
          // A policy error must not leave the slot CLAIMED forever with no run (fail closed).
          await this.skipSlot(channel.workspaceId, claimed.id, "BUDGET_POLICY_ERROR");
          skippedSlots += 1;
          continue;
        }
        if (budget.decision !== "ALLOWED") {
          await this.skipSlot(
            channel.workspaceId,
            claimed.id,
            budget.decision === "NOT_CONFIGURED"
              ? "BUDGET_POLICY_UNAVAILABLE"
              : (budget.reason ?? "BUDGET_BLOCKED"),
          );
          skippedSlots += 1;
          continue;
        }
        const runsToday = await this.db.workflowScheduleSlot.count({
          where: {
            workspaceId: channel.workspaceId,
            channelId: channel.id,
            localDate: occurrence.localDate,
            status: "STARTED",
          },
        });
        if (runsToday >= schedule.maxRunsPerDay) {
          await this.skipSlot(channel.workspaceId, claimed.id, "MAX_RUNS_PER_DAY");
          skippedSlots += 1;
          continue;
        }
        const actor = await this.ownerFor(channel.workspaceId);
        if (actor === null) {
          await this.skipSlot(channel.workspaceId, claimed.id, "NO_WORKSPACE_ACTOR");
          skippedSlots += 1;
          continue;
        }
        const run = await this.startScheduledRun(
          channel,
          occurrence,
          scheduledInput,
          actor,
          budget,
        );
        await this.db.workflowScheduleSlot.update({
          where: { workspaceId_id: { workspaceId: channel.workspaceId, id: claimed.id } },
          data: { status: "STARTED", runId: run.id },
        });
        if (run.state === "QUEUED" || run.state === "RUNNING" || run.state === "WAITING_APPROVAL")
          startedRuns += 1;
        else skippedSlots += 1;
      }
      await this.db.workflowSchedulerCursor.upsert({
        where: {
          workspaceId_channelId: { workspaceId: channel.workspaceId, channelId: channel.id },
        },
        create: {
          id: randomUUID(),
          workspaceId: channel.workspaceId,
          channelId: channel.id,
          lastSlotKey: occurrences[0]?.slotKey ?? null,
          lastEvaluatedAt: now,
        },
        update: {
          lastSlotKey: occurrences[0]?.slotKey ?? null,
          lastEvaluatedAt: now,
        },
      });
    }
    return { evaluatedChannels: channels.length, dueSlots, startedRuns, skippedSlots };
  }

  /** Scheduled runs get the same input validation as manual runs (definition rules included). */
  private validScheduleInput(
    channel: WorkflowSchedulerChannel,
    occurrence: WorkflowScheduleOccurrence,
    scheduleInput: Readonly<Record<string, unknown>>,
  ): WorkflowRunInput | null {
    const rest: Record<string, unknown> = { ...scheduleInput };
    delete rest["idempotencyKey"];
    try {
      return manualRunInput(
        parseManualRunBody({
          ...rest,
          definitionKey: occurrence.definitionKey,
          channelId: channel.id,
        }),
      );
    } catch {
      return null;
    }
  }

  private async startScheduledRun(
    channel: WorkflowSchedulerChannel,
    occurrence: WorkflowScheduleOccurrence,
    input: WorkflowRunInput,
    actorUserId: string,
    budget: Readonly<{ decision: "ALLOWED" | "BLOCKED" | "NOT_CONFIGURED"; reason: string | null }>,
  ): Promise<RunRecord> {
    const run = await this.createRun({
      workspaceId: channel.workspaceId,
      channelId: channel.id,
      definitionKey: occurrence.definitionKey,
      trigger: "SCHEDULED",
      triggeredByUserId: actorUserId,
      input,
      idempotencyKey: `scheduled:${channel.id}:${occurrence.slotKey}`,
      state: "QUEUED",
      budgetDecision: budget.decision,
      budgetReason: budget.reason,
      pausedReason: null,
      nextAction: null,
      dispatchFirst: this.queue.status === "CONFIGURED",
    });
    await this.recordEvent(run, "WORKFLOW_RUN_CREATED", {
      definitionKey: run.definitionKey,
      trigger: run.trigger,
      slotKey: occurrence.slotKey,
      budgetDecision: run.budgetDecision,
    });
    if (this.queue.status === "CONFIGURED") {
      const first = run.steps[0];
      if (first) await this.enqueueCurrent(run, first);
    }
    return run;
  }

  private async createRun(params: {
    workspaceId: string;
    channelId: string | null;
    definitionKey: WorkflowDefinition;
    trigger: "MANUAL" | "SCHEDULED";
    triggeredByUserId: string;
    input: WorkflowRunInput;
    idempotencyKey: string;
    state: WorkflowRunState;
    budgetDecision: "ALLOWED" | "BLOCKED" | "NOT_CONFIGURED";
    budgetReason: string | null;
    pausedReason: string | null;
    nextAction: string | null;
    dispatchFirst: boolean;
  }): Promise<RunRecord> {
    const now = this.now();
    const runId = randomUUID();
    const correlationId = randomUUID();
    const steps: Prisma.WorkflowStepCreateWithoutRunInput[] = workflowDefinition(
      params.definitionKey,
    ).map((definition, index) => ({
      id: randomUUID(),
      workspace: { connect: { id: params.workspaceId } },
      stepKey: definition.key,
      sequence: definition.sequence,
      status: params.dispatchFirst && index === 0 ? "QUEUED" : "PENDING",
      attempts: 0,
      maxAttempts: definition.maxAttempts,
      sideEffect: definition.sideEffect,
      idempotencyKey: stepIdempotencyKey(params.definitionKey, runId, definition.key),
    }));
    await this.db.workflowRun.create({
      data: {
        id: runId,
        workspaceId: params.workspaceId,
        channelId: params.channelId,
        correlationId,
        idempotencyKey: params.idempotencyKey,
        definitionKey: params.definitionKey,
        trigger: params.trigger,
        triggeredByUserId: params.triggeredByUserId,
        state: params.state,
        dispatchStatus: "NOT_CONFIGURED",
        budgetDecision: params.budgetDecision,
        budgetReason: params.budgetReason,
        input: params.input as unknown as Prisma.InputJsonValue,
        nextAction:
          params.nextAction ??
          (this.queue.status === "NOT_CONFIGURED" && params.state === "QUEUED"
            ? "Configure REDIS_URL to dispatch workflow jobs"
            : null),
        pausedReason: params.pausedReason,
        currentStepKey: params.dispatchFirst ? firstStep(params.definitionKey).key : null,
        createdAt: now,
        steps: { create: steps },
      },
    });
    return this.db.workflowRun.findUniqueOrThrow({
      where: { workspaceId_id: { workspaceId: params.workspaceId, id: runId } },
      include: runInclude,
    });
  }
  private async applyResult(
    run: RunRecord,
    step: StepRecord,
    guard: Prisma.WorkflowStepWhereInput,
    payload: WorkflowQueueJob,
    jobRowId: string,
    result: WorkflowStepDispatchResult,
    now: Date,
  ): Promise<WorkflowJobProcessResult> {
    const mergedInput = { ...asRecord(run.input), ...(result.output ?? {}) };
    if (result.waitingExternal) return this.waitExternal(run, step, guard, payload, result, now);
    if (result.waitingApproval) {
      const applied = await this.db.$transaction(async (tx) => {
        const waiting = await tx.workflowStep.updateMany({
          where: guard,
          data: {
            status: "WAITING_APPROVAL",
            resultRef: result.resultRef,
            resultType: result.resultType,
            leaseOwner: null,
            leaseExpiresAt: null,
            completedAt: null,
          },
        });
        if (waiting.count === 0) return false;
        await tx.workflowRun.updateMany({
          where: {
            workspaceId: run.workspaceId,
            id: run.id,
            state: {
              in: transitionFrom("RUN", ["QUEUED", "RUNNING", "RETRY_WAIT"], "WAITING_APPROVAL"),
            },
          },
          data: {
            state: "WAITING_APPROVAL",
            input: mergedInput as unknown as Prisma.InputJsonValue,
            currentStepKey: step.stepKey,
            nextAction: `Approve quality review ${result.resultRef} then resume`,
            pausedReason: null,
          },
        });
        await tx.workflowJob.updateMany({
          where: { workspaceId: run.workspaceId, jobId: payload.jobId },
          data: { status: "SUCCEEDED", completedAt: now },
        });
        await tx.workflowEvent.create({
          data: this.eventData(
            run,
            "WORKFLOW_APPROVAL_REQUESTED",
            { stepKey: step.stepKey, resultRef: result.resultRef },
            step.id,
            jobRowId,
          ),
        });
        return true;
      });
      if (!applied)
        return this.dispatchRaced(run.workspaceId, step.id, payload.jobId, now, result, payload);
      return {
        status: "WAITING_APPROVAL",
        runId: run.id,
        stepId: step.id,
        detail: result.resultRef,
      };
    }
    const outcome = await this.completeAndAdvance({
      run,
      step,
      guard,
      targetState: result.skipped ? "SKIPPED" : "SUCCEEDED",
      resultRef: result.resultRef,
      resultType: result.resultType,
      mergedInput,
      jobId: payload.jobId,
      jobRowId,
      skipped: result.skipped === true,
      now,
      runFrom: ["QUEUED", "RUNNING", "RETRY_WAIT"],
    });
    if (outcome === "RACED")
      return this.dispatchRaced(run.workspaceId, step.id, payload.jobId, now, result, payload);
    return { status: outcome, runId: run.id, stepId: step.id, detail: result.resultRef };
  }

  /**
   * B3: the domain record exists but is not finished (render queued/running, scene media still
   * generating, publish remote-processing). Persist its id on the run right away, park the step in
   * WAITING_EXTERNAL and re-check it every 15-60 s until the deadline. Polls never use attempts.
   */
  private async waitExternal(
    run: RunRecord,
    step: StepRecord,
    guard: Prisma.WorkflowStepWhereInput,
    payload: WorkflowQueueJob,
    result: WorkflowStepDispatchResult,
    now: Date,
  ): Promise<WorkflowJobProcessResult> {
    const waiting = result.waitingExternal;
    if (!waiting) throw new Error("waitExternal requires a waitingExternal result");
    const config = this.limits.limits();
    const definition = stepDefinition(run.definitionKey, step.stepKey as WorkflowStepKey);
    const deadline =
      step.externalDeadlineAt ??
      new Date(now.getTime() + (definition?.externalTimeoutMs ?? 60 * 60 * 1000));
    const mergedInput = { ...asRecord(run.input), ...(result.output ?? {}) };
    if (now.getTime() >= deadline.getTime()) {
      await this.db.workflowRun.updateMany({
        where: { workspaceId: run.workspaceId, id: run.id },
        data: { input: mergedInput as unknown as Prisma.InputJsonValue },
      });
      await this.failStep(run, step, guard, payload.jobId, now, {
        code: "EXTERNAL_WAIT_TIMEOUT",
        message: `External work did not finish before ${deadline.toISOString()}: ${waiting.reason}`,
        retryable: false,
        reconciliationRequired: true,
      });
      return {
        status: "RECONCILIATION_REQUIRED",
        runId: run.id,
        stepId: step.id,
        detail: "external wait timed out",
      };
    }
    const pollMs = Math.min(
      config.maxPollMs,
      Math.max(config.minPollMs, waiting.pollDelayMs ?? definition?.pollMs ?? config.minPollMs),
    );
    const nextAttemptAt = new Date(now.getTime() + pollMs);
    const applied = await this.db.$transaction(async (tx) => {
      const parked = await tx.workflowStep.updateMany({
        where: guard,
        data: {
          status: "WAITING_EXTERNAL",
          resultRef: result.resultRef,
          resultType: result.resultType,
          externalPolls: { increment: 1 },
          externalDeadlineAt: deadline,
          nextAttemptAt,
          leaseOwner: null,
          leaseExpiresAt: null,
        },
      });
      if (parked.count === 0) return null;
      await tx.workflowRun.updateMany({
        where: {
          workspaceId: run.workspaceId,
          id: run.id,
          state: { in: ["RUNNING", "RETRY_WAIT"] },
        },
        data: {
          state: "RUNNING",
          input: mergedInput as unknown as Prisma.InputJsonValue,
          nextAction: `Waiting for external work: ${waiting.reason}`,
        },
      });
      await tx.workflowJob.updateMany({
        where: { workspaceId: run.workspaceId, jobId: payload.jobId },
        data: { status: "SUCCEEDED", completedAt: now },
      });
      await tx.workflowEvent.create({
        data: this.eventData(
          run,
          "WORKFLOW_STEP_WAITING_EXTERNAL",
          {
            stepKey: step.stepKey,
            reason: waiting.reason,
            resultRef: result.resultRef,
            nextAttemptAt: nextAttemptAt.toISOString(),
            deadline: deadline.toISOString(),
          },
          step.id,
        ),
      });
      return tx.workflowStep.findUnique({
        where: { workspaceId_id: { workspaceId: run.workspaceId, id: step.id } },
      });
    });
    if (applied === null)
      return this.dispatchRaced(run.workspaceId, step.id, payload.jobId, now, result, payload);
    await this.enqueueCurrent(run, applied, pollMs);
    return { status: "WAITING_EXTERNAL", runId: run.id, stepId: step.id, detail: waiting.reason };
  }

  /** A concurrency or rate wait: give the claim back without spending an attempt. */
  private async limitWait(
    run: RunRecord,
    step: StepRecord,
    guard: Prisma.WorkflowStepWhereInput,
    fromState: WorkflowStepStatusValue,
    now: Date,
  ): Promise<WorkflowJobProcessResult> {
    const config = this.limits.limits();
    const delay = retryDelayMs(
      step.limitWaits + 1,
      config.retryBaseDelayMs,
      config.retryMaxDelayMs,
    );
    const nextAttemptAt = new Date(now.getTime() + delay);
    const reverted = await this.db.workflowStep.updateMany({
      where: { ...guard, status: { in: transitionFrom("STEP", ["RUNNING"], fromState) } },
      data: {
        status: fromState,
        ...(fromState === "WAITING_EXTERNAL" ? {} : { attempts: { decrement: 1 } }),
        limitWaits: { increment: 1 },
        nextAttemptAt,
        leaseOwner: null,
        leaseExpiresAt: null,
        errorCode: "WORKFLOW_LIMIT",
        errorMessage: "Workflow concurrency or rate limit reached",
      },
    });
    if (reverted.count === 0)
      return this.noop({ runId: run.id, stepId: step.id }, "step claim lost");
    await this.db.workflowRun.updateMany({
      where: {
        workspaceId: run.workspaceId,
        id: run.id,
        state: { in: ["QUEUED", "RUNNING", "RETRY_WAIT"] },
      },
      data: { nextAction: "Waiting for a concurrency or rate-limit slot" },
    });
    await this.recordEvent(
      run,
      "WORKFLOW_STEP_LIMIT_WAIT",
      {
        stepKey: step.stepKey,
        limitWaits: step.limitWaits + 1,
        nextAttemptAt: nextAttemptAt.toISOString(),
      },
      step.id,
    );
    const refreshed = await this.db.workflowStep.findUnique({
      where: { workspaceId_id: { workspaceId: run.workspaceId, id: step.id } },
    });
    if (refreshed) await this.enqueueCurrent(run, refreshed, delay);
    return { status: "LIMIT_WAIT", runId: run.id, stepId: step.id, detail: "limit reached" };
  }

  /**
   * B5 classification. Explicit WorkflowStepError wins. A 4xx HttpException or a validation error
   * is a domain refusal and never retried. Any other error on a side-effect step means the effect
   * may or may not have happened, so it needs reconciliation; on a pure step it is retried.
   */
  private classify(error: unknown, step: StepRecord): StepFailure {
    if (error instanceof WorkflowStepError)
      return {
        code: error.code,
        message: error.message,
        retryable: error.retryable,
        reconciliationRequired: error.reconciliationRequired,
      };
    if (error instanceof HttpException) {
      const status = error.getStatus();
      if (status < 500)
        return {
          code: `DOMAIN_REJECTED_${String(status)}`,
          message: errorMessage(error),
          retryable: false,
          reconciliationRequired: false,
        };
    }
    if (error instanceof Error && error.name === "ZodError")
      return {
        code: "DOMAIN_VALIDATION_FAILED",
        message: errorMessage(error),
        retryable: false,
        reconciliationRequired: false,
      };
    if (step.sideEffect)
      return {
        code: "UNKNOWN_SIDE_EFFECT_OUTCOME",
        message: errorMessage(error),
        retryable: false,
        reconciliationRequired: true,
      };
    return {
      code: "STEP_FAILED",
      message: errorMessage(error),
      retryable: true,
      reconciliationRequired: false,
    };
  }

  private async handleFailure(
    run: RunRecord,
    step: StepRecord,
    guard: Prisma.WorkflowStepWhereInput,
    jobId: string,
    now: Date,
    failure: StepFailure,
  ): Promise<WorkflowJobProcessResult> {
    if (failure.reconciliationRequired) {
      const applied = await this.failStep(run, step, guard, jobId, now, failure);
      return applied
        ? {
            status: "RECONCILIATION_REQUIRED",
            runId: run.id,
            stepId: step.id,
            detail: failure.message,
          }
        : this.noop({ runId: run.id, stepId: step.id }, "step state changed during dispatch");
    }
    if (failure.retryable && step.attempts < step.maxAttempts) {
      const config = this.limits.limits();
      const delay = retryDelayMs(step.attempts, config.retryBaseDelayMs, config.retryMaxDelayMs);
      const nextAttemptAt = new Date(now.getTime() + delay);
      const updated = await this.db.$transaction(async (tx) => {
        const waiting = await tx.workflowStep.updateMany({
          where: { ...guard, status: { in: transitionFrom("STEP", ["RUNNING"], "RETRY_WAIT") } },
          data: {
            status: "RETRY_WAIT",
            leaseOwner: null,
            leaseExpiresAt: null,
            nextAttemptAt,
            errorCode: failure.code,
            errorMessage: failure.message,
          },
        });
        if (waiting.count === 0) return null;
        await tx.workflowJob.updateMany({
          where: { workspaceId: run.workspaceId, jobId },
          data: { status: "RETRY_WAIT", errorCode: failure.code, errorMessage: failure.message },
        });
        await tx.workflowRun.updateMany({
          where: {
            workspaceId: run.workspaceId,
            id: run.id,
            state: { in: transitionFrom("RUN", ["QUEUED", "RUNNING"], "RETRY_WAIT") },
          },
          data: {
            state: "RETRY_WAIT",
            lastErrorCode: failure.code,
            lastErrorMessage: failure.message,
            nextAction: "The step will retry automatically",
          },
        });
        await tx.workflowEvent.create({
          data: this.eventData(
            run,
            "WORKFLOW_STEP_RETRY_WAIT",
            {
              stepKey: step.stepKey,
              code: failure.code,
              message: failure.message,
              nextAttemptAt: nextAttemptAt.toISOString(),
            },
            step.id,
          ),
        });
        return tx.workflowStep.findUnique({
          where: { workspaceId_id: { workspaceId: run.workspaceId, id: step.id } },
        });
      });
      if (updated === null)
        return this.noop({ runId: run.id, stepId: step.id }, "step state changed during dispatch");
      await this.enqueueCurrent(run, updated, delay);
      return { status: "RETRY_WAIT", runId: run.id, stepId: step.id, detail: failure.message };
    }
    const applied = await this.failStep(run, step, guard, jobId, now, {
      ...failure,
      retryable: false,
    });
    return applied
      ? { status: "FAILED", runId: run.id, stepId: step.id, detail: failure.message }
      : this.noop({ runId: run.id, stepId: step.id }, "step state changed during dispatch");
  }

  /** B2: renews this worker's lease while the domain call runs; stops once the guard no longer matches. */
  private startHeartbeat(guard: Prisma.WorkflowStepWhereInput): ReturnType<typeof setInterval> {
    const config = this.limits.limits();
    const timer = setInterval(() => {
      void this.db.workflowStep
        .updateMany({
          where: guard,
          data: { leaseExpiresAt: new Date(this.now().getTime() + config.stepLeaseTtlMs) },
        })
        .then((renewed) => {
          if (renewed.count === 0) clearInterval(timer);
        })
        .catch(() => undefined);
    }, config.heartbeatIntervalMs);
    timer.unref();
    return timer;
  }

  /**
   * B4: step completion, the run transition and the next step's QUEUED state commit in one
   * transaction; the enqueue happens after commit and a failure there is left to the sweep.
   */
  private async completeAndAdvance(params: {
    run: RunRecord;
    step: StepRecord;
    guard: Prisma.WorkflowStepWhereInput;
    targetState: "SUCCEEDED" | "SKIPPED";
    resultRef: string | null;
    resultType: string | null;
    mergedInput: WorkflowRunInput;
    jobId: string | null;
    jobRowId: string | null;
    skipped: boolean;
    now: Date;
    runFrom: WorkflowRunState[];
    extraEvent?: Readonly<{ type: string; payload: Readonly<Record<string, unknown>> }>;
  }): Promise<"STEP_SUCCEEDED" | "RUN_SUCCEEDED" | "RACED"> {
    const { run, step, now } = params;
    const input = params.mergedInput as unknown as Prisma.InputJsonValue;
    const outcome = await this.db.$transaction(async (tx) => {
      const completed = await tx.workflowStep.updateMany({
        where: params.guard,
        data: {
          status: params.targetState,
          resultRef: params.resultRef,
          resultType: params.resultType,
          leaseOwner: null,
          leaseExpiresAt: null,
          nextAttemptAt: null,
          completedAt: now,
        },
      });
      if (completed.count === 0) return { kind: "RACED" as const };
      if (params.jobId !== null)
        await tx.workflowJob.updateMany({
          where: { workspaceId: run.workspaceId, jobId: params.jobId },
          data: { status: "SUCCEEDED", completedAt: now },
        });
      if (params.extraEvent)
        await tx.workflowEvent.create({
          data: this.eventData(run, params.extraEvent.type, params.extraEvent.payload, step.id),
        });
      await tx.workflowEvent.create({
        data: this.eventData(
          run,
          "WORKFLOW_STEP_SUCCEEDED",
          {
            stepKey: step.stepKey,
            resultRef: params.resultRef,
            resultType: params.resultType,
            skipped: params.skipped,
          },
          step.id,
          params.jobRowId,
        ),
      });
      const next = await tx.workflowStep.findFirst({
        where: { workspaceId: run.workspaceId, runId: run.id, sequence: { gt: step.sequence } },
        orderBy: { sequence: "asc" },
      });
      if (!next) {
        await tx.workflowRun.updateMany({
          where: {
            workspaceId: run.workspaceId,
            id: run.id,
            state: { in: transitionFrom("RUN", params.runFrom, "SUCCEEDED") },
          },
          data: {
            state: "SUCCEEDED",
            input,
            currentStepKey: null,
            nextAction: null,
            completedAt: now,
          },
        });
        await tx.workflowEvent.create({
          data: this.eventData(run, "WORKFLOW_RUN_SUCCEEDED", {}, step.id),
        });
        return { kind: "RUN_SUCCEEDED" as const };
      }
      if (run.channelId !== null) {
        const channel = await tx.channel.findUnique({
          where: { workspaceId_id: { workspaceId: run.workspaceId, id: run.channelId } },
          select: { status: true },
        });
        if (channel && channel.status !== "ACTIVE") {
          await tx.workflowRun.updateMany({
            where: {
              workspaceId: run.workspaceId,
              id: run.id,
              state: { in: transitionFrom("RUN", params.runFrom, "PAUSED") },
            },
            data: {
              state: "PAUSED",
              input,
              currentStepKey: next.stepKey,
              pausedReason: "CHANNEL_PAUSED",
              nextAction: "Resume when the channel is active",
            },
          });
          await tx.workflowEvent.create({
            data: this.eventData(
              run,
              "WORKFLOW_RUN_PAUSED",
              { stepKey: next.stepKey, reason: "CHANNEL_PAUSED" },
              step.id,
            ),
          });
          return { kind: "STEP_SUCCEEDED" as const };
        }
      }
      const moved = await tx.workflowRun.updateMany({
        where: {
          workspaceId: run.workspaceId,
          id: run.id,
          state: { in: transitionFrom("RUN", params.runFrom, "RUNNING") },
        },
        data: {
          state: "RUNNING",
          input,
          currentStepKey: next.stepKey,
          nextAction: null,
          pausedReason: null,
          startedAt: run.startedAt ?? now,
        },
      });
      // Canceled or failed concurrently: the step result stays, the next step is not queued.
      if (moved.count === 0) return { kind: "STEP_SUCCEEDED" as const };
      const queued = await tx.workflowStep.updateMany({
        where: {
          workspaceId: run.workspaceId,
          id: next.id,
          status: { in: transitionFrom("STEP", ["PENDING"], "QUEUED") },
        },
        data: { status: "QUEUED", nextAttemptAt: null },
      });
      if (queued.count === 0) return { kind: "STEP_SUCCEEDED" as const };
      await tx.workflowEvent.create({
        data: this.eventData(run, "WORKFLOW_STEP_QUEUED", { stepKey: next.stepKey }, next.id),
      });
      return { kind: "STEP_SUCCEEDED" as const, queued: { ...next, status: "QUEUED" as const } };
    });
    if (outcome.kind === "RACED") return "RACED";
    if (outcome.kind === "STEP_SUCCEEDED" && "queued" in outcome && outcome.queued)
      await this.enqueueCurrent(run, outcome.queued);
    return outcome.kind;
  }

  private expectedJobId(
    runId: string,
    step: Pick<StepRecord, "id" | "attempts" | "retryGeneration" | "limitWaits" | "externalPolls">,
  ): string {
    return deterministicJobId(
      runId,
      step.id,
      step.attempts + 1,
      step.retryGeneration,
      step.limitWaits + step.externalPolls,
    );
  }

  /**
   * Enqueues the step's next expected delivery. Never throws: an enqueue failure is logged on the
   * run and left for the recovery sweep, so it cannot fail a step that already succeeded.
   */
  private async enqueueCurrent(
    run: Readonly<{ id: string; workspaceId: string; correlationId: string }>,
    step: Pick<
      StepRecord,
      "id" | "attempts" | "retryGeneration" | "limitWaits" | "externalPolls" | "maxAttempts"
    >,
    delayMs = 0,
  ): Promise<WorkflowQueueEnqueueResult | "FAILED"> {
    const job: WorkflowQueueJob = {
      jobId: this.expectedJobId(run.id, step),
      queueName: ORCHESTRATION_QUEUE_NAME,
      workspaceId: run.workspaceId,
      runId: run.id,
      stepId: step.id,
      attempt: step.attempts + 1,
      correlationId: run.correlationId,
      maxAttempts: step.maxAttempts,
      delayMs,
      wake: step.limitWaits + step.externalPolls,
    };
    let result: WorkflowQueueEnqueueResult;
    try {
      result = await this.queue.enqueue(job);
    } catch (error) {
      console.error(`[orchestration] enqueue of ${job.jobId} failed; the sweep will retry`, error);
      await this.db.workflowRun.updateMany({
        where: { workspaceId: run.workspaceId, id: run.id },
        data: {
          dispatchStatus: "NOT_CONFIGURED",
          nextAction: `Dispatch failed (${errorMessage(error)}); the worker sweep will retry`,
        },
      });
      return "FAILED";
    }
    await this.db.workflowRun.updateMany({
      where: { workspaceId: run.workspaceId, id: run.id },
      data:
        result === "NOT_CONFIGURED"
          ? {
              dispatchStatus: "NOT_CONFIGURED",
              nextAction: "Configure REDIS_URL to dispatch workflow jobs",
            }
          : { dispatchStatus: "DISPATCHED" },
    });
    return result;
  }

  private async failStep(
    run: RunRecord,
    step: StepRecord,
    guard: Prisma.WorkflowStepWhereInput,
    jobId: string | null,
    now: Date,
    failure: StepFailure,
  ): Promise<boolean> {
    const deadLetter = step.attempts >= step.maxAttempts || !failure.retryable;
    const target = failure.reconciliationRequired ? "RECONCILIATION_REQUIRED" : "FAILED";
    return this.db.$transaction(async (tx) => {
      const failed = await tx.workflowStep.updateMany({
        where: { ...guard, status: { in: transitionFrom("STEP", ["RUNNING"], target) } },
        data: {
          status: target,
          leaseOwner: null,
          leaseExpiresAt: null,
          nextAttemptAt: null,
          errorCode: failure.code,
          errorMessage: failure.message,
          completedAt: now,
        },
      });
      if (failed.count === 0) return false;
      if (jobId !== null)
        await tx.workflowJob.updateMany({
          where: { workspaceId: run.workspaceId, jobId },
          data: {
            status: deadLetter ? "DEAD_LETTER" : "FAILED",
            deadLetteredAt: deadLetter ? now : null,
            errorCode: failure.code,
            errorMessage: failure.message,
            completedAt: now,
          },
        });
      await tx.workflowRun.updateMany({
        where: {
          workspaceId: run.workspaceId,
          id: run.id,
          state: { in: transitionFrom("RUN", ["QUEUED", "RUNNING", "RETRY_WAIT"], "FAILED") },
        },
        data: {
          state: "FAILED",
          lastErrorCode: failure.code,
          lastErrorMessage: failure.message,
          completedAt: now,
          nextAction: failure.reconciliationRequired
            ? "Reconcile the external side effect, then retry from the failed step"
            : "Inspect the failed step and retry or cancel the run",
        },
      });
      await tx.workflowEvent.create({
        data: this.eventData(
          run,
          failure.reconciliationRequired
            ? "WORKFLOW_STEP_RECONCILIATION_REQUIRED"
            : "WORKFLOW_STEP_FAILED",
          { stepKey: step.stepKey, code: failure.code, message: failure.message, deadLetter },
          step.id,
        ),
      });
      return true;
    });
  }

  private eventData(
    run: Readonly<{ id: string; workspaceId: string; correlationId: string }>,
    eventType: string,
    payload: Readonly<Record<string, unknown>>,
    stepId: string | null = null,
    jobId: string | null = null,
  ): Prisma.WorkflowEventUncheckedCreateInput {
    return {
      id: randomUUID(),
      workspaceId: run.workspaceId,
      runId: run.id,
      stepId,
      jobId,
      eventType,
      correlationId: run.correlationId,
      causationId: null,
      payload: payload as unknown as Prisma.InputJsonValue,
      occurredAt: this.now(),
    };
  }

  private async acquireLimits(
    run: RunRecord,
    step: StepRecord,
    provider: string,
    now: Date,
    deliveryId: string,
  ): Promise<Array<{
    scope: "WORKSPACE" | "CHANNEL" | "PROVIDER" | "JOB_TYPE";
    scopeKey: string;
    holderId: string;
    slot: number;
  }> | null> {
    const config = this.limits.limits();
    const holderId = `${run.id}:${step.id}:${deliveryId}`;
    const requests: Array<{
      scope: "WORKSPACE" | "CHANNEL" | "PROVIDER" | "JOB_TYPE";
      scopeKey: string;
      limit: number;
    }> = [
      { scope: "WORKSPACE", scopeKey: run.workspaceId, limit: config.workspaceConcurrency },
      { scope: "PROVIDER", scopeKey: provider, limit: config.providerConcurrency },
      { scope: "JOB_TYPE", scopeKey: step.stepKey, limit: config.jobTypeConcurrency },
    ];
    if (run.channelId !== null)
      requests.splice(1, 0, {
        scope: "CHANNEL",
        scopeKey: run.channelId,
        limit: config.channelConcurrency,
      });
    const acquired: Array<{
      scope: "WORKSPACE" | "CHANNEL" | "PROVIDER" | "JOB_TYPE";
      scopeKey: string;
      holderId: string;
      slot: number;
    }> = [];
    for (const request of requests) {
      const slot = await this.limits.acquireLease({
        workspaceId: run.workspaceId,
        scope: request.scope,
        scopeKey: request.scopeKey,
        holderId,
        limit: request.limit,
        now,
      });
      if (slot === null) {
        await this.releaseLimits(run.workspaceId, acquired);
        return null;
      }
      acquired.push({
        scope: request.scope,
        scopeKey: request.scopeKey,
        holderId,
        slot,
      });
    }
    const rateOk = await this.limits.consumeRate({
      workspaceId: run.workspaceId,
      scope: "WORKSPACE",
      scopeKey: "orchestration",
      limit: config.rateLimitPerMinute,
      now,
    });
    if (!rateOk) {
      await this.releaseLimits(run.workspaceId, acquired);
      return null;
    }
    return acquired;
  }

  private async releaseLimits(
    workspaceId: string,
    leases: ReadonlyArray<{
      scope: "WORKSPACE" | "CHANNEL" | "PROVIDER" | "JOB_TYPE";
      scopeKey: string;
      holderId: string;
      slot: number;
    }>,
  ): Promise<void> {
    for (const lease of leases) {
      await this.limits.releaseLease({
        workspaceId,
        scope: lease.scope,
        scopeKey: lease.scopeKey,
        holderId: lease.holderId,
        slot: lease.slot,
      });
    }
  }
  private async markJobCanceled(workspaceId: string, stepId: string, now: Date): Promise<void> {
    await this.db.workflowStep.updateMany({
      where: { workspaceId, id: stepId, status: { in: [...ACTIVE_STEP_STATES] } },
      data: { status: "CANCELED", leaseOwner: null, leaseExpiresAt: null, completedAt: now },
    });
    await this.db.workflowJob.updateMany({
      where: { workspaceId, stepId, status: { in: [...ACTIVE_JOB_STATES] } },
      data: { status: "CANCELED", completedAt: now },
    });
  }

  private async claimSlot(
    channel: WorkflowSchedulerChannel,
    occurrence: WorkflowScheduleOccurrence,
  ): Promise<{ id: string } | null> {
    try {
      return await this.db.workflowScheduleSlot.create({
        data: {
          id: randomUUID(),
          workspaceId: channel.workspaceId,
          channelId: channel.id,
          slotKey: occurrence.slotKey,
          localDate: occurrence.localDate,
          localTime: occurrence.localTime,
          scheduledFor: occurrence.scheduledFor,
          status: "CLAIMED",
        },
        select: { id: true },
      });
    } catch (error) {
      if (
        (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") ||
        (typeof error === "object" &&
          error !== null &&
          (error as { code?: unknown }).code === "P2002")
      )
        return null;
      throw error;
    }
  }

  private async skipSlot(workspaceId: string, slotId: string, reason: string): Promise<void> {
    await this.db.workflowScheduleSlot.updateMany({
      where: { workspaceId, id: slotId, status: "CLAIMED" },
      data: { status: "SKIPPED", reason },
    });
  }

  private async ownerFor(workspaceId: string): Promise<string | null> {
    const membership = await this.db.workspaceMembership.findFirst({
      where: { workspaceId, role: "OWNER" },
      orderBy: { createdAt: "asc" },
      select: { userId: true },
    });
    return membership?.userId ?? null;
  }

  /** Resolves the acting member with their current role; viewers or removed members cannot act. */
  private async actorFor(run: {
    workspaceId: string;
    triggeredByUserId: string | null;
  }): Promise<{ userId: string; role: "OWNER" | "EDITOR" } | null> {
    const userId = run.triggeredByUserId ?? (await this.ownerFor(run.workspaceId));
    if (userId === null) return null;
    const membership = await this.db.workspaceMembership.findUnique({
      where: { workspaceId_userId: { workspaceId: run.workspaceId, userId } },
      select: { role: true },
    });
    if (membership?.role === "OWNER" || membership?.role === "EDITOR")
      return { userId, role: membership.role };
    return null;
  }

  /**
   * The step left RUNNING while the domain call was in flight (canceled or recovered).
   * Persist the domain result reference for reconciliation, but do not advance the run.
   */
  private async dispatchRaced(
    workspaceId: string,
    stepId: string,
    jobId: string,
    now: Date,
    result: { resultRef: string; resultType: string },
    payload: Pick<WorkflowQueueJob, "runId" | "stepId">,
  ): Promise<WorkflowJobProcessResult> {
    // Keep the domain id for whoever reconciles, but never on a step another worker now owns.
    await this.db.workflowStep.updateMany({
      where: {
        workspaceId,
        id: stepId,
        resultRef: null,
        status: { in: ["CANCELED", "RECONCILIATION_REQUIRED", "FAILED"] },
      },
      data: { resultRef: result.resultRef, resultType: result.resultType },
    });
    await this.db.workflowJob.updateMany({
      where: { workspaceId, jobId, status: "RUNNING" },
      data: { status: "CANCELED", completedAt: now },
    });
    return this.noop(payload, "step state changed during dispatch");
  }

  private async requireRun(workspaceId: string, runId: string): Promise<RunRecord> {
    const run = await this.db.workflowRun.findUnique({
      where: { workspaceId_id: { workspaceId, id: runId } },
      include: runInclude,
    });
    if (!run) throw new NotFoundException("Workflow run not found");
    return run;
  }

  private noop(
    payload: Pick<WorkflowQueueJob, "runId" | "stepId">,
    detail: string,
  ): WorkflowJobProcessResult {
    return { status: "NOOP", runId: payload.runId, stepId: payload.stepId, detail };
  }

  private async recordEvent(
    run: RunRecord,
    eventType: string,
    payload: Readonly<Record<string, unknown>>,
    stepId: string | null = null,
    jobId: string | null = null,
  ): Promise<void> {
    await this.recordEventById(run.workspaceId, run.id, eventType, payload, stepId, jobId);
  }

  private async recordEventById(
    workspaceId: string,
    runId: string,
    eventType: string,
    payload: Readonly<Record<string, unknown>>,
    stepId: string | null = null,
    jobId: string | null = null,
  ): Promise<void> {
    const run = await this.db.workflowRun.findUnique({
      where: { workspaceId_id: { workspaceId, id: runId } },
      select: { correlationId: true },
    });
    if (!run) return;
    await this.db.workflowEvent.create({
      data: {
        id: randomUUID(),
        workspaceId,
        runId,
        stepId,
        jobId,
        eventType,
        correlationId: run.correlationId,
        causationId: null,
        payload: payload as unknown as Prisma.InputJsonValue,
        occurredAt: this.now(),
      },
    });
  }

  private presentRun(run: RunRecord): WorkflowRunView {
    return {
      id: run.id,
      workspaceId: run.workspaceId,
      channelId: run.channelId,
      correlationId: run.correlationId,
      definitionKey: run.definitionKey,
      trigger: run.trigger,
      triggeredByUserId: run.triggeredByUserId,
      state: run.state,
      dispatchStatus: run.dispatchStatus,
      budgetDecision: run.budgetDecision,
      budgetReason: run.budgetReason,
      currentStepKey: run.currentStepKey,
      nextAction: run.nextAction,
      pausedReason: run.pausedReason,
      lastErrorCode: run.lastErrorCode,
      lastErrorMessage: run.lastErrorMessage,
      input: asRecord(run.input),
      startedAt: run.startedAt?.toISOString() ?? null,
      completedAt: run.completedAt?.toISOString() ?? null,
      createdAt: run.createdAt.toISOString(),
      updatedAt: run.updatedAt.toISOString(),
      steps: run.steps.map((step) => this.presentStep(step)),
      jobs: run.jobs.map((job) => this.presentJob(job)),
      events: run.events.map((event) => this.presentEvent(event)),
    };
  }

  private presentStep(step: StepRecord): WorkflowStepView {
    return {
      id: step.id,
      runId: step.runId,
      stepKey: step.stepKey,
      sequence: step.sequence,
      status: step.status,
      attempts: step.attempts,
      maxAttempts: step.maxAttempts,
      retryGeneration: step.retryGeneration,
      sideEffect: step.sideEffect,
      idempotencyKey: step.idempotencyKey,
      resultRef: step.resultRef,
      resultType: step.resultType,
      errorCode: step.errorCode,
      errorMessage: step.errorMessage,
      leaseExpiresAt: step.leaseExpiresAt?.toISOString() ?? null,
      nextAttemptAt: step.nextAttemptAt?.toISOString() ?? null,
      startedAt: step.startedAt?.toISOString() ?? null,
      completedAt: step.completedAt?.toISOString() ?? null,
      createdAt: step.createdAt.toISOString(),
      updatedAt: step.updatedAt.toISOString(),
    };
  }

  private presentJob(job: JobRecord): WorkflowJobView {
    return {
      id: job.id,
      runId: job.runId,
      stepId: job.stepId,
      jobId: job.jobId,
      queueName: job.queueName,
      attempt: job.attempt,
      status: job.status,
      errorCode: job.errorCode,
      errorMessage: job.errorMessage,
      deadLetteredAt: job.deadLetteredAt?.toISOString() ?? null,
      startedAt: job.startedAt?.toISOString() ?? null,
      completedAt: job.completedAt?.toISOString() ?? null,
      createdAt: job.createdAt.toISOString(),
      updatedAt: job.updatedAt.toISOString(),
    };
  }

  private presentEvent(event: EventRecord): WorkflowEventView {
    return {
      id: event.id,
      runId: event.runId,
      stepId: event.stepId,
      jobId: event.jobId,
      eventType: event.eventType,
      correlationId: event.correlationId,
      causationId: event.causationId,
      payload: asRecord(event.payload),
      occurredAt: event.occurredAt.toISOString(),
    };
  }

  private requireEditor(context: WorkspaceContext): void {
    if (!editableRoles.has(context.role))
      throw new ForbiddenException("Editor permission required");
  }

  private now(): Date {
    return this.clock();
  }
}
