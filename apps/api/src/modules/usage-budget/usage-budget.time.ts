import type { UsagePeriod } from "./usage-budget.types.js";

const cache = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let found = cache.get(timeZone);
  if (!found) {
    found = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hour12: false,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    cache.set(timeZone, found);
  }
  return found;
}

export function isValidTimeZone(timeZone: string): boolean {
  try {
    formatter(timeZone);
    return true;
  } catch {
    return false;
  }
}

type Parts = { year: number; month: number; day: number; hour: number; minute: number };

function localParts(instant: Date, timeZone: string): Parts {
  const parts = formatter(timeZone).formatToParts(instant);
  const get = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((part) => part.type === type)?.value ?? Number.NaN);
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour: get("hour") % 24,
    minute: get("minute"),
  };
}

/** Offset (local minus UTC) in ms at an instant. */
function offsetMs(instant: Date, timeZone: string): number {
  const parts = localParts(instant, timeZone);
  const local = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute);
  return local - Math.floor(instant.getTime() / 60_000) * 60_000;
}

/**
 * The first UTC instant whose local date in `timeZone` is year-month-day. Handles DST: when local
 * midnight does not exist (a spring-forward gap at 00:00) the day starts at the first valid
 * minute after it.
 */
export function startOfLocalDay(year: number, month: number, day: number, timeZone: string): Date {
  const naive = Date.UTC(year, month - 1, day);
  let candidate = naive - offsetMs(new Date(naive), timeZone);
  candidate = naive - offsetMs(new Date(candidate), timeZone);
  // Step back while the previous minute is still on the same local date (fall-back overlap),
  // then forward while we are still on the previous local date (spring-forward gap).
  const sameDay = (ms: number): boolean => {
    const parts = localParts(new Date(ms), timeZone);
    return parts.year === year && parts.month === month && parts.day === day;
  };
  for (let guard = 0; guard < 180 && sameDay(candidate - 60_000); guard += 1) candidate -= 60_000;
  for (let guard = 0; guard < 180 && !sameDay(candidate); guard += 1) candidate += 60_000;
  return new Date(candidate);
}

export type PeriodBounds = Readonly<{ period: UsagePeriod; start: Date; end: Date; key: string }>;

/** Calendar day or month containing `instant`, in the given IANA timezone. */
export function periodBounds(instant: Date, period: UsagePeriod, timeZone: string): PeriodBounds {
  const local = localParts(instant, timeZone);
  if (period === "DAY") {
    const next = new Date(Date.UTC(local.year, local.month - 1, local.day + 1));
    return {
      period,
      start: startOfLocalDay(local.year, local.month, local.day, timeZone),
      end: startOfLocalDay(
        next.getUTCFullYear(),
        next.getUTCMonth() + 1,
        next.getUTCDate(),
        timeZone,
      ),
      key: `${pad(local.year, 4)}-${pad(local.month)}-${pad(local.day)}`,
    };
  }
  const next = new Date(Date.UTC(local.year, local.month, 1));
  return {
    period,
    start: startOfLocalDay(local.year, local.month, 1, timeZone),
    end: startOfLocalDay(next.getUTCFullYear(), next.getUTCMonth() + 1, 1, timeZone),
    key: `${pad(local.year, 4)}-${pad(local.month)}`,
  };
}

/** Period containing a local calendar date (YYYY-MM-DD) in the timezone. */
export function periodForLocalDate(
  date: string,
  period: UsagePeriod,
  timeZone: string,
): PeriodBounds {
  const [year, month, day] = date.split("-").map(Number) as [number, number, number];
  const start = startOfLocalDay(year, month, period === "DAY" ? day : 1, timeZone);
  return periodBounds(start, period, timeZone);
}

function pad(value: number, width = 2): string {
  return value.toString().padStart(width, "0");
}
