import { describe, expect, it } from "vitest";
import { periodBounds, periodForLocalDate, startOfLocalDay } from "./usage-budget.time.js";

describe("M18 timezone periods", () => {
  it("uses the local calendar day in Asia/Kolkata", () => {
    const bounds = periodBounds(new Date("2026-11-10T18:29:59.000Z"), "DAY", "Asia/Kolkata");
    expect(bounds).toMatchObject({ key: "2026-11-10" });
    expect(bounds.start.toISOString()).toBe("2026-11-09T18:30:00.000Z");
    expect(bounds.end.toISOString()).toBe("2026-11-10T18:30:00.000Z");
    const next = periodBounds(new Date("2026-11-10T18:30:00.000Z"), "DAY", "Asia/Kolkata");
    expect(next.key).toBe("2026-11-11");
  });

  it("handles 23-hour and 25-hour DST days in America/New_York", () => {
    const spring = periodForLocalDate("2026-03-08", "DAY", "America/New_York");
    expect(spring.start.toISOString()).toBe("2026-03-08T05:00:00.000Z");
    expect(spring.end.toISOString()).toBe("2026-03-09T04:00:00.000Z");
    expect(spring.end.getTime() - spring.start.getTime()).toBe(23 * 3_600_000);
    const fall = periodForLocalDate("2026-11-01", "DAY", "America/New_York");
    expect(fall.end.getTime() - fall.start.getTime()).toBe(25 * 3_600_000);
  });

  it("starts the day at the first valid minute when local midnight is skipped", () => {
    // Chile springs forward at 00:00 on 2026-09-06: 00:00-00:59 does not exist.
    const start = startOfLocalDay(2026, 9, 6, "America/Santiago");
    expect(start.toISOString()).toBe("2026-09-06T04:00:00.000Z");
  });

  it("computes monthly bounds in the timezone, including year rollover", () => {
    const december = periodBounds(new Date("2026-12-31T20:00:00.000Z"), "MONTH", "Asia/Kolkata");
    expect(december.key).toBe("2027-01");
    expect(december.start.toISOString()).toBe("2026-12-31T18:30:00.000Z");
    expect(december.end.toISOString()).toBe("2027-01-31T18:30:00.000Z");
    const utc = periodForLocalDate("2026-02-14", "MONTH", "UTC");
    expect(utc.start.toISOString()).toBe("2026-02-01T00:00:00.000Z");
    expect(utc.end.toISOString()).toBe("2026-03-01T00:00:00.000Z");
  });
});
