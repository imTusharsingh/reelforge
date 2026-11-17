import { ConflictException } from "@nestjs/common";
import { CadenceSchema } from "@reelforge/contracts";
const minute = 60000;
function fields(date: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const get = (key: string): string => parts.find((p) => p.type === key)!.value;
  return `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}`;
}
/** Resolve a wall time to its first fold occurrence; move gaps to the first real wall minute. */
function wallTime(day: string, time: string, timezone: string): Date {
  const wall = Date.parse(`${day}T${time}:00Z`);
  for (let gap = 0; gap <= 180; gap++) {
    const local = new Date(wall + gap * minute).toISOString().slice(0, 16);
    const candidates: Date[] = [];
    for (let offset = -14 * 60; offset <= 14 * 60; offset += 15) {
      const date = new Date(wall + gap * minute + offset * minute);
      if (fields(date, timezone) === local) candidates.push(date);
    }
    if (candidates[0]) return candidates[0];
  }
  throw new ConflictException("Cadence wall time could not be resolved");
}
export function nextPublishingSlot(
  cadenceInput: unknown,
  now: Date,
  occupied: readonly Date[],
): Date {
  const cadence = CadenceSchema.parse(cadenceInput);
  const day = fields(now, cadence.timezone).slice(0, 10);
  const [hour, minutes] = cadence.localTime.split(":").map(Number);
  const first = hour! * 60 + minutes!;
  const taken = new Set(occupied.map((d) => d.getTime()));
  for (let days = 0; days < 60; days++) {
    const localDay = new Date(Date.parse(`${day}T12:00:00Z`) + days * 86400000)
      .toISOString()
      .slice(0, 10);
    const times = Array.from(
      { length: cadence.shortsPerDay },
      (_, i) => (first + Math.floor((i * 1440) / cadence.shortsPerDay)) % 1440,
    ).sort((a, b) => a - b);
    for (const time of times) {
      const wall = `${String(Math.floor(time / 60)).padStart(2, "0")}:${String(time % 60).padStart(2, "0")}`;
      const slot = wallTime(localDay, wall, cadence.timezone);
      if (slot.getTime() >= now.getTime() + 15 * minute && !taken.has(slot.getTime())) return slot;
    }
  }
  throw new ConflictException("No free cadence slot in the next 60 days");
}
export function pacificQuotaDay(now: Date): string {
  return fields(now, "America/Los_Angeles").slice(0, 10);
}
