import { ForbiddenException } from "@nestjs/common";
import { describe, expect, it } from "vitest";
import { StaticBudgetPolicy, UnconfiguredBudgetPolicy } from "./orchestration.budget.js";
import {
  createWorkflowQueueFromEnv,
  parseRedisConnection,
  redisClientAvailable,
} from "./orchestration.bullmq.js";
import { workflowDefinition } from "./orchestration.definitions.js";
import {
  InMemoryWorkflowQueue,
  NotConfiguredWorkflowQueue,
  deterministicJobId,
} from "./orchestration.queue.js";
import { OrchestrationService } from "./orchestration.service.js";
import { ORCHESTRATION_QUEUE_NAME, type WorkflowQueueJob } from "./orchestration.types.js";

const workspaceId = "16161616-1616-4161-8161-161616161601";
const runId = "16161616-1616-4161-8161-161616161602";
const stepId = "16161616-1616-4161-8161-161616161603";
const viewer = {
  workspaceId,
  userId: "16161616-1616-4161-8161-161616161604",
  role: "VIEWER" as const,
};

function job(attempt: number, generation = 0): WorkflowQueueJob {
  return {
    jobId: deterministicJobId(runId, stepId, attempt, generation),
    queueName: ORCHESTRATION_QUEUE_NAME,
    workspaceId,
    runId,
    stepId,
    attempt,
    correlationId: "16161616-1616-4161-8161-161616161605",
    maxAttempts: 3,
    delayMs: 0,
  };
}

function serviceWithoutDatabase(): OrchestrationService {
  const untouchable = new Proxy(
    {},
    {
      get: (): never => {
        throw new Error("database must not be touched");
      },
    },
  );
  return new OrchestrationService(
    untouchable as never,
    new InMemoryWorkflowQueue(),
    untouchable as never,
    new UnconfiguredBudgetPolicy(),
    untouchable as never,
    untouchable as never,
    untouchable as never,
    () => new Date("2026-11-10T00:00:00.000Z"),
  );
}

describe("workflow queue port", () => {
  it("derives deterministic job ids from run, step, retry generation, and attempt", () => {
    expect(deterministicJobId(runId, stepId, 2, 1)).toBe(`${runId}.${stepId}.1.2`);
    expect(job(1).jobId).toBe(job(1).jobId);
    expect(job(1).jobId).not.toBe(job(2).jobId);
    expect(job(1, 0).jobId).not.toBe(job(1, 1).jobId);
    expect(job(1).jobId).not.toContain(":");
  });

  it("deduplicates queued and already delivered job ids in memory", async () => {
    const queue = new InMemoryWorkflowQueue();
    await expect(queue.enqueue(job(1))).resolves.toBe("ENQUEUED");
    await expect(queue.enqueue(job(1))).resolves.toBe("DUPLICATE");
    expect(queue.take()).toHaveLength(1);
    await expect(queue.enqueue(job(1))).resolves.toBe("DUPLICATE");
    await expect(queue.enqueue(job(2))).resolves.toBe("ENQUEUED");
    expect(queue.peek().map((item) => item.attempt)).toEqual([2]);
  });

  it("reports NOT_CONFIGURED without Redis and never crashes", async () => {
    const queue = createWorkflowQueueFromEnv({});
    expect(queue).toBeInstanceOf(NotConfiguredWorkflowQueue);
    expect(queue.status).toBe("NOT_CONFIGURED");
    await expect(queue.enqueue(job(1))).resolves.toBe("NOT_CONFIGURED");
    await expect(queue.close()).resolves.toBeUndefined();
    expect(createWorkflowQueueFromEnv({ REDIS_URL: "   " }).status).toBe("NOT_CONFIGURED");
  });

  it("degrades to NOT_CONFIGURED instead of crashing when the Redis client peer is missing", async () => {
    const queue = createWorkflowQueueFromEnv({ REDIS_URL: "redis://127.0.0.1:1" });
    if (redisClientAvailable()) {
      expect(queue.status).toBe("CONFIGURED");
      await queue.close();
      return;
    }
    expect(queue).toBeInstanceOf(NotConfiguredWorkflowQueue);
    expect((queue as NotConfiguredWorkflowQueue).reason).toBe("REDIS_CLIENT_UNAVAILABLE");
  });

  it("parses redis connection URLs and rejects other protocols", () => {
    expect(parseRedisConnection("redis://user:p%40ss@127.0.0.1:56379/2")).toEqual({
      host: "127.0.0.1",
      port: 56379,
      username: "user",
      password: "p@ss",
      db: 2,
    });
    expect(parseRedisConnection("rediss://cache.invalid")).toMatchObject({ port: 6379, tls: {} });
    expect(() => parseRedisConnection("http://127.0.0.1:6379")).toThrow(/redis/);
  });
});

describe("budget policy port", () => {
  it("defaults to NOT_CONFIGURED with BUDGET_POLICY_UNAVAILABLE", async () => {
    await expect(new UnconfiguredBudgetPolicy().evaluate()).resolves.toEqual({
      decision: "NOT_CONFIGURED",
      reason: "BUDGET_POLICY_UNAVAILABLE",
    });
    await expect(new StaticBudgetPolicy("BLOCKED", "CAP").evaluate()).resolves.toEqual({
      decision: "BLOCKED",
      reason: "CAP",
    });
  });
});

describe("workflow definitions", () => {
  it("chains generation from idea through approval and publish into analytics follow-up", () => {
    expect(workflowDefinition("GENERATION").map((step) => step.key)).toEqual([
      "VERIFY_CONTEXT",
      "SELECT_IDEA",
      "GENERATE_SCRIPT",
      "GENERATE_SCENE_MEDIA",
      "COMPOSE_RENDER",
      "QUALITY_REVIEW",
    ]);
    expect(workflowDefinition("PUBLISH").map((step) => step.key)).toEqual([
      "VERIFY_CONTEXT",
      "PUBLISH",
      "ANALYTICS_FOLLOW_UP",
    ]);
    for (const key of ["GENERATION", "PUBLISH", "ANALYTICS"] as const) {
      const steps = workflowDefinition(key);
      expect(steps.map((step) => step.sequence)).toEqual(steps.map((_, index) => index + 1));
      for (const step of steps)
        if (step.key !== "VERIFY_CONTEXT" && step.key !== "SELECT_IDEA")
          expect(step.sideEffect).toBe(true);
    }
  });
});

describe("orchestration permissions", () => {
  it("denies viewer writes before touching the database", async () => {
    const service = serviceWithoutDatabase();
    await expect(service.startManualRun(viewer, {})).rejects.toBeInstanceOf(ForbiddenException);
    await expect(service.cancelRun(viewer, runId)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(service.retryFromFailedStep(viewer, runId)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    await expect(service.resumeRun(viewer, runId)).rejects.toBeInstanceOf(ForbiddenException);
  });
});
