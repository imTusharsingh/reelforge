import { randomUUID } from "node:crypto";
import { ConflictException, ForbiddenException, NotFoundException } from "@nestjs/common";
import { createDatabaseClient } from "@reelforge/database";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ChannelService } from "../channel/channel.service.js";
import { StaticBudgetPolicy, UnconfiguredBudgetPolicy } from "./orchestration.budget.js";
import { WorkflowLimitsService } from "./orchestration.limits.js";
import { InMemoryWorkflowQueue, NotConfiguredWorkflowQueue } from "./orchestration.queue.js";
import { OrchestrationService } from "./orchestration.service.js";
import {
  DEFAULT_WORKFLOW_LIMIT_CONFIG,
  WorkflowStepError,
  type BudgetPolicyPort,
  type WorkflowLimitConfig,
  type WorkflowQueuePort,
  type WorkflowStepDispatchInput,
  type WorkflowStepDispatchResult,
  type WorkflowStepDispatcherPort,
  type WorkflowStepKey,
} from "./orchestration.types.js";

const databaseUrl = process.env.DATABASE_URL;
const suite = describe.skipIf(databaseUrl === undefined);

const workspaceId = randomUUID();
const otherWorkspaceId = randomUUID();
const ownerId = randomUUID();
const editorId = randomUUID();
const viewerId = randomUUID();
const otherOwnerId = randomUUID();
const channelId = randomUUID();
const pausedChannelId = randomUUID();
const otherChannelId = randomUUID();
const ideaId = randomUUID();

const owner = { workspaceId, userId: ownerId, role: "OWNER" as const };
const editor = { workspaceId, userId: editorId, role: "EDITOR" as const };
const viewer = { workspaceId, userId: viewerId, role: "VIEWER" as const };
const otherOwner = { workspaceId: otherWorkspaceId, userId: otherOwnerId, role: "OWNER" as const };

type Behavior = (input: WorkflowStepDispatchInput) => Promise<WorkflowStepDispatchResult>;

/** Fixture dispatcher: no live AI, Google, or Meta calls. Counts side effects per step key. */
class FixtureDispatcher implements WorkflowStepDispatcherPort {
  public readonly calls: WorkflowStepDispatchInput[] = [];
  public readonly behaviors = new Map<WorkflowStepKey, Behavior>();

  public async dispatchStep(input: WorkflowStepDispatchInput): Promise<WorkflowStepDispatchResult> {
    this.calls.push(input);
    const behavior = this.behaviors.get(input.stepKey);
    if (behavior) return behavior(input);
    if (input.stepKey === "QUALITY_REVIEW")
      return {
        resultRef: `review-${input.runId}`,
        resultType: "QUALITY_REVIEW_RUN",
        waitingApproval: true,
      };
    return { resultRef: `${input.stepKey}-${input.runId}`, resultType: input.stepKey };
  }

  public count(runId: string, stepKey: WorkflowStepKey): number {
    return this.calls.filter((call) => call.runId === runId && call.stepKey === stepKey).length;
  }
}

suite("M16 orchestration on PostgreSQL", () => {
  const db = databaseUrl === undefined ? undefined : createDatabaseClient(databaseUrl);
  const secondDb = databaseUrl === undefined ? undefined : createDatabaseClient(databaseUrl);
  let clockMs = Date.parse("2026-11-10T08:00:00.000Z");
  const clock = (): Date => new Date(clockMs);
  const qualityStatus = new Map<string, string>();
  const quality = {
    get: async (_context: unknown, id: string): Promise<{ id: string; status: string }> => ({
      id,
      status: qualityStatus.get(id) ?? "REVIEW_REQUIRED",
    }),
  };

  function channels(database: NonNullable<typeof db>): ChannelService {
    const service = new ChannelService(database as never);
    const all = service.listSchedulerCandidates.bind(service);
    service.listSchedulerCandidates = async (): ReturnType<typeof all> =>
      (await all()).filter((channel) => channel.workspaceId === workspaceId);
    return service;
  }

  function build(
    options: {
      queue?: WorkflowQueuePort;
      dispatcher?: FixtureDispatcher;
      budget?: BudgetPolicyPort;
      limits?: Partial<WorkflowLimitConfig>;
      database?: NonNullable<typeof db>;
    } = {},
  ): {
    service: OrchestrationService;
    queue: WorkflowQueuePort;
    dispatcher: FixtureDispatcher;
  } {
    const database = options.database ?? db;
    if (!database) throw new Error("database unavailable");
    const queue = options.queue ?? new InMemoryWorkflowQueue();
    const dispatcher = options.dispatcher ?? new FixtureDispatcher();
    const limits = new WorkflowLimitsService(database as never, {
      ...DEFAULT_WORKFLOW_LIMIT_CONFIG,
      rateLimitPerMinute: 10_000,
      ...options.limits,
    });
    const service = new OrchestrationService(
      database as never,
      queue,
      dispatcher,
      options.budget ?? new UnconfiguredBudgetPolicy(),
      limits,
      channels(database),
      quality as never,
      clock,
    );
    return { service, queue, dispatcher };
  }

  async function drain(
    service: OrchestrationService,
    queue: WorkflowQueuePort,
    workerId = "worker-a",
  ): Promise<string[]> {
    const statuses: string[] = [];
    const memory = queue as InMemoryWorkflowQueue;
    for (let round = 0; round < 50; round += 1) {
      const jobs = memory.take();
      if (jobs.length === 0) break;
      for (const job of jobs) statuses.push((await service.processJob(job, workerId)).status);
    }
    return statuses;
  }

  function generationBody(extra: Record<string, unknown> = {}): Record<string, unknown> {
    return { definitionKey: "GENERATION", channelId, ideaId, ...extra };
  }

  beforeAll(async () => {
    if (!db) return;
    await db.user.createMany({
      data: [ownerId, editorId, viewerId, otherOwnerId].map((id) => ({
        id,
        email: `${id}@m16.integration.invalid`,
      })),
    });
    await db.workspace.createMany({
      data: [
        { id: workspaceId, name: "m16-integration" },
        { id: otherWorkspaceId, name: "other-m16-integration" },
      ],
    });
    await db.workspaceMembership.createMany({
      data: [
        { workspaceId, userId: ownerId, role: "OWNER" },
        { workspaceId, userId: editorId, role: "EDITOR" },
        { workspaceId, userId: viewerId, role: "VIEWER" },
        { workspaceId: otherWorkspaceId, userId: otherOwnerId, role: "OWNER" },
      ],
    });
    await db.channel.createMany({
      data: [
        {
          id: channelId,
          workspaceId,
          name: "m16-active",
          timezone: "America/New_York",
          schedule: { time: "09:00", frequency: "DAILY", input: { ideaId } },
        },
        {
          id: pausedChannelId,
          workspaceId,
          name: "m16-paused",
          timezone: "Asia/Kolkata",
          status: "PAUSED",
          schedule: { time: "13:30", frequency: "DAILY", input: { ideaId } },
        },
        { id: otherChannelId, workspaceId: otherWorkspaceId, name: "m16-other" },
      ],
    });
  });

  beforeEach(async () => {
    if (!db) return;
    clockMs = Date.parse("2026-11-10T08:00:00.000Z");
    qualityStatus.clear();
    await db.workflowLimitLease.deleteMany({ where: { workspaceId } });
    await db.channel.updateMany({ where: { id: channelId }, data: { status: "ACTIVE" } });
  });

  afterAll(async () => {
    if (!db || !secondDb) return;
    await db.workspace.deleteMany({ where: { id: { in: [workspaceId, otherWorkspaceId] } } });
    await db.user.deleteMany({
      where: { id: { in: [ownerId, editorId, viewerId, otherOwnerId] } },
    });
    await db.$disconnect();
    await secondDb.$disconnect();
  });

  it("persists a manual run as NOT_CONFIGURED without Redis and dispatches it once a queue exists", async () => {
    if (!db) return;
    const offline = build({ queue: new NotConfiguredWorkflowQueue() });
    const run = await offline.service.startManualRun(editor, generationBody());
    expect(run).toMatchObject({
      state: "QUEUED",
      trigger: "MANUAL",
      dispatchStatus: "NOT_CONFIGURED",
      budgetDecision: "NOT_CONFIGURED",
      nextAction: "Configure REDIS_URL to dispatch workflow jobs",
    });
    expect(run.steps.every((step) => step.status === "PENDING")).toBe(true);

    const online = build();
    await expect(online.service.dispatchUndispatchedRuns({ workspaceId })).resolves.toBe(1);
    await expect(online.service.dispatchUndispatchedRuns({ workspaceId })).resolves.toBe(0);
    const statuses = await drain(online.service, online.queue);
    expect(statuses.at(-1)).toBe("WAITING_APPROVAL");
    const after = await online.service.getRun(owner, run.id);
    expect(after.dispatchStatus).toBe("DISPATCHED");
    expect(after.state).toBe("WAITING_APPROVAL");
  });

  it("runs manual and scheduled triggers through the same definition and state machine", async () => {
    if (!db) return;
    const { service, queue, dispatcher } = build({ budget: new StaticBudgetPolicy("ALLOWED") });
    const manual = await service.startManualRun(owner, generationBody());
    // 09:00 America/New_York on 2026-11-10 is 14:00Z (EST, after the fall-back transition).
    clockMs = Date.parse("2026-11-10T14:01:00.000Z");
    const tick = await service.runSchedulerTick(clock());
    expect(tick.startedRuns).toBe(1);
    const second = await service.runSchedulerTick(clock());
    expect(second.startedRuns).toBe(0);
    const runs = await service.listRuns(owner);
    const scheduled = runs.find(
      (run) => run.trigger === "SCHEDULED" && run.channelId === channelId,
    );
    if (!scheduled) throw new Error("scheduled run missing");
    expect(scheduled.definitionKey).toBe(manual.definitionKey);
    expect(scheduled.steps.map((step) => step.stepKey)).toEqual(
      manual.steps.map((step) => step.stepKey),
    );
    await drain(service, queue);
    for (const id of [manual.id, scheduled.id]) {
      const run = await service.getRun(owner, id);
      expect(run.state).toBe("WAITING_APPROVAL");
      expect(run.currentStepKey).toBe("QUALITY_REVIEW");
      expect(run.nextAction).toContain("Approve quality review");
      expect(dispatcher.count(id, "GENERATE_SCRIPT")).toBe(1);
    }
    const slots = await db.workflowScheduleSlot.findMany({ where: { channelId } });
    expect(slots).toHaveLength(1);
    expect(slots[0]).toMatchObject({ slotKey: "GENERATION:2026-11-10T09:00", status: "STARTED" });
  });

  it("blocks scheduled runs when the budget policy is not configured but allows manual runs", async () => {
    if (!db) return;
    const { service, queue, dispatcher } = build();
    clockMs = Date.parse("2026-11-11T14:02:00.000Z");
    await service.runSchedulerTick(clock());
    const scheduled = (await service.listRuns(owner)).find(
      (run) =>
        run.trigger === "SCHEDULED" &&
        run.input["channelId"] === channelId &&
        run.state === "PAUSED",
    );
    if (!scheduled) throw new Error("budget-blocked scheduled run missing");
    expect(scheduled).toMatchObject({
      budgetDecision: "NOT_CONFIGURED",
      budgetReason: "BUDGET_POLICY_UNAVAILABLE",
      pausedReason: "BUDGET_POLICY_UNAVAILABLE",
      nextAction: "Configure a budget policy before scheduled generation",
    });
    expect((queue as InMemoryWorkflowQueue).peek()).toHaveLength(0);
    await expect(service.resumeRun(owner, scheduled.id)).rejects.toBeInstanceOf(ConflictException);
    expect(dispatcher.calls.filter((call) => call.runId === scheduled.id)).toHaveLength(0);

    const manual = await service.startManualRun(editor, generationBody());
    expect(manual).toMatchObject({ state: "QUEUED", budgetDecision: "NOT_CONFIGURED" });
    expect((queue as InMemoryWorkflowQueue).peek()).toHaveLength(1);
  });

  it("starts no autonomous run for a paused channel and refuses manual starts on it", async () => {
    if (!db) return;
    const { service } = build({ budget: new StaticBudgetPolicy("ALLOWED") });
    // 13:30 Asia/Kolkata is 08:00Z.
    clockMs = Date.parse("2026-11-12T08:01:00.000Z");
    const tick = await service.runSchedulerTick(clock());
    expect(tick.skippedSlots).toBeGreaterThanOrEqual(1);
    const slot = await db.workflowScheduleSlot.findFirst({ where: { channelId: pausedChannelId } });
    expect(slot).toMatchObject({ status: "SKIPPED", reason: "CHANNEL_PAUSED", runId: null });
    expect(await db.workflowRun.count({ where: { channelId: pausedChannelId } })).toBe(0);
    await expect(
      service.startManualRun(owner, generationBody({ channelId: pausedChannelId })),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it("waits for human approval and only advances after the M11 review is approved", async () => {
    if (!db) return;
    const { service, queue, dispatcher } = build();
    const run = await service.startManualRun(owner, generationBody());
    await drain(service, queue);
    const waiting = await service.getRun(owner, run.id);
    expect(waiting.state).toBe("WAITING_APPROVAL");
    const review = waiting.steps.find((step) => step.stepKey === "QUALITY_REVIEW");
    expect(review).toMatchObject({ status: "WAITING_APPROVAL", resultRef: `review-${run.id}` });
    await expect(service.resumeRun(owner, run.id)).rejects.toThrow(/still pending/);
    qualityStatus.set(`review-${run.id}`, "APPROVED");
    const done = await service.resumeRun(editor, run.id);
    expect(done.state).toBe("SUCCEEDED");
    expect(done.events.map((event) => event.eventType)).toContain("WORKFLOW_APPROVAL_GRANTED");
    await expect(service.resumeRun(owner, run.id)).rejects.toBeInstanceOf(ConflictException);
    expect(dispatcher.count(run.id, "QUALITY_REVIEW")).toBe(1);
  });

  it("treats redelivery and worker restart of a succeeded step as a no-op", async () => {
    if (!db) return;
    const { service, queue, dispatcher } = build();
    const run = await service.startManualRun(owner, generationBody());
    const first = (queue as InMemoryWorkflowQueue).take();
    expect(first).toHaveLength(1);
    const job = first[0];
    if (!job) throw new Error("job missing");
    await expect(service.processJob(job, "worker-a")).resolves.toMatchObject({
      status: "STEP_SUCCEEDED",
    });
    await expect(service.processJob(job, "worker-a")).resolves.toMatchObject({ status: "NOOP" });
    const restarted = build({ dispatcher });
    await expect(restarted.service.processJob(job, "worker-b")).resolves.toMatchObject({
      status: "NOOP",
      detail: "step already completed",
    });
    expect(dispatcher.count(run.id, "VERIFY_CONTEXT")).toBe(1);
    await drain(service, queue);
    const scriptJobs = await db.workflowJob.findMany({ where: { runId: run.id } });
    for (const replay of scriptJobs)
      await restarted.service.processJob(replay.payload as never, "worker-b");
    for (const key of ["SELECT_IDEA", "GENERATE_SCRIPT", "GENERATE_SCENE_MEDIA"] as const)
      expect(dispatcher.count(run.id, key)).toBe(1);
    const inspected = await service.getRun(owner, run.id);
    for (const step of inspected.steps.filter((item) => item.status === "SUCCEEDED"))
      expect(step.resultRef).not.toBeNull();
  });

  it("lets only one of two workers claim the same delivered job", async () => {
    if (!db || !secondDb) return;
    const gate: { release: () => void } = { release: () => undefined };
    const blocked = new Promise<void>((resolve) => {
      gate.release = resolve;
    });
    const dispatcher = new FixtureDispatcher();
    dispatcher.behaviors.set("VERIFY_CONTEXT", async (input) => {
      await blocked;
      return { resultRef: input.runId, resultType: "CHANNEL" };
    });
    const a = build({ dispatcher });
    const b = build({ dispatcher, database: secondDb });
    const run = await a.service.startManualRun(owner, generationBody());
    const job = (a.queue as InMemoryWorkflowQueue).take()[0];
    if (!job) throw new Error("job missing");
    const pa = a.service.processJob(job, "worker-a");
    const pb = b.service.processJob(job, "worker-b");
    setTimeout(() => gate.release(), 200);
    const results = await Promise.all([pa, pb]);
    expect(results.map((result) => result.status).sort()).toEqual(["NOOP", "STEP_SUCCEEDED"]);
    expect(dispatcher.count(run.id, "VERIFY_CONTEXT")).toBe(1);
  });

  it("dead-letters a step after max attempts and allows retry from the failed step", async () => {
    if (!db) return;
    const { service, queue, dispatcher } = build();
    let fail = true;
    dispatcher.behaviors.set("SELECT_IDEA", async (input) => {
      if (fail) throw new WorkflowStepError("IDEA_UNAVAILABLE", "idea service busy", true);
      return { resultRef: `idea-${input.runId}`, resultType: "IDEA_APPROVAL_SNAPSHOT" };
    });
    const run = await service.startManualRun(owner, generationBody());
    const statuses = await drain(service, queue);
    expect(statuses).toEqual(["STEP_SUCCEEDED", "RETRY_WAIT", "RETRY_WAIT", "FAILED"]);
    const failed = await service.getRun(owner, run.id);
    expect(failed).toMatchObject({ state: "FAILED", lastErrorCode: "IDEA_UNAVAILABLE" });
    const step = failed.steps.find((item) => item.stepKey === "SELECT_IDEA");
    expect(step).toMatchObject({ status: "FAILED", attempts: 3 });
    const jobs = failed.jobs.filter((job) => job.stepId === step?.id);
    expect(jobs.map((job) => job.status)).toEqual(["RETRY_WAIT", "RETRY_WAIT", "DEAD_LETTER"]);
    expect(jobs.at(-1)?.deadLetteredAt).not.toBeNull();
    expect(failed.nextAction).toContain("retry");

    fail = false;
    const retried = await service.retryFromFailedStep(editor, run.id);
    expect(retried.state).toBe("QUEUED");
    expect(retried.steps.find((item) => item.stepKey === "SELECT_IDEA")).toMatchObject({
      status: "QUEUED",
      attempts: 0,
      retryGeneration: 1,
    });
    await drain(service, queue);
    const resumed = await service.getRun(owner, run.id);
    expect(resumed.state).toBe("WAITING_APPROVAL");
    expect(dispatcher.count(run.id, "VERIFY_CONTEXT")).toBe(1);
    expect(dispatcher.count(run.id, "GENERATE_SCRIPT")).toBe(1);
    expect(new Set(resumed.jobs.map((job) => job.jobId)).size).toBe(resumed.jobs.length);
  });

  it("resolves a concurrent cancel and retry with exactly one winner and one 409", async () => {
    if (!db) return;
    const dispatcher = new FixtureDispatcher();
    dispatcher.behaviors.set("VERIFY_CONTEXT", async () => {
      throw new WorkflowStepError("CHANNEL_ARCHIVED", "fixture failure", false);
    });
    const { service, queue } = build({ dispatcher });
    for (let round = 0; round < 3; round += 1) {
      const run = await service.startManualRun(owner, generationBody());
      await drain(service, queue);
      expect((await service.getRun(owner, run.id)).state).toBe("FAILED");
      // Both contenders observe FAILED before either compare-and-swap runs.
      let arrived = 0;
      let open: () => void = () => undefined;
      const barrier = new Promise<void>((resolve) => {
        open = resolve;
      });
      const gated = new Proxy(db, {
        get(target, property): unknown {
          if (property === "workflowRun")
            return new Proxy(target.workflowRun, {
              get(delegate, key): unknown {
                const value = Reflect.get(delegate, key) as unknown;
                if (key !== "updateMany" || typeof value !== "function")
                  return typeof value === "function" ? value.bind(delegate) : value;
                return async (...args: unknown[]): Promise<unknown> => {
                  arrived += 1;
                  if (arrived === 2) open();
                  if (arrived <= 2) await Promise.race([barrier, sleep(2_000)]);
                  return (value as (...inner: unknown[]) => unknown).apply(delegate, args);
                };
              },
            });
          const value = Reflect.get(target, property) as unknown;
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      const contender = build({ dispatcher, database: gated as typeof db, queue });
      const results = await Promise.allSettled([
        contender.service.cancelRun(owner, run.id),
        contender.service.retryFromFailedStep(editor, run.id),
      ]);
      const fulfilled = results.filter((result) => result.status === "fulfilled");
      const rejected = results.filter((result) => result.status === "rejected");
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(ConflictException);
      const final = await service.getRun(owner, run.id);
      expect(["CANCELED", "QUEUED"]).toContain(final.state);
      (queue as InMemoryWorkflowQueue).take();
    }
  });

  it("pauses an in-flight run when its channel is paused and resumes safely", async () => {
    if (!db) return;
    const { service, queue, dispatcher } = build();
    const run = await service.startManualRun(owner, generationBody());
    const first = (queue as InMemoryWorkflowQueue).take()[0];
    if (!first) throw new Error("job missing");
    await db.channel.updateMany({ where: { id: channelId }, data: { status: "PAUSED" } });
    await service.processJob(first, "worker-a");
    const paused = await service.getRun(owner, run.id);
    expect(paused).toMatchObject({
      state: "PAUSED",
      pausedReason: "CHANNEL_PAUSED",
      currentStepKey: "SELECT_IDEA",
    });
    expect((queue as InMemoryWorkflowQueue).peek()).toHaveLength(0);
    await expect(service.resumeRun(owner, run.id)).rejects.toBeInstanceOf(ConflictException);
    await db.channel.updateMany({ where: { id: channelId }, data: { status: "ACTIVE" } });
    const resumed = await service.resumeRun(editor, run.id);
    expect(resumed.state).toBe("QUEUED");
    await drain(service, queue);
    expect((await service.getRun(owner, run.id)).state).toBe("WAITING_APPROVAL");
    expect(dispatcher.count(run.id, "VERIFY_CONTEXT")).toBe(1);
    expect(dispatcher.count(run.id, "SELECT_IDEA")).toBe(1);
  });

  it("recovers stale leases to retryable or RECONCILIATION_REQUIRED without re-running side effects", async () => {
    if (!db) return;
    const gate: { release: () => void } = { release: () => undefined };
    const blocked = new Promise<void>((resolve) => {
      gate.release = resolve;
    });
    const dispatcher = new FixtureDispatcher();
    dispatcher.behaviors.set("GENERATE_SCRIPT", async (input) => {
      await blocked;
      return { resultRef: `script-${input.runId}`, resultType: "SCRIPT" };
    });
    const { service, queue } = build({ dispatcher });
    const run = await service.startManualRun(owner, generationBody());
    const memory = queue as InMemoryWorkflowQueue;
    for (let index = 0; index < 2; index += 1) {
      const job = memory.take()[0];
      if (job) await service.processJob(job, "worker-a");
    }
    const scriptJob = memory.take()[0];
    if (!scriptJob) throw new Error("script job missing");
    const inFlight = service.processJob(scriptJob, "worker-crashed");
    await sleep(150);
    clockMs += DEFAULT_WORKFLOW_LIMIT_CONFIG.stepLeaseTtlMs + 1_000;
    await expect(service.recoverStaleLeases(clock(), { workspaceId })).resolves.toBe(1);
    gate.release();
    await expect(inFlight).resolves.toMatchObject({ status: "NOOP" });
    const recovered = await service.getRun(owner, run.id);
    expect(recovered).toMatchObject({ state: "FAILED", lastErrorCode: "STALE_LEASE" });
    expect(recovered.steps.find((step) => step.stepKey === "GENERATE_SCRIPT")).toMatchObject({
      status: "RECONCILIATION_REQUIRED",
      resultRef: `script-${run.id}`,
    });
    expect(memory.peek()).toHaveLength(0);
    expect(dispatcher.count(run.id, "GENERATE_SCRIPT")).toBe(1);

    // A non-side-effect step is returned to RETRY_WAIT and re-dispatched with a new job id.
    const second = await service.startManualRun(owner, generationBody());
    const verify = second.steps[0];
    if (!verify) throw new Error("step missing");
    memory.take();
    await db.workflowStep.updateMany({
      where: { id: verify.id },
      data: {
        status: "RUNNING",
        attempts: 1,
        leaseOwner: "worker-crashed",
        leaseExpiresAt: new Date(clockMs - 1),
      },
    });
    await expect(service.recoverStaleLeases(clock(), { workspaceId })).resolves.toBe(1);
    const retrying = await service.getRun(owner, second.id);
    expect(retrying.steps[0]).toMatchObject({ status: "RETRY_WAIT", errorCode: "STALE_LEASE" });
    expect(memory.peek().map((job) => job.attempt)).toEqual([2]);
  });

  it("enforces Postgres concurrency limits across two workers", async () => {
    if (!db || !secondDb) return;
    const limitsA = new WorkflowLimitsService(db as never, DEFAULT_WORKFLOW_LIMIT_CONFIG);
    const limitsB = new WorkflowLimitsService(secondDb as never, DEFAULT_WORKFLOW_LIMIT_CONFIG);
    const scopeKey = `limit-${randomUUID()}`;
    const now = clock();
    const attempts = await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        (index % 2 === 0 ? limitsA : limitsB).acquireLease({
          workspaceId,
          scope: "PROVIDER",
          scopeKey,
          holderId: `holder-${index}`,
          limit: 2,
          now,
        }),
      ),
    );
    expect(attempts.filter((slot) => slot !== null).sort()).toEqual([0, 1]);
    const expired = new Date(now.getTime() + DEFAULT_WORKFLOW_LIMIT_CONFIG.leaseTtlMs + 1);
    await expect(
      limitsB.acquireLease({
        workspaceId,
        scope: "PROVIDER",
        scopeKey,
        holderId: "after-expiry",
        limit: 2,
        now: expired,
      }),
    ).resolves.not.toBeNull();

    const rateKey = `rate-${randomUUID()}`;
    const consumed = await Promise.all(
      Array.from({ length: 6 }, (_, index) =>
        (index % 2 === 0 ? limitsA : limitsB).consumeRate({
          workspaceId,
          scope: "WORKSPACE",
          scopeKey: rateKey,
          limit: 4,
          now,
        }),
      ),
    );
    expect(consumed.filter(Boolean)).toHaveLength(4);

    // Two orchestration workers with job-type concurrency 1: one dispatches, the other waits.
    const gate: { release: () => void } = { release: () => undefined };
    const blocked = new Promise<void>((resolve) => {
      gate.release = resolve;
    });
    const dispatcher = new FixtureDispatcher();
    dispatcher.behaviors.set("VERIFY_CONTEXT", async (input) => {
      await blocked;
      return { resultRef: input.runId, resultType: "CHANNEL" };
    });
    const a = build({ dispatcher, limits: { jobTypeConcurrency: 1 } });
    const b = build({ dispatcher, limits: { jobTypeConcurrency: 1 }, database: secondDb });
    await db.workflowLimitLease.deleteMany({
      where: { scope: "JOB_TYPE", scopeKey: "VERIFY_CONTEXT" },
    });
    const runA = await a.service.startManualRun(owner, generationBody());
    const runB = await b.service.startManualRun(owner, generationBody());
    const jobA = (a.queue as InMemoryWorkflowQueue).take()[0];
    const jobB = (b.queue as InMemoryWorkflowQueue).take()[0];
    if (!jobA || !jobB) throw new Error("jobs missing");
    const first = a.service.processJob(jobA, "worker-a");
    await sleep(150);
    const second = await b.service.processJob(jobB, "worker-b");
    gate.release();
    expect((await first).status).toBe("STEP_SUCCEEDED");
    expect(second.status).toBe("LIMIT_WAIT");
    expect(dispatcher.count(runA.id, "VERIFY_CONTEXT")).toBe(1);
    expect(dispatcher.count(runB.id, "VERIFY_CONTEXT")).toBe(0);
    const waiting = await b.service.getRun(owner, runB.id);
    expect(waiting).toMatchObject({ state: "RETRY_WAIT", lastErrorCode: "WORKFLOW_LIMIT" });
    expect((b.queue as InMemoryWorkflowQueue).peek()).toHaveLength(1);
  });

  it("denies viewer writes, allows viewer reads, and denies cross-tenant access", async () => {
    if (!db) return;
    const { service } = build();
    const run = await service.startManualRun(owner, generationBody());
    await expect(service.startManualRun(viewer, generationBody())).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    await expect(service.cancelRun(viewer, run.id)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(service.getRun(viewer, run.id)).resolves.toMatchObject({ id: run.id });
    expect((await service.listRuns(viewer)).some((item) => item.id === run.id)).toBe(true);

    await expect(service.getRun(otherOwner, run.id)).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.cancelRun(otherOwner, run.id)).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.retryFromFailedStep(otherOwner, run.id)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(service.resumeRun(otherOwner, run.id)).rejects.toBeInstanceOf(NotFoundException);
    expect((await service.listRuns(otherOwner)).some((item) => item.id === run.id)).toBe(false);
    await expect(
      service.startManualRun(otherOwner, generationBody({ channelId })),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect((await service.getRun(owner, run.id)).state).toBe("QUEUED");
  });

  it("carries the run correlation id through steps, jobs, dispatch, and event history", async () => {
    if (!db) return;
    const { service, queue, dispatcher } = build();
    const run = await service.startManualRun(owner, generationBody());
    await drain(service, queue);
    const inspected = await service.getRun(owner, run.id);
    expect(inspected.events.length).toBeGreaterThan(6);
    expect(new Set(inspected.events.map((event) => event.correlationId))).toEqual(
      new Set([run.correlationId]),
    );
    const jobs = await db.workflowJob.findMany({ where: { runId: run.id } });
    for (const job of jobs)
      expect((job.payload as { correlationId: string }).correlationId).toBe(run.correlationId);
    const started = inspected.events.filter((event) => event.eventType === "WORKFLOW_STEP_STARTED");
    expect(started.every((event) => event.jobId !== null && event.stepId !== null)).toBe(true);
    for (const call of dispatcher.calls.filter((item) => item.runId === run.id)) {
      expect(call.correlationId).toBe(run.correlationId);
      expect(call.idempotencyKey).toBe(`GENERATION:${run.id}:${call.stepKey}`);
      expect(call.context.role).toBe("OWNER");
    }
  });
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
