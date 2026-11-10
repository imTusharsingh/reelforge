import { describe, expect, it } from "vitest";
import {
  addLocalDays,
  isoWeekday,
  lastCompletedPeriod,
  localDateOf,
  periodDates,
  reportPeriod,
  startOfLocalDay,
} from "./reports.periods.js";

const hours = (period: { start: Date; end: Date }): number =>
  (period.end.getTime() - period.start.getTime()) / 3_600_000;

describe("M17 report periods", () => {
  it("computes daily periods in the channel timezone across DST changes", () => {
    const spring = reportPeriod("DAILY", "2026-03-08", "America/New_York");
    expect(spring.start.toISOString()).toBe("2026-03-08T05:00:00.000Z");
    expect(spring.end.toISOString()).toBe("2026-03-09T04:00:00.000Z");
    expect(hours(spring)).toBe(23);
    const fall = reportPeriod("DAILY", "2026-11-01", "America/New_York");
    expect(hours(fall)).toBe(25);
    const plain = reportPeriod("DAILY", "2026-11-10", "Asia/Kolkata");
    expect(plain.start.toISOString()).toBe("2026-11-09T18:30:00.000Z");
    expect(hours(plain)).toBe(24);
    const london = reportPeriod("DAILY", "2026-03-29", "Europe/London");
    expect(hours(london)).toBe(23);
  });

  it("computes weekly Monday-Sunday periods with DST-length weeks", () => {
    const week = reportPeriod("WEEKLY", "2026-10-26", "America/New_York");
    expect(week.localEndDate).toBe("2026-11-01");
    expect(week.end.toISOString()).toBe("2026-11-02T05:00:00.000Z");
    expect(hours(week)).toBe(169);
    expect(periodDates(week)).toHaveLength(7);
    expect(() => reportPeriod("WEEKLY", "2026-10-27", "America/New_York")).toThrow(/Monday/);
    expect(() => reportPeriod("DAILY", "2026-02-30", "UTC")).toThrow();
  });

  it("finds the first instant of a local day even when local midnight does not exist", () => {
    for (const [date, zone] of [
      ["2026-09-06", "America/Santiago"],
      ["2026-03-29", "Asia/Beirut"],
      ["2026-11-01", "America/Havana"],
    ] as const) {
      const start = startOfLocalDay(date, zone);
      expect(localDateOf(start, zone)).toBe(date);
      expect(localDateOf(new Date(start.getTime() - 1), zone)).toBe(addLocalDays(date, -1));
    }
  });

  it("selects the last completed daily and weekly period at a given instant", () => {
    // Tuesday 2026-11-10 02:00 in Kolkata (Monday 20:30 UTC).
    const now = new Date("2026-11-09T20:30:00.000Z");
    expect(lastCompletedPeriod("DAILY", now, "Asia/Kolkata").localStartDate).toBe("2026-11-09");
    expect(lastCompletedPeriod("DAILY", now, "UTC").localStartDate).toBe("2026-11-08");
    const weekly = lastCompletedPeriod("WEEKLY", now, "Asia/Kolkata");
    expect(weekly.localStartDate).toBe("2026-11-02");
    expect(isoWeekday(weekly.localStartDate)).toBe(1);
    expect(lastCompletedPeriod("WEEKLY", now, "UTC").localStartDate).toBe("2026-11-02");
  });
});
