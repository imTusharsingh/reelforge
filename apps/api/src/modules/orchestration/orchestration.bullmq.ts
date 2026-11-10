import { createRequire } from "node:module";
import { Queue } from "bullmq";
import type { ConnectionOptions } from "bullmq";
import { NotConfiguredWorkflowQueue } from "./orchestration.queue.js";
import {
  ORCHESTRATION_QUEUE_NAME,
  type WorkflowQueueEnqueueResult,
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

export class BullMqWorkflowQueue implements WorkflowQueuePort {
  public readonly status = "CONFIGURED" as const;
  private readonly queue: Queue<WorkflowQueueJob>;

  public constructor(redisUrl: string, queueName: string = ORCHESTRATION_QUEUE_NAME) {
    this.queue = new Queue<WorkflowQueueJob>(queueName, {
      connection: parseRedisConnection(redisUrl),
    });
  }

  public async enqueue(job: WorkflowQueueJob): Promise<WorkflowQueueEnqueueResult> {
    const existing = await this.queue.getJob(job.jobId);
    if (existing) return "DUPLICATE";
    await this.queue.add("workflow-step", job, {
      jobId: job.jobId,
      attempts: 1,
      delay: job.delayMs,
      removeOnComplete: { count: 1000 },
      removeOnFail: { count: 1000 },
    });
    return "ENQUEUED";
  }

  public async close(): Promise<void> {
    await this.queue.close();
  }
}

/**
 * BullMQ 6 loads its Redis client (`ioredis` or `redis`) as an optional peer dependency.
 * Neither is pinned in this repository yet, so detect it instead of crashing at startup.
 */
export function redisClientAvailable(): boolean {
  const local = createRequire(import.meta.url);
  let bullmqEntry: string;
  try {
    bullmqEntry = local.resolve("bullmq");
  } catch {
    return false;
  }
  const fromBullmq = createRequire(bullmqEntry);
  for (const client of ["ioredis", "redis"]) {
    try {
      fromBullmq.resolve(client);
      return true;
    } catch {
      // try the next supported client
    }
  }
  return false;
}

export function createWorkflowQueueFromEnv(env: NodeJS.ProcessEnv): WorkflowQueuePort {
  const redisUrl = env.REDIS_URL?.trim();
  if (redisUrl === undefined || redisUrl.length === 0)
    return new NotConfiguredWorkflowQueue("REDIS_URL_UNSET");
  if (!redisClientAvailable()) {
    console.warn(
      "[orchestration] REDIS_URL is set but no BullMQ Redis client (ioredis/redis) is installed; dispatch is NOT_CONFIGURED",
    );
    return new NotConfiguredWorkflowQueue("REDIS_CLIENT_UNAVAILABLE");
  }
  return new BullMqWorkflowQueue(redisUrl);
}
