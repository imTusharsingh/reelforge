import { describe, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({ constructor: vi.fn() }));
vi.mock("bullmq", () => ({
  DelayedError: class DelayedError extends Error {},
  Worker: class {
    public constructor(...args: unknown[]) {
      mock.constructor(...args);
    }
    public on(): void {}
    public async waitUntilReady(): Promise<void> {}
    public async close(): Promise<void> {}
  },
}));
vi.mock("@reelforge/api/orchestration-queue", () => ({
  parseRedisConnection: (): object => ({ host: "localhost" }),
}));
import { createVideoRunsConsumer } from "./video-runs.js";

describe("VideoRun worker lifecycle", () => {
  it("recovers at startup, preserves delayed dependencies and closes the consumer", async () => {
    const runtime = {
      queueName: "v3",
      process: vi.fn().mockResolvedValue(12000),
      recover: vi.fn().mockResolvedValue(undefined),
    };
    const app = { get: vi.fn().mockReturnValue(runtime) };
    const consumer = await createVideoRunsConsumer(app as never, "redis://unused");
    const process = mock.constructor.mock.calls.at(-1)![1] as (
      job: object,
      token: string,
    ) => Promise<void>;
    const moveToDelayed = vi.fn().mockResolvedValue(undefined);
    await expect(process({ data: { run: "fixture" }, moveToDelayed }, "token")).rejects.toThrow();
    expect(moveToDelayed).toHaveBeenCalledWith(expect.any(Number), "token");
    runtime.process.mockResolvedValue(null);
    await process({ data: {}, moveToDelayed }, "token");
    expect(runtime.recover).toHaveBeenCalledOnce();
    await consumer.recover();
    expect(runtime.recover).toHaveBeenCalledTimes(2);
    await consumer.close();
  });
});
