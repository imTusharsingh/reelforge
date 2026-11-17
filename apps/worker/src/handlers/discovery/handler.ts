import { NestFactory } from "@nestjs/core";

type DiscoveryRuntime = { scheduledTick(now: Date): Promise<void> };
export class DiscoveryWorkerHandler {
  private timer: ReturnType<typeof setInterval> | undefined;
  private pending: Promise<void> | undefined;
  public constructor(private readonly runtime: DiscoveryRuntime) {}
  public start(): void {
    if (this.timer) return;
    // Deliberately no immediate dispatch: boot/health never call providers.
    this.timer = setInterval(() => {
      if (this.pending) return;
      this.pending = this.runtime
        .scheduledTick(new Date())
        .catch(() => {
          console.error("[discovery-worker] schedule tick failed");
        })
        .finally(() => {
          this.pending = undefined;
        });
    }, 60000);
  }
  public async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.pending;
  }
}
export async function startDiscoveryWorker(host: { close: () => Promise<void> }): Promise<void> {
  if (process.env.PIPELINE_V2 !== "true" || process.env.NODE_ENV === "test") return;
  const { AppModule } = await import("@reelforge/api/app-module");
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ["error", "warn"] });
  const handler = new DiscoveryWorkerHandler(app.get<DiscoveryRuntime>("V10_DISCOVERY"));
  handler.start();
  const originalClose = host.close;
  host.close = async (): Promise<void> => {
    await handler.stop();
    await app.close();
    await originalClose();
  };
}
