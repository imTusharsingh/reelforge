vi.mock("@nestjs/core", () => ({ NestFactory: { createApplicationContext: vi.fn() } }));
import { NestFactory } from "@nestjs/core";
vi.mock("@reelforge/api/app-module", () => ({ AppModule: class AppModule {} }));
import { afterEach, describe, expect, it, vi } from "vitest";
import { DiscoveryWorkerHandler, startDiscoveryWorker } from "./handler.js";
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});
describe("V10 discovery worker", () => {
  it("does not dispatch on boot and prevents overlapping ticks", async () => {
    vi.useFakeTimers();
    let finish: () => void = () => {};
    const scheduledTick = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const handler = new DiscoveryWorkerHandler({ scheduledTick });
    handler.start();
    handler.start();
    expect(scheduledTick).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60000);
    expect(scheduledTick).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(60000);
    expect(scheduledTick).toHaveBeenCalledOnce();
    finish();
    await handler.stop();
    await vi.advanceTimersByTimeAsync(60000);
    expect(scheduledTick).toHaveBeenCalledOnce();
  });
  it("continues after a failed tick and starts no runtime in tests or when v2 is off", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const scheduledTick = vi.fn().mockRejectedValue(new Error("db failed"));
    const handler = new DiscoveryWorkerHandler({ scheduledTick });
    handler.start();
    await vi.advanceTimersByTimeAsync(120000);
    expect(scheduledTick).toHaveBeenCalledTimes(2);
    await handler.stop();
    vi.stubEnv("PIPELINE_V2", "false");
    await startDiscoveryWorker({ close: async (): Promise<void> => {} });
    vi.stubEnv("PIPELINE_V2", "true");
    vi.stubEnv("NODE_ENV", "test");
    await startDiscoveryWorker({ close: async (): Promise<void> => {} });
  });
  it("starts the gated runtime with no immediate dispatch and joins host shutdown", async () => {
    vi.useFakeTimers();
    vi.stubEnv("PIPELINE_V2", "true");
    vi.stubEnv("NODE_ENV", "development");
    const scheduledTick = vi.fn().mockResolvedValue(undefined);
    const close = vi.fn().mockResolvedValue(undefined),
      host = { close: vi.fn().mockResolvedValue(undefined) };
    const original = host.close;
    vi.mocked(NestFactory.createApplicationContext).mockResolvedValue({
      get: () => ({ scheduledTick }),
      close,
    } as never);
    await startDiscoveryWorker(host);
    expect(scheduledTick).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60000);
    expect(scheduledTick).toHaveBeenCalledOnce();
    await host.close();
    expect(original).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(60000);
    expect(scheduledTick).toHaveBeenCalledOnce();
  });
});
