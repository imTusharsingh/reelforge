import { NestFactory } from "@nestjs/core";
type Runtime = { tick(now: Date): Promise<void> };
export class PublishingWorkerHandler {
  private timer: ReturnType<typeof setInterval> | undefined;
  private pending: Promise<void> | undefined;
  public constructor(private readonly runtime: Runtime) {}
  public start(): void {
    if (this.timer) return;
    // No uploads, OAuth checks, or provider calls during startup.
    this.timer = setInterval(() => {
      if (this.pending) return;
      this.pending = this.runtime
        .tick(new Date())
        .catch(() => {
          console.error("[v9-publishing] tick failed");
        })
        .finally(() => {
          this.pending = undefined;
        });
    }, 30000);
  }
  public async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.pending;
  }
}
export async function startPublishingWorker(host: { close: () => Promise<void> }): Promise<void> {
  if (process.env.NODE_ENV === "test") return;
  const { AppModule } = await import("@reelforge/api/app-module");
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ["error", "warn"] });
  const handler = new PublishingWorkerHandler(app.get<Runtime>("V9_PUBLISHING"));
  handler.start();
  const close = host.close;
  host.close = async (): Promise<void> => {
    await handler.stop();
    await app.close();
    await close();
  };
}
