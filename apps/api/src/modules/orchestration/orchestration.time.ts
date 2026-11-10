export type LocalDateTimeParts = Readonly<{
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  weekday: number;
}>;

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  const cached = formatterCache.get(timeZone);
  if (cached) return cached;
  const created = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  formatterCache.set(timeZone, created);
  return created;
}

export function isValidTimeZone(timeZone: string): boolean {
  try {
    formatter(timeZone);
    return true;
  } catch {
    return false;
  }
}

export function localDateTimeParts(instant: Date, timeZone: string): LocalDateTimeParts {
  const parts = formatter(timeZone).formatToParts(instant);
  const value = (type: Intl.DateTimeFormatPartTypes): number => {
    const part = parts.find((item) => item.type === type);
    if (!part) throw new Error(`Missing ${type} for timezone ${timeZone}`);
    return Number(part.value);
  };
  const year = value("year");
  const month = value("month");
  const day = value("day");
  const hour = value("hour") % 24;
  return {
    year,
    month,
    day,
    hour,
    minute: value("minute"),
    second: value("second"),
    weekday: new Date(Date.UTC(year, month - 1, day)).getUTCDay(),
  };
}

function utcMillis(parts: {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}): number {
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
}

function offsetMs(instant: Date, timeZone: string): number {
  const parts = localDateTimeParts(instant, timeZone);
  return utcMillis(parts) - instant.getTime();
}

/**
 * Converts a wall-clock time in an IANA timezone to a UTC instant. Returns null
 * when the wall-clock time does not exist (a DST spring-forward gap).
 *
 * Ambiguous fall-back times resolve to the first matching instant. The caller
 * deduplicates schedule slots by local date/time, so a repeated hour cannot
 * start two autonomous runs.
 */
export function zonedTimeToUtc(
  parts: {
    year: number;
    month: number;
    day: number;
    hour: number;
    minute: number;
  },
  timeZone: string,
): Date | null {
  if (!isValidTimeZone(timeZone)) return null;
  const naive = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, 0);
  let candidate = naive - offsetMs(new Date(naive), timeZone);
  candidate = naive - offsetMs(new Date(candidate), timeZone);
  const result = new Date(candidate);
  const roundTrip = localDateTimeParts(result, timeZone);
  if (
    roundTrip.year !== parts.year ||
    roundTrip.month !== parts.month ||
    roundTrip.day !== parts.day ||
    roundTrip.hour !== parts.hour ||
    roundTrip.minute !== parts.minute
  )
    return null;
  return result;
}

export function localDateKey(parts: { year: number; month: number; day: number }): string {
  return `${parts.year.toString().padStart(4, "0")}-${parts.month
    .toString()
    .padStart(2, "0")}-${parts.day.toString().padStart(2, "0")}`;
}

export function localTimeKey(parts: { hour: number; minute: number }): string {
  return `${parts.hour.toString().padStart(2, "0")}:${parts.minute.toString().padStart(2, "0")}`;
}

export function parseTimeOfDay(value: string): { hour: number; minute: number } | null {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value);
  if (!match) return null;
  return { hour: Number(match[1]), minute: Number(match[2]) };
}

export function addUtcDays(instant: Date, days: number): Date {
  return new Date(instant.getTime() + days * 86_400_000);
}
