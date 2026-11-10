import { hostname } from "node:os";
import { Worker } from "bullmq";
import type { Job } from "bullmq";
import {
  ORCHESTRATION_QUEUE_NAME,
  parseRedisConnection,
  type WorkflowQueueJob,
} from "@reelforge/api/orchestration-queue";
import { OrchestrationService } from "@reelforge/api/orchestration-service";

export type OrchestrationConsumer = Readonly<{
  worker: Worker<WorkflowQueueJob>;
  close: () => Promise<void>;
}>;

export function createOrchestrationConsumer(
  service: OrchestrationService,
  redisUrl: string,
  options: {
    readonly concurrency?: number;
    readonly onError?: (error: unknown, job: Job<WorkflowQueueJob> | undefined) => void;
  } = {},
): OrchestrationConsumer {
  const workerId = `${hostname()}:${process.pid}`;
  const worker = new Worker<WorkflowQueueJob>(
    ORCHESTRATION_QUEUE_NAME,
    async (job) => service.processJob(job.data, workerId),
    {
      connection: parseRedisConnection(redisUrl),
      concurrency: options.concurrency ?? 1,
    },
  );
  worker.on("failed", (job, error) => {
    if (options.onError) options.onError(error, job);
    else console.error("[orchestration-worker] job failed; dead-letter state persisted", error);
  });
  worker.on("error", (error) => {
    if (options.onError) options.onError(error, undefined);
    else console.error("[orchestration-worker] queue error", error);
  });
  return {
    worker,
    close: async (): Promise<void> => {
      await worker.close();
    },
  };
}
