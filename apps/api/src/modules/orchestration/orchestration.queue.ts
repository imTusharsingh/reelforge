import type {
  WorkflowQueueEnqueueResult,
  WorkflowQueueHealth,
  WorkflowQueueJob,
  WorkflowQueuePort,
} from "./orchestration.types.js";

export function deterministicJobId(
  runId: string,
  stepId: string,
  attempt: number,
  retryGeneration = 0,
  wake = 0,
): string {
  const base = `${runId}.${stepId}.${retryGeneration}.${attempt}`;
  return wake > 0 ? `${base}.w${wake}` : base;
}

export class NotConfiguredWorkflowQueue implements WorkflowQueuePort {
  public readonly status = "NOT_CONFIGURED" as const;

  public enqueue(): Promise<WorkflowQueueEnqueueResult> {
    return Promise.resolve("NOT_CONFIGURED");
  }

  public health(): Promise<WorkflowQueueHealth> {
    return Promise.resolve("NOT_CONFIGURED");
  }

  public close(): Promise<void> {
    return Promise.resolve();
  }
}

export class InMemoryWorkflowQueue implements WorkflowQueuePort {
  public readonly status = "CONFIGURED" as const;
  private readonly jobs = new Map<string, WorkflowQueueJob>();
  private readonly delivered = new Set<string>();

  /** Like BullMQ: a pending job id is a duplicate; a delivered (finished) id may be added again. */
  public enqueue(job: WorkflowQueueJob): Promise<WorkflowQueueEnqueueResult> {
    if (this.jobs.has(job.jobId)) return Promise.resolve("DUPLICATE");
    this.jobs.set(job.jobId, job);
    return Promise.resolve("ENQUEUED");
  }

  public health(): Promise<WorkflowQueueHealth> {
    return Promise.resolve("CONFIGURED");
  }

  public take(): readonly WorkflowQueueJob[] {
    const jobs = [...this.jobs.values()];
    this.jobs.clear();
    for (const job of jobs) this.delivered.add(job.jobId);
    return jobs;
  }

  public peek(): readonly WorkflowQueueJob[] {
    return [...this.jobs.values()];
  }

  public get deliveredCount(): number {
    return this.delivered.size;
  }

  public close(): Promise<void> {
    this.jobs.clear();
    return Promise.resolve();
  }
}
