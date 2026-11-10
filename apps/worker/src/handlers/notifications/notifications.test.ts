import { describe, expect, it, vi } from "vitest";
import type { NotificationsRuntime } from "./factory.js";
import { NotificationsWorkerHandler } from "./handler.js";

function runtime(calls: string[], fail = false): NotificationsRuntime {
  return {
    notifications: {
      runIntake: vi.fn(async () => {
        calls.push("intake");
        if (fail && calls.length === 1) throw new Error("database unavailable");
        return [{ source: "m13.outbox", read: 1, recorded: 1, error: null }];
      }),
      fanOutPending: vi.fn(async () => {
        calls.push("fanout");
        return { events: 1, notifications: 1, deliveries: 0, errors: [] };
      }),
      processDueDeliveries: vi.fn(async () => {
        calls.push("deliveries");
        return { sent: 0, retryWait: 0, failed: 0, skippedNotConfigured: 0, unknownOutcome: 0 };
      }),
    },
    reports: {
      runScheduleTick: vi.fn(async () => {
        calls.push("reports");
        return { generated: 0, existing: 0, suppressed: 0, notDue: 2, errors: [] };
      }),
    },
    close: vi.fn(async () => {
      calls.push("close");
    }),
  } as unknown as NotificationsRuntime;
}

describe("NotificationsWorkerHandler", () => {
  it("runs intake, report tick, fan-out, and deliveries with the injected clock", async () => {
    const calls: string[] = [];
    const now = new Date("2026-11-10T00:00:00.000Z");
    const rt = runtime(calls);
    const handler = new NotificationsWorkerHandler(rt, { now: (): Date => now });
    const result = await handler.tick();
    expect(calls).toEqual(["intake", "reports", "fanout", "deliveries"]);
    expect(rt.notifications.runIntake).toHaveBeenCalledWith(now);
    expect(rt.reports.runScheduleTick).toHaveBeenCalledWith(now);
    expect(result.fanout.notifications).toBe(1);
  });

  it("continues after a failing tick and stops cleanly on shutdown", async () => {
    const calls: string[] = [];
    const errors: unknown[] = [];
    const handler = new NotificationsWorkerHandler(runtime(calls, true), {
      tickIntervalMs: 5,
      onError: (error): void => {
        errors.push(error);
      },
    });
    const running = handler.start();
    await vi.waitFor(() =>
      expect(calls.filter((call) => call === "fanout").length).toBeGreaterThanOrEqual(1),
    );
    await handler.stop();
    await expect(running).resolves.toBeUndefined();
    expect(errors).toHaveLength(1);
    expect(calls.at(-1)).toBe("close");
    const count = calls.length;
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(calls).toHaveLength(count);
  });
});
