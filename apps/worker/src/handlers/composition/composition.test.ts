import { describe, expect, it, vi } from "vitest";
import { CompositionWorkerHandler } from "./handler.js";

describe("CompositionWorkerHandler", () => {
  it("polls durable work until shutdown, awaiting an active render", async () => {
    let release = (): void => {};
    const render = vi
      .fn<(batch?: number) => Promise<{ claimed: number; retained: number }>>()
      .mockResolvedValueOnce({ claimed: 1, retained: 2 })
      .mockResolvedValueOnce({ claimed: 0, retained: 0 })
      .mockImplementationOnce(async () => {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return { claimed: 1, retained: 0 };
      });
    const handler = new CompositionWorkerHandler(render, { pollIntervalMs: 5 });
    await handler.poll();
    await handler.poll();
    expect(render).toHaveBeenCalledTimes(2);
    const running = handler.start();
    await vi.waitFor(() => expect(render).toHaveBeenCalledTimes(3));
    let settled = false;
    void running.then(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(settled).toBe(false);
    release();
    await handler.stop();
    await expect(running).resolves.toBeUndefined();
    const calls = render.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(render).toHaveBeenCalledTimes(calls);
  });

  it("continues polling after transient outages", async () => {
    const errors: unknown[] = [];
    const render = vi
      .fn<(batch?: number) => Promise<{ claimed: number; retained: number }>>()
      .mockRejectedValueOnce(new Error("database unavailable"))
      .mockResolvedValue({ claimed: 0, retained: 0 });
    const handler = new CompositionWorkerHandler(render, {
      pollIntervalMs: 5,
      onError: (error): void => {
        errors.push(error);
      },
    });
    const running = handler.start();
    await vi.waitFor(() => expect(errors).toHaveLength(1));
    await handler.stop();
    await expect(running).resolves.toBeUndefined();
    expect(errors).toHaveLength(1);
    expect(render.mock.calls.length).toBeGreaterThanOrEqual(2);
  });
});
