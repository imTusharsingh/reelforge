import { randomUUID } from "node:crypto";
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
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
  type WorkflowQueueJob,
  type WorkflowQueuePort,
  type WorkflowRunInput,
  type WorkflowRunState,
  type WorkflowRunView,
  type WorkflowScheduleOccurrence,
  type WorkflowSchedulerChannel,
  type WorkflowSchedulerTickResult,
  type WorkflowStepDispatcherPort,
  type WorkflowStepKey,
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
    const run = await this.createRun({
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
    });
    await this.recordEvent(run, "WORKFLOW_RUN_CREATED", {
      definitionKey: run.definitionKey,
      trigger: run.trigger,
      budgetDecision: run.budgetDecision,
    });
    if (this.queue.status === "CONFIGURED") {
      const first = run.steps[0];
      if (first) await this.enqueueStep(run, first, 1);
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
      where: { workspaceId: context.workspaceId, id, state: "FAILED" },
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
        status: { in: ["FAILED", "RECONCILIATION_REQUIRED"] },
      },
      data: {
        status: "QUEUED",
        attempts: 0,
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
    if (step) await this.enqueueStep(refreshed, step, 1);
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
        const advanced = await this.db.workflowStep.updateMany({
          where: {
            workspaceId: context.workspaceId,
            id: waiting.id,
            status: "WAITING_APPROVAL",
          },
          data: { status: "SUCCEEDED", completedAt: now, leaseOwner: null, leaseExpiresAt: null },
        });
        if (advanced.count === 0) throw new ConflictException("Workflow step state changed");
        const requeued = await this.db.workflowRun.updateMany({
          where: { workspaceId: context.workspaceId, id, state: "WAITING_APPROVAL" },
          data: { state: "QUEUED", nextAction: null, pausedReason: null },
        });
        if (requeued.count === 0) throw new ConflictException("Workflow run state changed");
        await this.recordEventById(
          context.workspaceId,
          id,
          "WORKFLOW_APPROVAL_GRANTED",
          {
            stepKey: waiting.stepKey,
            qualityReviewRunId: waiting.resultRef,
            qualityStatus: review.status,
          },
          waiting.id,
        );
        const approvedRun = await this.requireRun(context.workspaceId, id);
        const step = approvedRun.steps.find((item) => item.id === waiting.id);
        if (step) await this.advanceRun(approvedRun, step, asRecord(approvedRun.input), now);
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
    if (step) await this.enqueueStep(refreshed, step, 1);
    await this.recordEventById(context.workspaceId, id, "WORKFLOW_RUN_RESUMED", {
      stepKey: pending.stepKey,
    });
    return this.getRun(context, id);
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
    const claimed = await this.db.workflowStep.updateMany({
      where: {
        workspaceId: run.workspaceId,
        id: step.id,
        status: { in: ["QUEUED", "RETRY_WAIT"] },
        OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lt: now } }],
      },
      data: {
        status: "RUNNING",
        leaseOwner: workerId,
        leaseExpiresAt: new Date(now.getTime() + this.limits.limits().stepLeaseTtlMs),
        startedAt: step.startedAt ?? now,
        attempts: { increment: 1 },
        errorCode: null,
        errorMessage: null,
        nextAttemptAt: null,
      },
    });
    if (claimed.count === 0) {
      const current = await this.db.workflowStep.findUnique({
        where: { workspaceId_id: { workspaceId: run.workspaceId, id: step.id } },
      });
      return this.noop(payload, current ? `step is ${current.status}` : "step not found");
    }
    await this.db.workflowRun.updateMany({
      where: { workspaceId: run.workspaceId, id: run.id, state: { in: ["QUEUED", "RETRY_WAIT"] } },
      data: { state: "RUNNING", currentStepKey: step.stepKey, startedAt: run.startedAt ?? now },
    });
    const claimedStep = await this.db.workflowStep.findUniqueOrThrow({
      where: { workspaceId_id: { workspaceId: run.workspaceId, id: step.id } },
    });
    const attempt = claimedStep.attempts;
    const jobId = deterministicJobId(run.id, step.id, attempt, claimedStep.retryGeneration);
    const jobRow = await this.db.workflowJob.upsert({
      where: { workspaceId_jobId: { workspaceId: run.workspaceId, jobId } },
      create: {
        id: randomUUID(),
        workspaceId: run.workspaceId,
        runId: run.id,
        stepId: step.id,
        jobId,
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
      "WORKFLOW_STEP_STARTED",
      { stepKey: step.stepKey, attempt, jobId, workerId },
      step.id,
      jobRow.id,
    );
    const actor = await this.actorFor(run);
    if (actor === null) {
      await this.failStep(run, claimedStep, jobId, now, {
        code: "NO_WORKSPACE_ACTOR",
        message: "No workspace member can act for this run",
        retryable: false,
        reconciliationRequired: false,
      });
      return { status: "FAILED", runId: run.id, stepId: step.id, detail: "no actor" };
    }
    const context: WorkspaceContext = {
      workspaceId: run.workspaceId,
      userId: actor.userId,
      role: actor.role,
    };
    const definition = stepDefinition(run.definitionKey, step.stepKey as WorkflowStepKey);
    const provider = definition?.provider ?? "internal";
    const leases = await this.acquireLimits(run, claimedStep, provider, now);
    if (leases === null) {
      const delay = retryDelayMs(
        attempt,
        this.limits.limits().retryBaseDelayMs,
        this.limits.limits().retryMaxDelayMs,
      );
      await this.setRetryWait(run, claimedStep, jobId, now, delay, {
        code: "WORKFLOW_LIMIT",
        message: "Workflow concurrency or rate limit reached",
        retryable: true,
        reconciliationRequired: false,
      });
      return { status: "LIMIT_WAIT", runId: run.id, stepId: step.id, detail: "limit reached" };
    }
    try {
      const result = await this.dispatcher.dispatchStep({
        context,
        runId: run.id,
        stepId: step.id,
        stepKey: step.stepKey as WorkflowStepKey,
        definitionKey: run.definitionKey,
        trigger: run.trigger,
        correlationId: run.correlationId,
        idempotencyKey: step.idempotencyKey,
        attempt,
        input: asRecord(run.input),
      });
      const mergedInput = { ...asRecord(run.input), ...(result.output ?? {}) };
      if (result.waitingApproval) {
        const waiting = await this.db.workflowStep.updateMany({
          where: { workspaceId: run.workspaceId, id: step.id, status: "RUNNING" },
          data: {
            status: "WAITING_APPROVAL",
            resultRef: result.resultRef,
            resultType: result.resultType,
            leaseOwner: null,
            leaseExpiresAt: null,
            completedAt: null,
          },
        });
        if (waiting.count === 0)
          return this.dispatchRaced(run.workspaceId, step.id, jobId, now, result, payload);
        await this.db.workflowRun.updateMany({
          where: {
            workspaceId: run.workspaceId,
            id: run.id,
            state: { in: ["QUEUED", "RUNNING", "RETRY_WAIT"] },
          },
          data: {
            state: "WAITING_APPROVAL",
            input: mergedInput as unknown as Prisma.InputJsonValue,
            currentStepKey: step.stepKey,
            nextAction: `Approve quality review ${result.resultRef} then resume`,
            pausedReason: null,
          },
        });
        await this.completeJob(run.workspaceId, jobId, "SUCCEEDED", now);
        await this.recordEvent(
          run,
          "WORKFLOW_APPROVAL_REQUESTED",
          {
            stepKey: step.stepKey,
            resultRef: result.resultRef,
          },
          step.id,
          jobRow.id,
        );
        return {
          status: "WAITING_APPROVAL",
          runId: run.id,
          stepId: step.id,
          detail: result.resultRef,
        };
      }
      const targetStepState = result.skipped ? "SKIPPED" : "SUCCEEDED";
      // Result reference and terminal state are written in one CAS, so a redelivered job sees
      // SUCCEEDED/SKIPPED with its domain record and becomes a no-op.
      const completed = await this.db.workflowStep.updateMany({
        where: { workspaceId: run.workspaceId, id: step.id, status: "RUNNING" },
        data: {
          status: targetStepState,
          resultRef: result.resultRef,
          resultType: result.resultType,
          leaseOwner: null,
          leaseExpiresAt: null,
          completedAt: now,
        },
      });
      if (completed.count === 0)
        return this.dispatchRaced(run.workspaceId, step.id, jobId, now, result, payload);
      await this.completeJob(run.workspaceId, jobId, "SUCCEEDED", now);
      await this.recordEvent(
        run,
        "WORKFLOW_STEP_SUCCEEDED",
        {
          stepKey: step.stepKey,
          resultRef: result.resultRef,
          resultType: result.resultType,
          skipped: result.skipped === true,
        },
        step.id,
        jobRow.id,
      );
      const advanced = await this.advanceRun(run, claimedStep, mergedInput, now);
      return {
        status: advanced,
        runId: run.id,
        stepId: step.id,
        detail: result.resultRef,
      };
    } catch (error) {
      const failure =
        error instanceof WorkflowStepError
          ? error
          : new WorkflowStepError("STEP_FAILED", errorMessage(error), true);
      if (failure.reconciliationRequired) {
        await this.failStep(run, claimedStep, jobId, now, {
          code: failure.code,
          message: failure.message,
          retryable: false,
          reconciliationRequired: true,
        });
        return {
          status: "RECONCILIATION_REQUIRED",
          runId: run.id,
          stepId: step.id,
          detail: failure.message,
        };
      }
      if (failure.retryable && claimedStep.attempts < claimedStep.maxAttempts) {
        const delay = retryDelayMs(
          claimedStep.attempts,
          this.limits.limits().retryBaseDelayMs,
          this.limits.limits().retryMaxDelayMs,
        );
        await this.setRetryWait(run, claimedStep, jobId, now, delay, {
          code: failure.code,
          message: failure.message,
          retryable: true,
          reconciliationRequired: false,
        });
        return { status: "RETRY_WAIT", runId: run.id, stepId: step.id, detail: failure.message };
      }
      await this.failStep(run, claimedStep, jobId, now, {
        code: failure.code,
        message: failure.message,
        retryable: false,
        reconciliationRequired: false,
      });
      return { status: "FAILED", runId: run.id, stepId: step.id, detail: failure.message };
    } finally {
      await this.releaseLimits(run.workspaceId, leases);
    }
  }

  /**
   * Re-dispatches QUEUED runs that were persisted while the queue was NOT_CONFIGURED, once a
   * queue is available. The first PENDING step is claimed with a CAS so this is safe to repeat.
   */
  public async dispatchUndispatchedRuns(
    options: { readonly workspaceId?: string } = {},
  ): Promise<number> {
    if (this.queue.status !== "CONFIGURED") return 0;
    const runs = await this.db.workflowRun.findMany({
      where: {
        state: "QUEUED",
        dispatchStatus: "NOT_CONFIGURED",
        ...(options.workspaceId === undefined ? {} : { workspaceId: options.workspaceId }),
      },
      include: runInclude,
      orderBy: { createdAt: "asc" },
      take: 100,
    });
    let dispatched = 0;
    for (const run of runs) {
      const first = run.steps[0];
      if (!first || first.status !== "PENDING") continue;
      const claimed = await this.db.workflowStep.updateMany({
        where: { workspaceId: run.workspaceId, id: first.id, status: "PENDING" },
        data: { status: "QUEUED" },
      });
      if (claimed.count === 0) continue;
      await this.db.workflowRun.updateMany({
        where: { workspaceId: run.workspaceId, id: run.id, state: "QUEUED" },
        data: { currentStepKey: first.stepKey, nextAction: null },
      });
      const refreshed = await this.requireRun(run.workspaceId, run.id);
      const step = refreshed.steps.find((item) => item.id === first.id);
      if (step) await this.enqueueStep(refreshed, step, 1);
      await this.recordEvent(
        refreshed,
        "WORKFLOW_STEP_QUEUED",
        { stepKey: first.stepKey },
        first.id,
      );
      dispatched += 1;
    }
    return dispatched;
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
      const reconciliation = step.sideEffect || step.attempts >= step.maxAttempts;
      const nextState = reconciliation ? "RECONCILIATION_REQUIRED" : "RETRY_WAIT";
      const nextAttemptAt = reconciliation
        ? null
        : new Date(now.getTime() + this.limits.limits().retryBaseDelayMs);
      const updated = await this.db.workflowStep.updateMany({
        where: {
          workspaceId: step.workspaceId,
          id: step.id,
          status: "RUNNING",
          leaseExpiresAt: { lt: now },
        },
        data: {
          status: nextState,
          leaseOwner: null,
          leaseExpiresAt: null,
          nextAttemptAt,
          errorCode: "STALE_LEASE",
          errorMessage: "The step lease expired before completion",
        },
      });
      if (updated.count === 0) continue;
      await this.db.workflowJob.updateMany({
        where: {
          workspaceId: step.workspaceId,
          stepId: step.id,
          status: "RUNNING",
        },
        data: {
          status: reconciliation ? "FAILED" : "RETRY_WAIT",
          errorCode: "STALE_LEASE",
          errorMessage: "The step lease expired before completion",
        },
      });
      await this.db.workflowRun.updateMany({
        where: {
          workspaceId: step.workspaceId,
          id: step.runId,
          state: { in: ["QUEUED", "RUNNING", "RETRY_WAIT"] },
        },
        data: {
          state: reconciliation ? "FAILED" : "RETRY_WAIT",
          lastErrorCode: "STALE_LEASE",
          lastErrorMessage: "A workflow step lease expired",
          nextAction: reconciliation
            ? "Reconcile the external side effect, then retry from the failed step"
            : "The step will retry automatically",
        },
      });
      await this.recordEventById(
        step.workspaceId,
        step.runId,
        reconciliation ? "WORKFLOW_STEP_RECONCILIATION_REQUIRED" : "WORKFLOW_STEP_RETRY_WAIT",
        { stepKey: step.stepKey, attempts: step.attempts },
        step.id,
      );
      if (!reconciliation) {
        const refreshed = await this.requireRun(step.workspaceId, step.runId);
        const refreshedStep = refreshed.steps.find((item) => item.id === step.id);
        if (refreshedStep)
          await this.enqueueStep(
            refreshed,
            refreshedStep,
            step.attempts + 1,
            this.limits.limits().retryBaseDelayMs,
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
            claimed.id,
            channel.status === "ARCHIVED" ? "CHANNEL_ARCHIVED" : "CHANNEL_PAUSED",
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
          await this.skipSlot(claimed.id, "MAX_RUNS_PER_DAY");
          skippedSlots += 1;
          continue;
        }
        const actor = await this.ownerFor(channel.workspaceId);
        if (actor === null) {
          await this.skipSlot(claimed.id, "NO_WORKSPACE_ACTOR");
          skippedSlots += 1;
          continue;
        }
        const run = await this.startScheduledRun(channel, occurrence, schedule.input, actor);
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

  private async startScheduledRun(
    channel: WorkflowSchedulerChannel,
    occurrence: WorkflowScheduleOccurrence,
    scheduleInput: Readonly<Record<string, unknown>>,
    actorUserId: string,
  ): Promise<RunRecord> {
    const input: WorkflowRunInput = { ...scheduleInput, channelId: channel.id };
    const budget = await this.budget.evaluate({
      workspaceId: channel.workspaceId,
      channelId: channel.id,
      definitionKey: occurrence.definitionKey,
      trigger: "SCHEDULED",
    });
    const budgetAllowed = budget.decision === "ALLOWED";
    const channelAllowed = channel.status === "ACTIVE";
    const pausedReason = !channelAllowed
      ? "CHANNEL_PAUSED"
      : !budgetAllowed
        ? budget.decision === "NOT_CONFIGURED"
          ? "BUDGET_POLICY_UNAVAILABLE"
          : (budget.reason ?? "BUDGET_BLOCKED")
        : null;
    const state: WorkflowRunState = pausedReason === null ? "QUEUED" : "PAUSED";
    const run = await this.createRun({
      workspaceId: channel.workspaceId,
      channelId: channel.id,
      definitionKey: occurrence.definitionKey,
      trigger: "SCHEDULED",
      triggeredByUserId: actorUserId,
      input,
      idempotencyKey: `scheduled:${channel.id}:${occurrence.slotKey}`,
      state,
      budgetDecision: budget.decision,
      budgetReason: budget.reason,
      pausedReason,
      nextAction:
        pausedReason === "CHANNEL_PAUSED"
          ? "Resume when the channel is active"
          : pausedReason !== null
            ? "Configure a budget policy before scheduled generation"
            : null,
      dispatchFirst: pausedReason === null && this.queue.status === "CONFIGURED",
    });
    await this.recordEvent(run, "WORKFLOW_RUN_CREATED", {
      definitionKey: run.definitionKey,
      trigger: run.trigger,
      slotKey: occurrence.slotKey,
      budgetDecision: run.budgetDecision,
      pausedReason,
    });
    if (run.state === "QUEUED" && this.queue.status === "CONFIGURED") {
      const first = run.steps[0];
      if (first) await this.enqueueStep(run, first, 1);
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

  private async enqueueStep(
    run: RunRecord,
    step: StepRecord,
    attempt: number,
    delayMs = 0,
  ): Promise<void> {
    const result = await this.queue.enqueue({
      jobId: deterministicJobId(run.id, step.id, attempt, step.retryGeneration),
      queueName: ORCHESTRATION_QUEUE_NAME,
      workspaceId: run.workspaceId,
      runId: run.id,
      stepId: step.id,
      attempt,
      correlationId: run.correlationId,
      maxAttempts: step.maxAttempts,
      delayMs,
    });
    if (result === "NOT_CONFIGURED") {
      await this.db.workflowRun.updateMany({
        where: { workspaceId: run.workspaceId, id: run.id },
        data: {
          dispatchStatus: "NOT_CONFIGURED",
          nextAction: "Configure REDIS_URL to dispatch workflow jobs",
        },
      });
      return;
    }
    await this.db.workflowRun.updateMany({
      where: { workspaceId: run.workspaceId, id: run.id },
      data: { dispatchStatus: "DISPATCHED" },
    });
  }

  private async advanceRun(
    run: RunRecord,
    currentStep: StepRecord,
    mergedInput: WorkflowRunInput,
    now: Date,
  ): Promise<"STEP_SUCCEEDED" | "RUN_SUCCEEDED"> {
    const next = await this.db.workflowStep.findFirst({
      where: {
        workspaceId: run.workspaceId,
        runId: run.id,
        sequence: { gt: currentStep.sequence },
      },
      orderBy: { sequence: "asc" },
    });
    if (!next) {
      await this.db.workflowRun.updateMany({
        where: {
          workspaceId: run.workspaceId,
          id: run.id,
          state: { in: ["QUEUED", "RUNNING", "RETRY_WAIT"] },
        },
        data: {
          state: "SUCCEEDED",
          input: mergedInput as unknown as Prisma.InputJsonValue,
          currentStepKey: null,
          nextAction: null,
          completedAt: now,
        },
      });
      await this.recordEvent(run, "WORKFLOW_RUN_SUCCEEDED", {}, currentStep.id, null);
      return "RUN_SUCCEEDED";
    }
    if (run.channelId !== null) {
      const channel = await this.db.channel.findUnique({
        where: { workspaceId_id: { workspaceId: run.workspaceId, id: run.channelId } },
        select: { status: true },
      });
      if (channel && channel.status !== "ACTIVE") {
        await this.db.workflowRun.updateMany({
          where: {
            workspaceId: run.workspaceId,
            id: run.id,
            state: { in: ["QUEUED", "RUNNING", "RETRY_WAIT"] },
          },
          data: {
            state: "PAUSED",
            input: mergedInput as unknown as Prisma.InputJsonValue,
            currentStepKey: next.stepKey,
            pausedReason: "CHANNEL_PAUSED",
            nextAction: "Resume when the channel is active",
          },
        });
        await this.recordEvent(
          run,
          "WORKFLOW_RUN_PAUSED",
          {
            stepKey: next.stepKey,
            reason: "CHANNEL_PAUSED",
          },
          currentStep.id,
          null,
        );
        return "STEP_SUCCEEDED";
      }
    }
    const moved = await this.db.workflowRun.updateMany({
      where: {
        workspaceId: run.workspaceId,
        id: run.id,
        state: { in: ["QUEUED", "RUNNING", "RETRY_WAIT"] },
      },
      data: {
        state: "RUNNING",
        input: mergedInput as unknown as Prisma.InputJsonValue,
        currentStepKey: next.stepKey,
        nextAction: null,
        pausedReason: null,
        startedAt: run.startedAt ?? now,
      },
    });
    // Canceled or failed concurrently: do not queue the next step.
    if (moved.count === 0) return "STEP_SUCCEEDED";
    await this.db.workflowStep.updateMany({
      where: { workspaceId: run.workspaceId, id: next.id, status: "PENDING" },
      data: { status: "QUEUED" },
    });
    const refreshed = await this.requireRun(run.workspaceId, run.id);
    const step = refreshed.steps.find((item) => item.id === next.id);
    if (step) await this.enqueueStep(refreshed, step, 1);
    await this.recordEvent(run, "WORKFLOW_STEP_QUEUED", { stepKey: next.stepKey }, next.id, null);
    return "STEP_SUCCEEDED";
  }

  private async setRetryWait(
    run: RunRecord,
    step: StepRecord,
    jobId: string,
    now: Date,
    delayMs: number,
    failure: {
      code: string;
      message: string;
      retryable: boolean;
      reconciliationRequired: boolean;
    },
  ): Promise<void> {
    const nextAttemptAt = new Date(now.getTime() + delayMs);
    await this.db.workflowStep.updateMany({
      where: { workspaceId: run.workspaceId, id: step.id, status: "RUNNING" },
      data: {
        status: "RETRY_WAIT",
        leaseOwner: null,
        leaseExpiresAt: null,
        nextAttemptAt,
        errorCode: failure.code,
        errorMessage: failure.message,
      },
    });
    await this.db.workflowJob.updateMany({
      where: { workspaceId: run.workspaceId, jobId },
      data: { status: "RETRY_WAIT", errorCode: failure.code, errorMessage: failure.message },
    });
    await this.db.workflowRun.updateMany({
      where: {
        workspaceId: run.workspaceId,
        id: run.id,
        state: { in: ["QUEUED", "RUNNING"] },
      },
      data: {
        state: "RETRY_WAIT",
        lastErrorCode: failure.code,
        lastErrorMessage: failure.message,
        nextAction: "The step will retry automatically",
      },
    });
    await this.recordEvent(
      run,
      "WORKFLOW_STEP_RETRY_WAIT",
      {
        stepKey: step.stepKey,
        code: failure.code,
        message: failure.message,
        nextAttemptAt: nextAttemptAt.toISOString(),
      },
      step.id,
      null,
    );
    const refreshed = await this.requireRun(run.workspaceId, run.id);
    const refreshedStep = refreshed.steps.find((item) => item.id === step.id);
    if (refreshedStep) await this.enqueueStep(refreshed, refreshedStep, step.attempts + 1, delayMs);
  }

  private async failStep(
    run: RunRecord,
    step: StepRecord,
    jobId: string,
    now: Date,
    failure: {
      code: string;
      message: string;
      retryable: boolean;
      reconciliationRequired: boolean;
    },
  ): Promise<void> {
    const deadLetter = step.attempts >= step.maxAttempts || !failure.retryable;
    await this.db.workflowStep.updateMany({
      where: { workspaceId: run.workspaceId, id: step.id, status: "RUNNING" },
      data: {
        status: failure.reconciliationRequired ? "RECONCILIATION_REQUIRED" : "FAILED",
        leaseOwner: null,
        leaseExpiresAt: null,
        nextAttemptAt: null,
        errorCode: failure.code,
        errorMessage: failure.message,
        completedAt: now,
      },
    });
    await this.db.workflowJob.updateMany({
      where: { workspaceId: run.workspaceId, jobId },
      data: {
        status: deadLetter ? "DEAD_LETTER" : "FAILED",
        deadLetteredAt: deadLetter ? now : null,
        errorCode: failure.code,
        errorMessage: failure.message,
        completedAt: now,
      },
    });
    await this.db.workflowRun.updateMany({
      where: {
        workspaceId: run.workspaceId,
        id: run.id,
        state: { in: ["QUEUED", "RUNNING", "RETRY_WAIT"] },
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
    await this.recordEvent(
      run,
      failure.reconciliationRequired
        ? "WORKFLOW_STEP_RECONCILIATION_REQUIRED"
        : "WORKFLOW_STEP_FAILED",
      {
        stepKey: step.stepKey,
        code: failure.code,
        message: failure.message,
        deadLetter,
      },
      step.id,
      null,
    );
  }

  private async acquireLimits(
    run: RunRecord,
    step: StepRecord,
    provider: string,
    now: Date,
  ): Promise<Array<{
    scope: "WORKSPACE" | "CHANNEL" | "PROVIDER" | "JOB_TYPE";
    scopeKey: string;
    holderId: string;
    slot: number;
  }> | null> {
    const config = this.limits.limits();
    const holderId = `${run.id}:${step.id}:${step.attempts}`;
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

  private async completeJob(
    workspaceId: string,
    jobId: string,
    status: "SUCCEEDED" | "CANCELED",
    now: Date,
  ): Promise<void> {
    await this.db.workflowJob.updateMany({
      where: { workspaceId, jobId },
      data: { status, completedAt: now },
    });
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

  private async skipSlot(slotId: string, reason: string): Promise<void> {
    const slot = await this.db.workflowScheduleSlot.findUnique({ where: { id: slotId } });
    if (!slot) return;
    await this.db.workflowScheduleSlot.updateMany({
      where: { id: slotId, status: "CLAIMED" },
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
    payload: WorkflowQueueJob,
  ): Promise<WorkflowJobProcessResult> {
    await this.db.workflowStep.updateMany({
      where: { workspaceId, id: stepId, resultRef: null },
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

  private noop(payload: WorkflowQueueJob, detail: string): WorkflowJobProcessResult {
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
