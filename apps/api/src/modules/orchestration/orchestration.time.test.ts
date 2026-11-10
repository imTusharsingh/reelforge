import { describe, expect, it } from "vitest";
import {
  addUtcDays,
  isValidTimeZone,
  localDateKey,
  localDateTimeParts,
  localTimeKey,
  parseTimeOfDay,
  zonedTimeToUtc,
} from "./orchestration.time.js";

describe("workflow time helpers", () => {
  it("validates IANA timezones", () => {
    expect(isValidTimeZone("UTC")).toBe(true);
    expect(isValidTimeZone("America/New_York")).toBe(true);
    expect(isValidTimeZone("Asia/Kolkata")).toBe(true);
    expect(isValidTimeZone("Not/AZone")).toBe(false);
  });

  it("reports local parts in the requested timezone", () => {
    const parts = localDateTimeParts(new Date("2026-03-08T13:00:00.000Z"), "America/New_York");
    expect(parts).toMatchObject({ year: 2026, month: 3, day: 8, hour: 9, minute: 0 });
    expect(localDateKey(parts)).toBe("2026-03-08");
    expect(localTimeKey(parts)).toBe("09:00");
  });

  it("maps a wall clock time to UTC across DST offsets", () => {
    const winter = zonedTimeToUtc(
      { year: 2026, month: 1, day: 15, hour: 9, minute: 0 },
      "America/New_York",
    );
    expect(winter?.toISOString()).toBe("2026-01-15T14:00:00.000Z");
    const summer = zonedTimeToUtc(
      { year: 2026, month: 7, day: 15, hour: 9, minute: 0 },
      "America/New_York",
    );
    expect(summer?.toISOString()).toBe("2026-07-15T13:00:00.000Z");
  });

  it("returns null for a wall clock time inside the spring-forward gap", () => {
    const gap = zonedTimeToUtc(
      { year: 2026, month: 3, day: 8, hour: 2, minute: 30 },
      "America/New_York",
    );
    expect(gap).toBeNull();
  });

  it("resolves an ambiguous fall-back time to a single instant", () => {
    const ambiguous = zonedTimeToUtc(
      { year: 2026, month: 11, day: 1, hour: 1, minute: 30 },
      "America/New_York",
    );
    expect(ambiguous?.toISOString()).toBe("2026-11-01T05:30:00.000Z");
  });

  it("parses strict HH:mm times", () => {
    expect(parseTimeOfDay("09:05")).toEqual({ hour: 9, minute: 5 });
    expect(parseTimeOfDay("23:59")).toEqual({ hour: 23, minute: 59 });
    expect(parseTimeOfDay("24:00")).toBeNull();
    expect(parseTimeOfDay("9:05")).toBeNull();
    expect(parseTimeOfDay("09:60")).toBeNull();
  });

  it("adds UTC days without timezone drift", () => {
    expect(addUtcDays(new Date("2026-03-08T00:00:00.000Z"), 1).toISOString()).toBe(
      "2026-03-09T00:00:00.000Z",
    );
  });
});
