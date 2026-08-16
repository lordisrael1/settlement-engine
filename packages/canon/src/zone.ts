/**
 * Wall-clock time in a named place.
 *
 * A settlement cut-off is not an instant, it is a *local time*: "3pm in Lagos" is a
 * different instant every day of the year in a zone with daylight saving, and it is a
 * different instant from "3pm UTC" every day of the year in one without. The previous
 * calendar stored `cutOffMinutesUtc` and got the right answer for Nigeria by arithmetic
 * coincidence — WAT is UTC+1 with no daylight saving, so subtracting an hour by hand
 * works. It stops working the first time this system reconciles a rail in a zone that
 * observes DST, and it fails silently, one hour at a time, twice a year.
 *
 * So a calendar names its zone and this file does the conversion, using the IANA database
 * the platform already ships. Two operations are needed and no more:
 *
 *   `zonedDateTime`  an instant → what the clock on the wall said
 *   `instantAt`      what the clock on the wall said → the instant
 *
 * The second is the hard direction, because an offset is a property of an instant and we
 * are trying to find the instant. The two-pass resolution below is the standard fix: guess
 * with one offset, look up the offset that actually applies at the guess, and use that. It
 * converges everywhere except inside a DST gap, where no such instant exists at all and any
 * answer is a choice rather than a fact.
 *
 * Nothing here reads a clock. Every function is a pure map between representations.
 */

/** An IANA zone name — `'Africa/Lagos'`, `'Europe/London'`. Invalid names throw, loudly. */
export type TimeZoneName = string;

/** A calendar date with no time and no zone: `YYYY-MM-DD`. */
export type CalendarDate = string;

/** What a clock in some zone read at some instant. */
export interface ZonedDateTime {
  readonly year: number;
  /** 1–12. Calendar months, not `Date`'s zero-based ones. */
  readonly month: number;
  readonly day: number;
  /** Minutes past local midnight. 17:00 is `1020`. */
  readonly minutesOfDay: number;
  readonly seconds: number;
}

const MINUTE = 60_000;

/**
 * `Intl.DateTimeFormat` construction is expensive and these are immutable, so one per zone
 * is kept. The cache is keyed by the zone name, which is the whole of the configuration.
 */
const FORMATTERS = new Map<TimeZoneName, Intl.DateTimeFormat>();

function formatter(timeZone: TimeZoneName): Intl.DateTimeFormat {
  const cached = FORMATTERS.get(timeZone);
  if (cached) return cached;

  // An unknown zone throws `RangeError` here, at configuration time, rather than producing
  // plausible UTC answers for a rail nobody noticed was misconfigured.
  const built = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  FORMATTERS.set(timeZone, built);
  return built;
}

export function zonedDateTime(instant: Date, timeZone: TimeZoneName): ZonedDateTime {
  const parts = formatter(timeZone).formatToParts(instant);
  const value = (type: Intl.DateTimeFormatPartTypes): number => {
    const part = parts.find((candidate) => candidate.type === type);
    if (!part) throw new Error(`Zone "${timeZone}" produced no ${type} part`);
    return Number(part.value);
  };

  return {
    year: value('year'),
    month: value('month'),
    day: value('day'),
    minutesOfDay: value('hour') * 60 + value('minute'),
    seconds: value('second'),
  };
}

/**
 * How far ahead of UTC the zone was at that instant. `+60` for Lagos, always.
 *
 * Derived rather than tabulated: format the instant in the zone, then read those same
 * wall-clock numbers back as if they were UTC. The difference is the offset, by definition.
 */
export function offsetMinutes(instant: Date, timeZone: TimeZoneName): number {
  const local = zonedDateTime(instant, timeZone);
  const asIfUtc = Date.UTC(
    local.year,
    local.month - 1,
    local.day,
    0,
    local.minutesOfDay,
    local.seconds,
  );
  return Math.round((asIfUtc - instant.getTime()) / MINUTE);
}

/**
 * The instant at which a clock in `timeZone` reads this date and this many minutes past
 * midnight.
 *
 * Two passes, because the offset we need depends on the answer we are computing. The first
 * pass guesses using the offset in force at the naive UTC reading; the second uses the
 * offset in force at that guess, which is the correct one on every side of a transition
 * except within the hour a spring-forward deletes. Nigeria has no transitions at all, so
 * the second pass is free insurance for the day this reconciles a non-Nigerian rail.
 */
export function instantAt(
  timeZone: TimeZoneName,
  date: CalendarDate,
  minutesOfDay: number,
): Date {
  const { year, month, day } = partsOf(date);
  const naive = Date.UTC(year, month - 1, day, 0, minutesOfDay);

  const firstPass = naive - offsetMinutes(new Date(naive), timeZone) * MINUTE;
  const secondPass = naive - offsetMinutes(new Date(firstPass), timeZone) * MINUTE;
  return new Date(secondPass);
}

/** The date on the wall calendar in `timeZone` at that instant. */
export function zonedCalendarDate(instant: Date, timeZone: TimeZoneName): CalendarDate {
  const local = zonedDateTime(instant, timeZone);
  return calendarDate(local.year, local.month, local.day);
}

export function calendarDate(year: number, month: number, day: number): CalendarDate {
  return `${pad(year, 4)}-${pad(month, 2)}-${pad(day, 2)}`;
}

export function partsOf(date: CalendarDate): { year: number; month: number; day: number } {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) throw new Error(`"${date}" is not a YYYY-MM-DD calendar date`);
  return { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
}

/**
 * Calendar-day arithmetic, done as UTC arithmetic on a date with no time.
 *
 * Safe precisely because there is no time in it: adding a day to a date can never cross a
 * DST boundary, because a date does not have an offset to cross. Adding 24 hours to an
 * *instant* is the operation that breaks, and this file never does it.
 */
export function addDays(date: CalendarDate, days: number): CalendarDate {
  const { year, month, day } = partsOf(date);
  const shifted = new Date(Date.UTC(year, month - 1, day + days));
  return calendarDate(
    shifted.getUTCFullYear(),
    shifted.getUTCMonth() + 1,
    shifted.getUTCDate(),
  );
}

/** `0` is Sunday, matching `Date.prototype.getUTCDay`. */
export function dayOfWeek(date: CalendarDate): number {
  const { year, month, day } = partsOf(date);
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

/** String comparison is date comparison, which is the point of `YYYY-MM-DD`. */
export function isBefore(a: CalendarDate, b: CalendarDate): boolean {
  return a < b;
}

function pad(value: number, width: number): string {
  return value.toString().padStart(width, '0');
}
