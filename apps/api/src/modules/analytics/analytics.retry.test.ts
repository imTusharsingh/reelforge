import { describe, expect, it } from "vitest";
import { retryDecision } from "./analytics.retry.js";

describe("retryDecision", () => {
  it("uses bounded exponential backoff and respects a larger Retry-After", () => {
    const now = new Date("2026-11-10T00:00:00.000Z");
    expect(retryDecision(0, now, null).nextAttemptAt?.toISOString()).toBe(
      "2026-11-10T00:00:30.000Z",
    );
    expect(retryDecision(2, now, 600).nextAttemptAt?.toISOString()).toBe(
      "2026-11-10T00:10:00.000Z",
    );
  });

  it("stops after the retry limit and rejects invalid retry metadata", () => {
    expect(retryDecision(5, new Date(), null)).toEqual({ retry: false, nextAttemptAt: null });
    expect(() => retryDecision(-1, new Date(), null)).toThrow(RangeError);
    expect(() => retryDecision(0, new Date(), -1)).toThrow(RangeError);
  });
});
