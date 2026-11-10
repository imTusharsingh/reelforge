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

  /** One scheduler tick plus stale-lease recovery, using the injected clock. */
  public async tick(): Promise<void> {
    const now = (this.options.now ?? ((): Date => new Date()))();
    await this.runtime.service.recoverStaleLeases(now);
    await this.runtime.service.runSchedulerTick(now);
    await this.runtime.service.dispatchUndispatchedRuns();
  }

  public async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    if (this.runtime.consumer) await this.runtime.consumer.worker.waitUntilReady();
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
