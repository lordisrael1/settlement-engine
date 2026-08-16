/**
 * When money is actually *late*.
 *
 * "T+1" is a business rule, not twenty-four hours. A card payment taken at 6pm on the
 * Friday of a long weekend is not overdue on Saturday evening, and a system that says it
 * is will raise an exception every single weekend until the people reading the queue stop
 * reading the queue. An alert that cries wolf is worse than no alert at all.
 *
 * Five things decide the real deadline, and all five are per-source data:
 *
 *   the zone         a cut-off is a *local* time, in a named place
 *   the cut-off      a payment after it belongs to the next business day
 *   business days    weekends are not settlement days
 *   holidays         and neither is a public holiday, per a versioned calendar
 *   grace            slack before silence becomes somebody's problem
 *
 * The zone and the calendar version are the two that this file gained after the first
 * implementation, and both for the same reason: a deadline computed from `UTC+1 baked into
 * a constant` and `whatever holidays the code happened to list` is reproducible only by
 * accident. A reconciliation of March, re-run in December, must reach March's answer using
 * March's holiday table — the same discipline `fees.ts` applies to rates, applied to time.
 *
 * Everything here is pure arithmetic on arguments. Nothing reads a clock, so a run in
 * March and a replay of it in December agree about what was late (Law 5).
 */

import type { CalendarDate, TimeZoneName } from './zone.js';
import { addDays, dayOfWeek, instantAt, zonedCalendarDate, zonedDateTime } from './zone.js';

/** `0` is Sunday, matching `Date.prototype.getUTCDay`. */
export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;

/**
 * A published list of public holidays, for a jurisdiction, for a period, at a revision.
 *
 * Two of Nigeria's holidays move: Eid al-Fitr and Eid al-Adha follow the lunar calendar
 * and are announced by the federal government, sometimes days beforehand, and an extra day
 * is routinely declared beside them. So the table is *revised*, in the middle of the year
 * it describes — and a reconciliation run before the revision and a replay run after it
 * would silently disagree about whether a payment was late, unless the revision is a fact
 * with a name.
 *
 * `revision` is what makes that fact citable. The highest revision covering a day wins, so
 * a correction supersedes rather than merging, and an exception can be traced to the
 * edition of the calendar that produced it.
 */
export interface HolidayCalendar {
  /** The jurisdiction and period this covers: `'NG-2026'`. */
  readonly calendarId: string;
  /** Monotonic. A later revision of the same period supersedes an earlier one. */
  readonly revision: number;
  readonly revisedAt: Date;
  /** Inclusive bounds of what this edition claims to know about. */
  readonly coversFrom: CalendarDate;
  readonly coversTo: CalendarDate;
  /** Local dates, in the calendar's own jurisdiction. Not business days. */
  readonly days: readonly CalendarDate[];
}

export interface BusinessCalendar {
  /** The zone the source's cut-off is quoted in: `'Africa/Lagos'`. */
  readonly timeZone: TimeZoneName;
  /**
   * Minutes past *local* midnight after which a payment is treated as the next business
   * day's business. A 5pm WAT cut-off is `1020`, and it stays `1020` whatever the zone's
   * offset does — which is the whole reason this is no longer expressed in UTC.
   */
  readonly cutOffMinutes: number;
  /** Business days from the effective day to the expected payout. T+1 is `1`. */
  readonly settlementBusinessDays: number;
  readonly weekend: readonly Weekday[];
  /**
   * Every edition of every holiday table this source's deadlines are computed against.
   *
   * A list rather than a set of dates, so that 2025 and 2026 can both be present and so
   * that a revised 2026 can supersede the original without deleting it.
   */
  readonly holidayCalendars: readonly HolidayCalendar[];
  /**
   * Slack after the deadline before an unmatched promise escalates.
   *
   * The deadline marks when the money was *expected*; this marks when its absence becomes
   * an exception a human is woken for. They are different questions and deserve different
   * numbers — see D-026.
   */
  readonly graceMinutes: number;
}

const MINUTE = 60_000;

/** The local date, in the calendar's own zone, at an instant. */
export function localDay(calendar: BusinessCalendar, instant: Date): CalendarDate {
  return zonedCalendarDate(instant, calendar.timeZone);
}

/**
 * The edition of the holiday table that governs this day, or `null` if none covers it.
 *
 * Highest revision wins, and the id breaks ties so that two editions loaded in a different
 * order still produce the same answer (Law 5 reaches even here).
 */
export function holidayCalendarFor(
  calendar: BusinessCalendar,
  day: CalendarDate,
): HolidayCalendar | null {
  const covering = calendar.holidayCalendars.filter(
    (edition) => edition.coversFrom <= day && day <= edition.coversTo,
  );
  if (covering.length === 0) return null;

  return covering.reduce((best, candidate) =>
    candidate.revision > best.revision ||
    (candidate.revision === best.revision && candidate.calendarId > best.calendarId)
      ? candidate
      : best,
  );
}

/**
 * Whether we hold *any* holiday table for this day.
 *
 * Worth asking separately, because the answer to "is this a business day?" for an
 * uncovered day is "as far as we know, yes" — which is a guess, not knowledge. An
 * uncovered day cannot make the system book wrong money; it can only make a settlement
 * that was never late look late, or the reverse. That is a mild, visible failure, and
 * exposing the predicate lets an operator see it coming rather than discovering it as a
 * mysterious January of false alerts.
 */
export function isCovered(calendar: BusinessCalendar, day: CalendarDate): boolean {
  return holidayCalendarFor(calendar, day) !== null;
}

export function isHoliday(calendar: BusinessCalendar, day: CalendarDate): boolean {
  return holidayCalendarFor(calendar, day)?.days.includes(day) ?? false;
}

export function isBusinessDay(calendar: BusinessCalendar, day: CalendarDate): boolean {
  if (calendar.weekend.includes(dayOfWeek(day) as Weekday)) return false;
  return !isHoliday(calendar, day);
}

/**
 * The day a payment's settlement clock starts.
 *
 * A payment after the cut-off has missed today's batch, and one taken on a Sunday was
 * never going to be in a batch at all — both start counting from the next day the source
 * actually settles on. Both comparisons are made against the wall clock in the source's own
 * zone, because that is the clock the source's batch runs on.
 */
export function effectiveBusinessDay(
  calendar: BusinessCalendar,
  occurredAt: Date,
): CalendarDate {
  const local = zonedDateTime(occurredAt, calendar.timeZone);
  const sameDay = localDay(calendar, occurredAt);
  const start =
    local.minutesOfDay >= calendar.cutOffMinutes ? addDays(sameDay, 1) : sameDay;

  return isBusinessDay(calendar, start) ? start : nextBusinessDay(calendar, start);
}

export function nextBusinessDay(
  calendar: BusinessCalendar,
  day: CalendarDate,
): CalendarDate {
  // Bounded so a calendar that accidentally declares every day a holiday fails loudly
  // instead of looping forever.
  let candidate = addDays(day, 1);
  for (let step = 0; step < 400; step += 1) {
    if (isBusinessDay(calendar, candidate)) return candidate;
    candidate = addDays(candidate, 1);
  }
  throw new Error(
    'No business day found within a year. Check the calendar: its weekend and holiday ' +
      'lists between them appear to cover every day.',
  );
}

export function addBusinessDays(
  calendar: BusinessCalendar,
  day: CalendarDate,
  count: number,
): CalendarDate {
  let result = day;
  for (let step = 0; step < count; step += 1) result = nextBusinessDay(calendar, result);
  return result;
}

/**
 * When the money was due: the cut-off time on the Nth business day after the payment's
 * effective day, resolved back into an instant through the source's own zone.
 *
 * Due, not late — `isOverdue` adds the grace period on top, because those are two
 * different questions and conflating them is what makes an exception queue useless.
 */
export function settlementDeadline(calendar: BusinessCalendar, occurredAt: Date): Date {
  const due = addBusinessDays(
    calendar,
    effectiveBusinessDay(calendar, occurredAt),
    calendar.settlementBusinessDays,
  );
  return instantAt(calendar.timeZone, due, calendar.cutOffMinutes);
}

/** True once the deadline *and* the grace period have both passed. */
export function isOverdue(
  calendar: BusinessCalendar,
  occurredAt: Date,
  asOf: Date,
): boolean {
  const escalatesAt =
    settlementDeadline(calendar, occurredAt).getTime() + calendar.graceMinutes * MINUTE;
  return asOf.getTime() > escalatesAt;
}

/**
 * Which holiday editions a deadline calculation actually consulted.
 *
 * The answer to "why did we think this was due on Tuesday?" is the calendar's zone, its
 * cut-off, and *this* — the named, revisioned tables that said Monday was not a business
 * day. Returned rather than logged, so the caller can persist it beside the conclusion.
 */
export function deadlineProvenance(
  calendar: BusinessCalendar,
  occurredAt: Date,
): {
  readonly effectiveDay: CalendarDate;
  readonly dueDay: CalendarDate;
  readonly deadline: Date;
  readonly editions: readonly string[];
  readonly fullyCovered: boolean;
} {
  const effectiveDay = effectiveBusinessDay(calendar, occurredAt);
  const dueDay = addBusinessDays(calendar, effectiveDay, calendar.settlementBusinessDays);

  const editions = new Set<string>();
  let fullyCovered = true;
  for (let day = localDay(calendar, occurredAt); day <= dueDay; day = addDays(day, 1)) {
    const edition = holidayCalendarFor(calendar, day);
    if (edition) editions.add(`${edition.calendarId}@${edition.revision}`);
    else fullyCovered = false;
  }

  return {
    effectiveDay,
    dueDay,
    deadline: instantAt(calendar.timeZone, dueDay, calendar.cutOffMinutes),
    editions: [...editions].sort(),
    fullyCovered,
  };
}
