import type { WorkflowDefinition, WorkflowScheduleOccurrence } from "./orchestration.types.js";
import {
  addUtcDays,
  isValidTimeZone,
  localDateKey,
  localDateTimeParts,
  localTimeKey,
  parseTimeOfDay,
  zonedTimeToUtc,
} from "./orchestration.time.js";

export type ScheduleOccurrenceRule = Readonly<{
  dayOfWeek: number | null;
  time: string;
}>;

export type ChannelSchedule = Readonly<{
  timezone: string;
  definitionKey: WorkflowDefinition;
  maxRunsPerDay: number;
  occurrences: readonly ScheduleOccurrenceRule[];
  input: Readonly<Record<string, unknown>>;
}>;

const definitions = new Set<WorkflowDefinition>(["GENERATION", "PUBLISH", "ANALYTICS"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeDefinition(value: unknown, fallback: WorkflowDefinition): WorkflowDefinition {
  return typeof value === "string" && definitions.has(value as WorkflowDefinition)
    ? (value as WorkflowDefinition)
    : fallback;
}

function normalizeDay(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 6) return null;
  return value;
}

function parseSlots(value: unknown): ScheduleOccurrenceRule[] {
  if (!Array.isArray(value)) return [];
  const rules: ScheduleOccurrenceRule[] = [];
  for (const slot of value) {
    if (!isRecord(slot)) continue;
    const time = typeof slot["time"] === "string" ? slot["time"] : null;
    if (time === null || parseTimeOfDay(time) === null) continue;
    rules.push({ dayOfWeek: normalizeDay(slot["dayOfWeek"]), time });
  }
  return rules;
}

export function parseChannelSchedule(
  value: unknown,
  fallbackTimezone: string,
  fallbackDefinition: WorkflowDefinition = "GENERATION",
): ChannelSchedule | null {
  if (!isRecord(value)) return null;
  const configuredTimezone =
    typeof value["timezone"] === "string" ? value["timezone"] : fallbackTimezone;
  const timezone = isValidTimeZone(configuredTimezone) ? configuredTimezone : fallbackTimezone;
  if (!isValidTimeZone(timezone)) return null;

  const definitionKey = normalizeDefinition(value["definitionKey"], fallbackDefinition);
  const maxRunsPerDay =
    typeof value["maxRunsPerDay"] === "number" &&
    Number.isInteger(value["maxRunsPerDay"]) &&
    value["maxRunsPerDay"] > 0
      ? value["maxRunsPerDay"]
      : 1;
  const input = isRecord(value["input"]) ? value["input"] : {};

  const slots = parseSlots(value["slots"]);
  if (slots.length > 0)
    return { timezone, definitionKey, maxRunsPerDay, occurrences: slots, input };

  const time = typeof value["time"] === "string" ? value["time"] : null;
  if (time === null || parseTimeOfDay(time) === null) return null;
  const frequency = value["frequency"] === "WEEKLY" ? "WEEKLY" : "DAILY";
  if (frequency === "DAILY")
    return {
      timezone,
      definitionKey,
      maxRunsPerDay,
      occurrences: [{ dayOfWeek: null, time }],
      input,
    };

  const days = Array.isArray(value["daysOfWeek"])
    ? value["daysOfWeek"]
        .map((day) => normalizeDay(day))
        .filter((day): day is number => day !== null)
    : [];
  const occurrences = (days.length > 0 ? days : [1, 2, 3, 4, 5]).map((dayOfWeek) => ({
    dayOfWeek,
    time,
  }));
  return { timezone, definitionKey, maxRunsPerDay, occurrences, input };
}

export function dueScheduleOccurrences(
  schedule: ChannelSchedule,
  from: Date,
  to: Date,
): WorkflowScheduleOccurrence[] {
  if (to.getTime() < from.getTime()) return [];
  const localDates = new Map<
    string,
    { year: number; month: number; day: number; weekday: number }
  >();
  for (let offset = -2; offset <= 2; offset += 1) {
    const probe = addUtcDays(
      new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate(), 12)),
      offset,
    );
    const parts = localDateTimeParts(probe, schedule.timezone);
    localDates.set(localDateKey(parts), {
      year: parts.year,
      month: parts.month,
      day: parts.day,
      weekday: parts.weekday,
    });
  }
  // Include the local dates touched by the `to` boundary.
  const toParts = localDateTimeParts(to, schedule.timezone);
  localDates.set(localDateKey(toParts), {
    year: toParts.year,
    month: toParts.month,
    day: toParts.day,
    weekday: toParts.weekday,
  });

  const occurrences = new Map<string, WorkflowScheduleOccurrence>();
  for (const localDate of localDates.values()) {
    for (const rule of schedule.occurrences) {
      if (rule.dayOfWeek !== null && rule.dayOfWeek !== localDate.weekday) continue;
      const time = parseTimeOfDay(rule.time);
      if (time === null) continue;
      const scheduledFor = zonedTimeToUtc(
        {
          year: localDate.year,
          month: localDate.month,
          day: localDate.day,
          hour: time.hour,
          minute: time.minute,
        },
        schedule.timezone,
      );
      if (scheduledFor === null) continue;
      if (scheduledFor.getTime() < from.getTime() || scheduledFor.getTime() > to.getTime())
        continue;
      const localDateValue = localDateKey(localDate);
      const localTimeValue = localTimeKey(time);
      const slotKey = `${schedule.definitionKey}:${localDateValue}T${localTimeValue}`;
      occurrences.set(slotKey, {
        slotKey,
        localDate: localDateValue,
        localTime: localTimeValue,
        scheduledFor,
        definitionKey: schedule.definitionKey,
        timezone: schedule.timezone,
      });
    }
  }
  return [...occurrences.values()].sort(
    (left, right) => left.scheduledFor.getTime() - right.scheduledFor.getTime(),
  );
}
