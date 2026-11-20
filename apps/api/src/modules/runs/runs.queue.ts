import { FlowProducer, Queue } from "bullmq";
import { createHash } from "node:crypto";
import { parseRedisConnection } from "./redis-connection.js";
import type { RunJob } from "./runs.types.js";

export type RunQueueHealth = "NOT_CONFIGURED" | "CONFIGURED" | "UNREACHABLE";

export const RUN_QUEUE = "video-runs-v3";
export class RunsQueue {
  private readonly queue: Queue<RunJob>;
  private readonly flows: FlowProducer;
  public constructor(redisUrl: string) {
    const connection = parseRedisConnection(redisUrl);
    this.queue = new Queue(RUN_QUEUE, { connection });
    this.flows = new FlowProducer({ connection });
    this.queue.on("error", () => undefined);
    this.flows.on("error", () => undefined);
  }
  public async health(): Promise<RunQueueHealth> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        this.queue.getJobCounts("waiting"),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("Redis health check timed out")), 5000);
        }),
      ]);
      return "CONFIGURED";
    } catch {
      return "UNREACHABLE";
    } finally {
      clearTimeout(timer);
    }
  }
  public async enqueue(data: RunJob, revision: number, delay = 0): Promise<void> {
    const jobId = `${data.runId}-${revision}`;
    await this.removeFinished(jobId);
    await this.queue.add("step", data, { jobId, delay, attempts: 1, removeOnComplete: true });
  }
  public async fanout(data: RunJob, stepIds: string[], revision: number): Promise<void> {
    for (const id of stepIds)
      await this.removeFinished(createHash("sha256").update(id).digest("hex"));
    await this.removeFinished(`${data.runId}-assemble-${revision}`);
    await this.flows.add({
      name: "assemble",
      queueName: RUN_QUEUE,
      data,
      opts: { jobId: `${data.runId}-assemble-${revision}`, removeOnComplete: true },
      children: stepIds.map((stepId) => ({
        name: "shot",
        queueName: RUN_QUEUE,
        data: { ...data, stepId },
        opts: {
          jobId: createHash("sha256").update(stepId).digest("hex"),
          removeOnComplete: true,
        },
      })),
    });
  }
  private async removeFinished(id: string): Promise<void> {
    const job = await this.queue.getJob(id);
    if (job && ["failed", "completed"].includes(await job.getState())) await job.remove();
  }
  public async close(): Promise<void> {
    await Promise.all([this.queue.close(), this.flows.close()]);
  }
}
