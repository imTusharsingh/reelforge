import type { OrchestrationRuntime } from "./factory.js";

export class OrchestrationWorkerHandler {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private active: Promise<void> | undefined;
  private running = false;
  private wake: (() => void) | undefined;

  public constructor(
    private readonly runtime: OrchestrationRuntime,
    private readonly options: {
      readonly tickIntervalMs?: number;
      readonly now?: () => Date;
      readonly onError?: (error: unknown) => void;
    } = {},
  ) {}

  /**
   * One tick with the injected clock: stale-lease recovery, the scheduler, then the recovery
   * sweep that re-enqueues stalled QUEUED/RETRY_WAIT/WAITING_EXTERNAL/PENDING work (lost Redis
   * jobs, enqueue failures, crashes between completion and the next enqueue).
   */
  public async tick(): Promise<void> {
    const now = (this.options.now ?? ((): Date => new Date()))();
    await this.runtime.service.recoverStaleLeases(now);
    await this.runtime.service.runSchedulerTick(now);
    await this.runtime.service.reconcileStalledWork(now);
  }

  public async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    if (this.runtime.consumer) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          this.runtime.consumer.worker.waitUntilReady(),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              reject(new Error("Orchestration BullMQ worker did not become ready within 10 s"));
            }, 10_000);
          }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    }
    while (this.running) {
      const active = this.tick();
      this.active = active.then(
        () => undefined,
        () => undefined,
      );
      try {
        await active;
      } catch (error) {
        if (this.options.onError) this.options.onError(error);
        else console.error("[orchestration-worker] scheduler tick failed; continuing", error);
      } finally {
        this.active = undefined;
      }
      if (this.running)
        await new Promise<void>((resolve) => {
          this.timer = setTimeout(resolve, this.options.tickIntervalMs ?? 15_000);
          this.wake = resolve;
        });
      this.timer = undefined;
    }
  }

  public async stop(): Promise<void> {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.wake?.();
    this.wake = undefined;
    await this.active;
    await this.runtime.close();
  }
}
