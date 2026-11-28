import type { INestApplicationContext } from "@nestjs/common";
import { DelayedError, Worker } from "bullmq";
import { parseRedisConnection } from "@reelforge/api/orchestration-queue";

/** Resolve the exported Nest runtime token without changing API package exports. */
type VideoRunsRuntime = Readonly<{
  queueName: string;
  process: (payload: unknown) => Promise<number | null>;
  recover: () => Promise<void>;
}>;
export type VideoRunsConsumer = Readonly<{
  recover: () => Promise<void>;
  close: () => Promise<void>;
}>;
export async function createVideoRunsConsumer(
  app: INestApplicationContext,
  redisUrl: string,
): Promise<VideoRunsConsumer> {
  const runtime = app.get<VideoRunsRuntime>("VIDEO_RUN_RUNTIME");
  const concurrency = 4;
  const worker = new Worker<unknown>(
    runtime.queueName,
    async (job, token) => {
      const delay = await runtime.process(job.data);
      if (delay !== null) {
        await job.moveToDelayed(Date.now() + delay, token);
        throw new DelayedError();
      }
    },
    { connection: parseRedisConnection(redisUrl), concurrency },
  );
  worker.on("error", (error) => console.error("[video-run-worker] queue error", error));
  worker.on("failed", (_job, error) =>
    console.error("[video-run-worker] durable run paused or recoverable", error),
  );
  await worker.waitUntilReady();
  await runtime.recover();
  console.info("[video-run-worker] ready", { queue: runtime.queueName, concurrency });
  return { recover: () => runtime.recover(), close: () => worker.close() };
}
