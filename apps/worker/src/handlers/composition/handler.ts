export class CompositionWorkerHandler {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private active: Promise<void> | undefined;
  private running = false;
  private wake: (() => void) | undefined;
  public constructor(
    private readonly pollWork: (batch?: number) => Promise<unknown>,
    private readonly options: { readonly pollIntervalMs?: number } = {},
  ) {}
  public async poll(): Promise<void> {
    const active = this.pollWork();
    this.active = active.then(() => undefined);
    try {
      await active;
    } finally {
      this.active = undefined;
    }
  }
  public async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    while (this.running) {
      await this.poll();
      if (this.running)
        await new Promise<void>((resolve) => {
          this.timer = setTimeout(resolve, this.options.pollIntervalMs ?? 1000);
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
    await this.closeResources?.();
  }
  public closeResources: (() => Promise<void>) | undefined;
}
