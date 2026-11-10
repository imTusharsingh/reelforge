import type { NotificationsRuntime } from "./factory.js";

export type NotificationsTickResult = Readonly<{
  intake: Awaited<ReturnType<NotificationsRuntime["notifications"]["runIntake"]>>;
  reports: Awaited<ReturnType<NotificationsRuntime["reports"]["runScheduleTick"]>>;
  fanout: Awaited<ReturnType<NotificationsRuntime["notifications"]["fanOutPending"]>>;
  deliveries: Awaited<ReturnType<NotificationsRuntime["notifications"]["processDueDeliveries"]>>;
}>;

/**
 * M17 worker loop: event intake, the report schedule tick (which records CHANNEL_REPORT_READY),
 * fan-out to members, then due email deliveries. Runs next to the composition poller and the
 * M16 orchestration handler; SIGTERM stops the loop after the active tick finishes.
 */
export class NotificationsWorkerHandler {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private active: Promise<void> | undefined;
  private running = false;
  private wake: (() => void) | undefined;

  public constructor(
    private readonly runtime: NotificationsRuntime,
    private readonly options: {
      readonly tickIntervalMs?: number;
      readonly now?: () => Date;
      readonly onError?: (error: unknown) => void;
    } = {},
  ) {}

  public async tick(): Promise<NotificationsTickResult> {
    const now = (this.options.now ?? ((): Date => new Date()))();
    const intake = await this.runtime.notifications.runIntake(now);
    for (const source of intake)
      if (source.error !== null)
        this.report(new Error(`notification intake ${source.source}: ${source.error}`));
    const reports = await this.runtime.reports.runScheduleTick(now);
    for (const failure of reports.errors)
      this.report(
        new Error(`channel report ${failure.channelId} ${failure.periodType}: ${failure.error}`),
      );
    const fanout = await this.runtime.notifications.fanOutPending(now);
    for (const failure of fanout.errors) this.report(new Error(`notification fan-out ${failure}`));
    const deliveries = await this.runtime.notifications.processDueDeliveries(now);
    return { intake, reports, fanout, deliveries };
  }

  public async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    while (this.running) {
      const active = this.tick();
      this.active = active.then(
        () => undefined,
        () => undefined,
      );
      try {
        await active;
      } catch (error) {
        this.report(error);
      } finally {
        this.active = undefined;
      }
      if (this.running)
        await new Promise<void>((resolve) => {
          this.timer = setTimeout(resolve, this.options.tickIntervalMs ?? 30_000);
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

  private report(error: unknown): void {
    if (this.options.onError) this.options.onError(error);
    else console.error("[notifications-worker] tick failed; continuing", error);
  }
}
