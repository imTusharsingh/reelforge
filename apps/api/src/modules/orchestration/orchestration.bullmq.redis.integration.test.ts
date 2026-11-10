import { randomUUID } from "node:crypto";
import { Queue, Worker } from "bullmq";
import { createDatabaseClient } from "@reelforge/database";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ChannelService } from "../channel/channel.service.js";
import { UnconfiguredBudgetPolicy } from "./orchestration.budget.js";
import { BullMqWorkflowQueue, parseRedisConnection } from "./orchestration.bullmq.js";
import { WorkflowLimitsService } from "./orchestration.limits.js";
import { deterministicJobId } from "./orchestration.queue.js";
import { OrchestrationService } from "./orchestration.service.js";
import {
  DEFAULT_WORKFLOW_LIMIT_CONFIG,
  type WorkflowQueueJob,
  type WorkflowStepDispatchInput,
  type WorkflowStepDispatchResult,
  type WorkflowStepDispatcherPort,
} from "./orchestration.types.js";

const redisUrl = process.env.REDIS_URL;
const databaseUrl = process.env.DATABASE_URL;
// Skips only when REDIS_URL or DATABASE_URL is unset; ioredis 5.11.1 is a pinned dependency.
const suite = describe.skipIf(redisUrl === undefined || databaseUrl === undefined);

const workspaceId = randomUUID();
const ownerId = randomUUID();
const channelId = randomUUID();
const queueName = `m16-test-${randomUUID()}`;

class CountingDispatcher implements WorkflowStepDispatcherPort {
  public readonly calls: WorkflowStepDispatchInput[] = [];

  public dispatchStep(input: WorkflowStepDispatchInput): Promise<WorkflowStepDispatchResult> {
    this.calls.push(input);
    if (input.stepKey === "QUALITY_REVIEW")
      return Promise.resolve({
        resultRef: `review-${input.runId}`,
        resultType: "QUALITY_REVIEW_RUN",
        waitingApproval: true,
      });
    return Promise.resolve({ resultRef: `${input.stepKey}-${input.runId}`, resultType: "FIXTURE" });
  }
}

suite("M16 BullMQ dispatch against Redis", () => {
  const db = databaseUrl === undefined ? undefined : createDatabaseClient(databaseUrl);
  const dispatcher = new CountingDispatcher();
  let queue: BullMqWorkflowQueue | undefined;
  let service: OrchestrationService | undefined;

  function startWorker(target: OrchestrationService, workerId: string): Worker<WorkflowQueueJob> {
    if (!redisUrl) throw new Error("REDIS_URL missing");
    return new Worker<WorkflowQueueJob>(
      queueName,
      async (job) => target.processJob(job.data, workerId),
      { connection: parseRedisConnection(redisUrl), concurrency: 2 },
    );
  }

  async function waitFor(check: () => Promise<boolean>, timeoutMs = 10_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await check()) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error("timed out waiting for workflow state");
  }

  beforeAll(async () => {
    if (!db || !redisUrl) return;
    await db.user.create({ data: { id: ownerId, email: `${ownerId}@m16.redis.invalid` } });
    await db.workspace.create({ data: { id: workspaceId, name: "m16-redis" } });
    await db.workspaceMembership.create({ data: { workspaceId, userId: ownerId, role: "OWNER" } });
    await db.channel.create({ data: { id: channelId, workspaceId, name: "m16-redis" } });
    queue = new BullMqWorkflowQueue(redisUrl, queueName);
    service = new OrchestrationService(
      db as never,
      queue,
      dispatcher,
      new UnconfiguredBudgetPolicy(),
      new WorkflowLimitsService(db as never, DEFAULT_WORKFLOW_LIMIT_CONFIG),
      new ChannelService(db as never),
      { get: async () => ({ status: "REVIEW_REQUIRED" }) } as never,
      () => new Date(),
    );
  });

  afterAll(async () => {
    if (!db || !redisUrl) return;
    await queue?.close();
    const admin = new Queue(queueName, { connection: parseRedisConnection(redisUrl) });
    await admin.obliterate({ force: true });
    await admin.close();
    await db.workspace.deleteMany({ where: { id: workspaceId } });
    await db.user.deleteMany({ where: { id: ownerId } });
    await db.$disconnect();
  });

  it("deduplicates deterministic job ids in BullMQ", async () => {
    if (!queue) return;
    const job: WorkflowQueueJob = {
      jobId: deterministicJobId(randomUUID(), randomUUID(), 1, 0),
      queueName,
      workspaceId,
      runId: randomUUID(),
      stepId: randomUUID(),
      attempt: 1,
      correlationId: randomUUID(),
      maxAttempts: 3,
      delayMs: 60_000,
    };
    await expect(queue.health()).resolves.toBe("CONFIGURED");
    await expect(queue.enqueue(job)).resolves.toBe("ENQUEUED");
    await expect(queue.enqueue(job)).resolves.toBe("DUPLICATE");
  });

  it("re-adds a finished job id so the recovery sweep can redeliver it", async () => {
    if (!queue || !redisUrl) return;
    const jobId = deterministicJobId(randomUUID(), randomUUID(), 1, 0);
    const job: WorkflowQueueJob = {
      jobId,
      queueName,
      workspaceId,
      runId: randomUUID(),
      stepId: randomUUID(),
      attempt: 1,
      correlationId: randomUUID(),
      maxAttempts: 3,
      delayMs: 0,
    };
    const seen: string[] = [];
    const worker = new Worker<WorkflowQueueJob>(
      queueName,
      async (delivered) => {
        seen.push(delivered.data.jobId);
        return Promise.resolve({ status: "NOOP" });
      },
      { connection: parseRedisConnection(redisUrl) },
    );
    await expect(queue.enqueue(job)).resolves.toBe("ENQUEUED");
    await waitFor(() => Promise.resolve(seen.length >= 1));
    // Wait until BullMQ has recorded the job as completed before re-adding it.
    const admin = new Queue(queueName, { connection: parseRedisConnection(redisUrl) });
    await waitFor(
      async () => (await admin.getJob(jobId).then((item) => item?.getState())) === "completed",
    );
    await expect(queue.enqueue(job)).resolves.toBe("ENQUEUED");
    await waitFor(() => Promise.resolve(seen.length >= 2));
    await worker.close();
    await admin.close();
    expect(seen).toEqual([jobId, jobId]);
  });

  it("dispatches a run end to end and does not repeat side effects after restart or redelivery", async () => {
    if (!db || !service || !queue) return;
    const target = service;
    const workerA = startWorker(target, "redis-worker-a");
    const run = await target.startManualRun(
      { workspaceId, userId: ownerId, role: "OWNER" },
      { definitionKey: "GENERATION", channelId, ideaId: randomUUID() },
    );
    expect(run.dispatchStatus).toBe("DISPATCHED");
    await waitFor(async () => {
      const current = await db.workflowRun.findUnique({ where: { id: run.id } });
      return current?.state === "WAITING_APPROVAL";
    });
    // Simulated worker crash/restart: close worker A, start worker B, and redeliver every
    // completed job payload under fresh BullMQ ids.
    await workerA.close();
    const workerB = startWorker(target, "redis-worker-b");
    const jobs = await db.workflowJob.findMany({ where: { runId: run.id } });
    const redeliver = new Queue<WorkflowQueueJob>(queueName, {
      connection: parseRedisConnection(redisUrl ?? ""),
    });
    for (const job of jobs) {
      const payload = job.payload as unknown as WorkflowQueueJob;
      await redeliver.add("workflow-step", payload, { jobId: `${payload.jobId}.redelivery` });
    }
    await waitFor(async () => (await redeliver.getCompletedCount()) >= jobs.length * 2);
    await redeliver.close();
    await workerB.close();
    const perStep = new Map<string, number>();
    for (const call of dispatcher.calls.filter((item) => item.runId === run.id))
      perStep.set(call.stepKey, (perStep.get(call.stepKey) ?? 0) + 1);
    expect([...perStep.values()].every((count) => count === 1)).toBe(true);
    expect(perStep.size).toBe(6);
    const final = await db.workflowRun.findUnique({ where: { id: run.id } });
    expect(final?.state).toBe("WAITING_APPROVAL");
  });
});
