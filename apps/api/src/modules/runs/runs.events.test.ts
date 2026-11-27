import { EventEmitter } from "node:events";
import { expect, it, vi } from "vitest";
import { RunsEvents } from "./runs.events.js";
import type { RunsStore } from "./runs.store.js";

const redis = vi.hoisted(() => ({
  duplicate: vi.fn(),
  subscribe: vi.fn(),
  unsubscribe: vi.fn(),
  disconnect: vi.fn(),
}));
vi.mock("ioredis", () => ({
  Redis: class extends EventEmitter {
    duplicate = redis.duplicate;
    disconnect = redis.disconnect;
  },
}));
it("shares subscriptions, heartbeats without moving the replay cursor and drains on fallback", async () => {
  vi.useFakeTimers();
  try {
    redis.duplicate.mockReturnValue(Object.assign(new EventEmitter(), redis));
    redis.subscribe.mockResolvedValue(1);
    redis.unsubscribe.mockResolvedValue(0);
    const store = { events: vi.fn().mockResolvedValue([]) };
    const events = new RunsEvents(store as unknown as RunsStore, "redis://unused");
    const context = { workspaceId: "scope", userId: "viewer", role: "VIEWER" as const };
    const receive = vi.fn();
    const a = events.stream(context, "run", 7).subscribe(receive);
    const b = events.stream(context, "run", 9).subscribe(receive);
    await vi.advanceTimersByTimeAsync(0);
    expect(redis.duplicate).toHaveBeenCalledOnce();
    expect(redis.subscribe).toHaveBeenCalledOnce();
    store.events.mockClear();
    await vi.advanceTimersByTimeAsync(15000);
    expect(receive.mock.calls).toEqual([[{ comment: "keepalive" }], [{ comment: "keepalive" }]]);
    expect(store.events).not.toHaveBeenCalled();
    a.unsubscribe();
    expect(redis.unsubscribe).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(15000);
    expect(store.events).toHaveBeenCalledExactlyOnceWith(context, "run", 9);
    b.unsubscribe();
    expect(redis.unsubscribe).toHaveBeenCalledOnce();
    await events.close();
  } finally {
    vi.useRealTimers();
  }
});
