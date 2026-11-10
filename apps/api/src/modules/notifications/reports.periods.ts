export type ReportPeriodType = "DAILY" | "WEEKLY";

export type ReportPeriod = Readonly<{
  periodType: ReportPeriodType;
  timezone: string;
  /** First local calendar day in the period (YYYY-MM-DD). */
  localStartDate: string;
  /** Last local calendar day in the period, inclusive (YYYY-MM-DD). */
  localEndDate: string;
  /** UTC instant of the first moment of localStartDate in the timezone. */
  start: Date;
  /** UTC instant of the first moment of the day after localEndDate (exclusive). */
  end: Date;
}>;

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  const cached = formatters.get(timeZone);
  if (cached) return cached;
  const created = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  formatters.set(timeZone, created);
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

/** The local calendar date (YYYY-MM-DD) of an instant in an IANA timezone. */
export function localDateOf(instant: Date, timeZone: string): string {
  const parts = formatter(timeZone).formatToParts(instant);
  const get = (type: Intl.DateTimeFormatPartTypes): string => {
    const part = parts.find((item) => item.type === type);
    if (!part) throw new Error(`Missing ${type} for timezone ${timeZone}`);
    return part.value;
  };
  return `${get("year")}-${get("month")}-${get("day")}`;
}

const datePattern = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isValidLocalDate(value: string): boolean {
  const match = datePattern.exec(value);
  if (!match) return false;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return date.toISOString().slice(0, 10) === value;
}

export function addLocalDays(date: string, days: number): string {
  if (!isValidLocalDate(date)) throw new Error(`Invalid local date ${date}`);
  const [year, month, day] = date.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

/** ISO weekday of a local date: 1 = Monday ... 7 = Sunday. */
export function isoWeekday(date: string): number {
  const [year, month, day] = date.split("-").map(Number) as [number, number, number];
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return weekday === 0 ? 7 : weekday;
}

/**
 * The first instant whose local date in the timezone is `date`. Found by binary search over
 * a ±16 h window around UTC midnight, so it is exact (to the millisecond) across DST changes,
 * including zones where local midnight itself is skipped.
 */
export function startOfLocalDay(date: string, timeZone: string): Date {
  if (!isValidLocalDate(date)) throw new Error(`Invalid local date ${date}`);
  if (!isValidTimeZone(timeZone)) throw new Error(`Invalid timezone ${timeZone}`);
  const naive = Date.parse(`${date}T00:00:00.000Z`);
  let low = naive - 16 * 3_600_000;
  let high = naive + 16 * 3_600_000;
  // Invariant: localDate(low) < date <= localDate(high).
  while (high - low > 1) {
    const middle = Math.floor((low + high) / 2);
    if (localDateOf(new Date(middle), timeZone) >= date) high = middle;
    else low = middle;
  }
  return new Date(high);
}

export function reportPeriod(
  periodType: ReportPeriodType,
  localStartDate: string,
  timeZone: string,
): ReportPeriod {
  if (!isValidLocalDate(localStartDate)) throw new Error("periodStartDate must be YYYY-MM-DD");
  if (periodType === "WEEKLY" && isoWeekday(localStartDate) !== 1)
    throw new Error("A weekly period must start on a Monday");
  const days = periodType === "DAILY" ? 1 : 7;
  const next = addLocalDays(localStartDate, days);
  return {
    periodType,
    timezone: timeZone,
    localStartDate,
    localEndDate: addLocalDays(localStartDate, days - 1),
    start: startOfLocalDay(localStartDate, timeZone),
    end: startOfLocalDay(next, timeZone),
  };
}

/** The most recent fully completed period at `now` in the timezone. */
export function lastCompletedPeriod(
  periodType: ReportPeriodType,
  now: Date,
  timeZone: string,
): ReportPeriod {
  const today = localDateOf(now, timeZone);
  if (periodType === "DAILY") return reportPeriod("DAILY", addLocalDays(today, -1), timeZone);
  const thisMonday = addLocalDays(today, 1 - isoWeekday(today));
  return reportPeriod("WEEKLY", addLocalDays(thisMonday, -7), timeZone);
}

/** Local calendar dates in the period, inclusive. */
export function periodDates(period: ReportPeriod): string[] {
  const dates: string[] = [];
  for (let date = period.localStartDate; date <= period.localEndDate; date = addLocalDays(date, 1))
    dates.push(date);
  return dates;
}
