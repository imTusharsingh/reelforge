import { afterEach, describe, expect, it, vi } from "vitest";
import { PublishingWorkerHandler, startPublishingWorker } from "./handler.js";
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});
describe("V9 worker lifecycle on fake runtime", () => {
  it("does no upload at startup, prevents overlap, drains before shutdown", async () => {
    vi.useFakeTimers();
    let done: (() => void) | undefined;
    const tick = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          done = resolve;
        }),
    );
    const handler = new PublishingWorkerHandler({ tick });
    handler.start();
    handler.start();
    expect(tick).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60000);
    expect(tick).toHaveBeenCalledTimes(1);
    const stopping = handler.stop();
    done?.();
    await stopping;
    await vi.advanceTimersByTimeAsync(60000);
    expect(tick).toHaveBeenCalledTimes(1);
  });
  it("does not initialize runtime when disabled or under tests", async () => {
    vi.stubEnv("PIPELINE_V2", "false");
    const close = vi.fn(async () => undefined);
    await startPublishingWorker({ close });
    expect(close).not.toHaveBeenCalled();
    vi.stubEnv("PIPELINE_V2", "true");
    vi.stubEnv("NODE_ENV", "test");
    await startPublishingWorker({ close });
    expect(close).not.toHaveBeenCalled();
  });
});
