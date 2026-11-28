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

it("resubscribes active viewers on Redis recovery and cancels retries on last disconnect", async () => {
  vi.useFakeTimers();
  try {
    vi.clearAllMocks();
    const connection = Object.assign(new EventEmitter(), redis);
    redis.duplicate.mockReturnValue(connection);
    redis.subscribe.mockRejectedValueOnce(new Error("Redis offline")).mockResolvedValue(1);
    redis.unsubscribe.mockResolvedValue(0);
    const store = { events: vi.fn().mockResolvedValue([]) };
    const events = new RunsEvents(store as unknown as RunsStore, "redis://unused");
    const context = { workspaceId: "scope", userId: "viewer", role: "VIEWER" as const };
    const sub = events.stream(context, "run", 3).subscribe();
    const second = events.stream(context, "run", 5).subscribe();
    await vi.advanceTimersByTimeAsync(0);
    connection.emit("ready");
    await vi.advanceTimersByTimeAsync(0);
    expect(redis.subscribe).toHaveBeenCalledTimes(2);
    store.events.mockClear();
    connection.emit("message", "runs:scope:run");
    await vi.advanceTimersByTimeAsync(0);
    expect(store.events.mock.calls).toEqual([
      [context, "run", 3],
      [context, "run", 5],
    ]);
    sub.unsubscribe();
    expect(redis.unsubscribe).not.toHaveBeenCalled();
    second.unsubscribe();
    expect(redis.unsubscribe).toHaveBeenCalledExactlyOnceWith("runs:scope:run");
    connection.emit("ready");
    await vi.advanceTimersByTimeAsync(30000);
    expect(redis.subscribe).toHaveBeenCalledTimes(2);
    await events.close();
  } finally {
    vi.useRealTimers();
  }
});

it("retries failed subscriptions on a timer without a new Redis ready event, but not after disconnect", async () => {
  vi.useFakeTimers();
  try {
    vi.clearAllMocks();
    const connection = Object.assign(new EventEmitter(), redis);
    redis.duplicate.mockReturnValue(connection);
    redis.subscribe.mockRejectedValue(new Error("subscription failed"));
    redis.unsubscribe.mockResolvedValue(0);
    const store = { events: vi.fn().mockResolvedValue([]) };
    const events = new RunsEvents(store as unknown as RunsStore, "redis://unused");
    const context = { workspaceId: "scope", userId: "viewer", role: "VIEWER" as const };
    const sub = events.stream(context, "run", 0).subscribe();
    await vi.advanceTimersByTimeAsync(1_999);
    expect(redis.subscribe).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    expect(redis.subscribe).toHaveBeenCalledTimes(2);
    sub.unsubscribe();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(redis.subscribe).toHaveBeenCalledTimes(2);
    expect(redis.unsubscribe).toHaveBeenCalledExactlyOnceWith("runs:scope:run");
    await events.close();
  } finally {
    vi.useRealTimers();
  }
});
