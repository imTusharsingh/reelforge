import { Queue } from "bullmq";
import type { ConnectionOptions } from "bullmq";
import { NotConfiguredWorkflowQueue } from "./orchestration.queue.js";
import {
  ORCHESTRATION_QUEUE_NAME,
  type WorkflowQueueEnqueueResult,
  type WorkflowQueueHealth,
  type WorkflowQueueJob,
  type WorkflowQueuePort,
} from "./orchestration.types.js";

export function parseRedisConnection(redisUrl: string): ConnectionOptions {
  const url = new URL(redisUrl);
  if (url.protocol !== "redis:" && url.protocol !== "rediss:")
    throw new Error("REDIS_URL must use redis:// or rediss://");
  const dbValue = url.pathname.replace(/^\//, "");
  const options: ConnectionOptions = {
    host: url.hostname,
    port: url.port.length > 0 ? Number(url.port) : 6379,
  };
  if (url.username.length > 0) options.username = decodeURIComponent(url.username);
  if (url.password.length > 0) options.password = decodeURIComponent(url.password);
  if (dbValue.length > 0) options.db = Number(dbValue);
  if (url.protocol === "rediss:") options.tls = {};
  return options;
}

const REDIS_COMMAND_TIMEOUT_MS = 5_000;

async function withTimeout<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${String(ms)} ms (Redis unreachable?)`));
    }, ms);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export class BullMqWorkflowQueue implements WorkflowQueuePort {
  public readonly status = "CONFIGURED" as const;
  private readonly queue: Queue<WorkflowQueueJob>;

  public constructor(
    redisUrl: string,
    queueName: string = ORCHESTRATION_QUEUE_NAME,
    private readonly timeoutMs: number = REDIS_COMMAND_TIMEOUT_MS,
  ) {
    this.queue = new Queue<WorkflowQueueJob>(queueName, {
      connection: { ...parseRedisConnection(redisUrl), maxRetriesPerRequest: 1 },
    });
    // Connection errors surface through enqueue()/health(); keep them off the process event loop.
    this.queue.on("error", () => undefined);
  }

  /**
   * A pending job with the same deterministic id is a duplicate. A finished one (completed or
   * failed, e.g. a lost or crashed delivery) is removed and added again, so the recovery sweep can
   * re-dispatch a stalled step under the same id.
   */
  public async enqueue(job: WorkflowQueueJob): Promise<WorkflowQueueEnqueueResult> {
    return withTimeout(this.enqueueNow(job), this.timeoutMs, "Workflow enqueue");
  }

  /** Connects and runs a cheap Redis round-trip; any failure or timeout is UNREACHABLE. */
  public async health(): Promise<WorkflowQueueHealth> {
    try {
      await withTimeout(this.queue.waitUntilReady(), this.timeoutMs, "Redis connect");
      await withTimeout(this.queue.getJobCounts("waiting"), this.timeoutMs, "Redis ping");
      return "CONFIGURED";
    } catch {
      return "UNREACHABLE";
    }
  }

  public async close(): Promise<void> {
    await this.queue.close();
  }

  private async enqueueNow(job: WorkflowQueueJob): Promise<WorkflowQueueEnqueueResult> {
    const existing = await this.queue.getJob(job.jobId);
    if (existing) {
      const state = await existing.getState();
      if (state !== "completed" && state !== "failed") return "DUPLICATE";
      await existing.remove();
    }
    await this.queue.add("workflow-step", job, {
      jobId: job.jobId,
      attempts: 1,
      delay: job.delayMs,
      removeOnComplete: { count: 1000 },
      removeOnFail: { count: 1000 },
    });
    return "ENQUEUED";
  }
}

/**
 * Unset REDIS_URL means dispatch is NOT_CONFIGURED. A set REDIS_URL always builds the BullMQ
 * adapter (ioredis 5.11.1 is a pinned dependency), so a malformed URL throws at startup and an
 * unreachable server is reported as UNREACHABLE by health and fails enqueue loudly.
 */
export function createWorkflowQueueFromEnv(env: NodeJS.ProcessEnv): WorkflowQueuePort {
  const redisUrl = env.REDIS_URL?.trim();
  if (redisUrl === undefined || redisUrl.length === 0) return new NotConfiguredWorkflowQueue();
  return new BullMqWorkflowQueue(redisUrl);
}
