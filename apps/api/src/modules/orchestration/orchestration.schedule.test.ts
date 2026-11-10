import { describe, expect, it } from "vitest";
import { dueScheduleOccurrences, parseChannelSchedule } from "./orchestration.schedule.js";

describe("channel schedule evaluation", () => {
  it("parses a daily schedule with an IANA timezone", () => {
    const schedule = parseChannelSchedule(
      {
        timezone: "America/New_York",
        definitionKey: "GENERATION",
        time: "09:00",
        frequency: "DAILY",
        maxRunsPerDay: 2,
        input: { ideaId: "idea-1" },
      },
      "UTC",
    );
    expect(schedule).toMatchObject({
      timezone: "America/New_York",
      definitionKey: "GENERATION",
      maxRunsPerDay: 2,
      input: { ideaId: "idea-1" },
    });
    expect(schedule?.occurrences).toEqual([{ dayOfWeek: null, time: "09:00" }]);
  });

  it("parses weekly slots and defaults weekdays", () => {
    const weekly = parseChannelSchedule(
      { time: "09:00", frequency: "WEEKLY", daysOfWeek: [1, 3] },
      "UTC",
    );
    expect(weekly?.occurrences).toEqual([
      { dayOfWeek: 1, time: "09:00" },
      { dayOfWeek: 3, time: "09:00" },
    ]);
    const defaulted = parseChannelSchedule({ time: "09:00", frequency: "WEEKLY" }, "UTC");
    expect(defaulted?.occurrences.map((item) => item.dayOfWeek)).toEqual([1, 2, 3, 4, 5]);
  });

  it("falls back to the channel timezone when the schedule timezone is invalid", () => {
    const schedule = parseChannelSchedule({ timezone: "Not/AZone", time: "09:00" }, "Asia/Kolkata");
    expect(schedule?.timezone).toBe("Asia/Kolkata");
  });

  it("returns null when the schedule has no usable time", () => {
    expect(parseChannelSchedule({ timezone: "UTC" }, "UTC")).toBeNull();
    expect(parseChannelSchedule({ time: "25:00" }, "UTC")).toBeNull();
    expect(parseChannelSchedule("nope", "UTC")).toBeNull();
  });

  it("evaluates a daily occurrence in the channel timezone across DST", () => {
    const schedule = parseChannelSchedule(
      { timezone: "America/New_York", time: "09:00", frequency: "DAILY" },
      "UTC",
    );
    if (!schedule) throw new Error("schedule missing");
    const winter = dueScheduleOccurrences(
      schedule,
      new Date("2026-01-15T00:00:00.000Z"),
      new Date("2026-01-15T23:59:59.999Z"),
    );
    expect(winter).toHaveLength(1);
    expect(winter[0]?.scheduledFor.toISOString()).toBe("2026-01-15T14:00:00.000Z");

    const springForward = dueScheduleOccurrences(
      schedule,
      new Date("2026-03-08T00:00:00.000Z"),
      new Date("2026-03-08T23:59:59.999Z"),
    );
    expect(springForward).toHaveLength(1);
    expect(springForward[0]?.scheduledFor.toISOString()).toBe("2026-03-08T13:00:00.000Z");
  });

  it("skips a daily occurrence that lands inside the spring-forward gap", () => {
    const schedule = parseChannelSchedule(
      { timezone: "America/New_York", time: "02:30", frequency: "DAILY" },
      "UTC",
    );
    if (!schedule) throw new Error("schedule missing");
    const occurrences = dueScheduleOccurrences(
      schedule,
      new Date("2026-03-08T00:00:00.000Z"),
      new Date("2026-03-08T23:59:59.999Z"),
    );
    expect(occurrences).toHaveLength(0);
  });

  it("produces exactly one slot for an ambiguous fall-back time", () => {
    const schedule = parseChannelSchedule(
      { timezone: "America/New_York", time: "01:30", frequency: "DAILY" },
      "UTC",
    );
    if (!schedule) throw new Error("schedule missing");
    const occurrences = dueScheduleOccurrences(
      schedule,
      new Date("2026-11-01T00:00:00.000Z"),
      new Date("2026-11-01T23:59:59.999Z"),
    );
    expect(occurrences).toHaveLength(1);
    expect(occurrences[0]?.slotKey).toBe("GENERATION:2026-11-01T01:30");
  });

  it("only returns occurrences inside the requested window", () => {
    const schedule = parseChannelSchedule(
      { timezone: "UTC", time: "09:00", frequency: "DAILY" },
      "UTC",
    );
    if (!schedule) throw new Error("schedule missing");
    const occurrences = dueScheduleOccurrences(
      schedule,
      new Date("2026-05-01T09:01:00.000Z"),
      new Date("2026-05-01T09:02:00.000Z"),
    );
    expect(occurrences).toHaveLength(0);
  });

  it("keeps local wall-clock time across the European fall-back transition", () => {
    const schedule = parseChannelSchedule({ time: "09:00", frequency: "DAILY" }, "Europe/London");
    if (!schedule) throw new Error("schedule missing");
    const summer = dueScheduleOccurrences(
      schedule,
      new Date("2026-10-24T00:00:00.000Z"),
      new Date("2026-10-24T23:59:59.999Z"),
    );
    const winter = dueScheduleOccurrences(
      schedule,
      new Date("2026-10-25T00:00:00.000Z"),
      new Date("2026-10-25T23:59:59.999Z"),
    );
    expect(summer.map((item) => item.scheduledFor.toISOString())).toEqual([
      "2026-10-24T08:00:00.000Z",
    ]);
    expect(winter.map((item) => item.scheduledFor.toISOString())).toEqual([
      "2026-10-25T09:00:00.000Z",
    ]);
  });

  it("uses the channel-local weekday and date when they differ from UTC", () => {
    // Monday 08:00 in Asia/Kolkata is Monday 02:30Z; Sunday 23:30 in New York is Monday 04:30Z.
    const kolkata = parseChannelSchedule(
      { time: "08:00", frequency: "WEEKLY", daysOfWeek: [1] },
      "Asia/Kolkata",
    );
    const newYork = parseChannelSchedule(
      { time: "23:30", frequency: "WEEKLY", daysOfWeek: [0] },
      "America/New_York",
    );
    if (!kolkata || !newYork) throw new Error("schedule missing");
    const from = new Date("2026-11-09T00:00:00.000Z");
    const to = new Date("2026-11-09T06:00:00.000Z");
    expect(dueScheduleOccurrences(kolkata, from, to)).toMatchObject([
      { localDate: "2026-11-09", localTime: "08:00", timezone: "Asia/Kolkata" },
    ]);
    expect(dueScheduleOccurrences(kolkata, from, to)[0]?.scheduledFor.toISOString()).toBe(
      "2026-11-09T02:30:00.000Z",
    );
    const sunday = dueScheduleOccurrences(newYork, from, to);
    expect(sunday).toHaveLength(1);
    expect(sunday[0]).toMatchObject({ localDate: "2026-11-08", localTime: "23:30" });
    expect(sunday[0]?.scheduledFor.toISOString()).toBe("2026-11-09T04:30:00.000Z");
  });

  it("emits stable slot keys so overlapping scheduler windows dedupe", () => {
    const schedule = parseChannelSchedule({ time: "09:00", frequency: "DAILY" }, "UTC");
    if (!schedule) throw new Error("schedule missing");
    const a = dueScheduleOccurrences(
      schedule,
      new Date("2026-05-01T08:55:00.000Z"),
      new Date("2026-05-01T09:00:00.000Z"),
    );
    const b = dueScheduleOccurrences(
      schedule,
      new Date("2026-05-01T08:58:00.000Z"),
      new Date("2026-05-01T09:03:00.000Z"),
    );
    expect(a.map((item) => item.slotKey)).toEqual(["GENERATION:2026-05-01T09:00"]);
    expect(b.map((item) => item.slotKey)).toEqual(a.map((item) => item.slotKey));
  });
});
