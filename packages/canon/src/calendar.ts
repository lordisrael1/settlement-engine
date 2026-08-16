/**
 * When money is actually *late*.
 *
 * "T+1" is a business rule, not twenty-four hours. A card payment taken at 6pm on the
 * Friday of a long weekend is not overdue on Saturday evening, and a system that says it
 * is will raise an exception every single weekend until the people reading the queue stop
 * reading the queue. An alert that cries wolf is worse than no alert at all.
 *
 * Four things decide the real deadline, and all four are per-source data:
 *
 *   the cut-off      a payment after it belongs to the next business day
 *   business days    weekends are not settlement days
 *   holidays         and neither is a public holiday
 *   grace            slack before silence becomes somebody's problem
 *
 * Everything here is pure arithmetic on arguments. Nothing reads a clock, so a run in
 * March and a replay of it in December agree about what was late (Law 5).
 */

/** `0` is Sunday, matching `Date.prototype.getUTCDay`. */
export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;

/** A calendar date with no time and no zone: `YYYY-MM-DD`. */
export type CalendarDate = string;

export interface BusinessCalendar {
  /**
   * Minutes past midnight UTC after which a payment is treated as the next business day's
   * business. Nigerian PSPs quote these in WAT (UTC+1), so a 5pm cut-off is `960`.
   */
  readonly cutOffMinutesUtc: number;
  /** Business days from the effective day to the expected payout. T+1 is `1`. */
  readonly settlementBusinessDays: number;
  readonly weekend: readonly Weekday[];
  /** Public holidays, as `YYYY-MM-DD`. Not business days even when midweek. */
  readonly holidays: readonly CalendarDate[];
  /**
   * Slack after the deadline before an unmatched promise escalates.
   *
   * The deadline marks when the money was *expected*; this marks when its absence becomes
   * an exception a human is woken for. They are different questions and deserve different
   * numbers — see D-026.
   */
  readonly graceMinutes: number;
}

const MINUTES = 60_000;
const DAY = 24 * 60 * MINUTES;

export function toCalendarDate(instant: Date): CalendarDate {
  return instant.toISOString().slice(0, 10);
}

export function isBusinessDay(calendar: BusinessCalendar, day: Date): boolean {
  const weekday = day.getUTCDay() as Weekday;
  if (calendar.weekend.includes(weekday)) return false;
  return !calendar.holidays.includes(toCalendarDate(day));
}

/**
 * The day a payment's settlement clock starts.
 *
 * A payment after the cut-off has missed today's batch, and one taken on a Sunday was
 * never going to be in a batch at all — both start counting from the next day the source
 * actually settles on.
 */
export function effectiveBusinessDay(calendar: BusinessCalendar, occurredAt: Date): Date {
  const midnight = new Date(Date.UTC(
    occurredAt.getUTCFullYear(),
    occurredAt.getUTCMonth(),
    occurredAt.getUTCDate(),
  ));

  const minutesOfDay = (occurredAt.getTime() - midnight.getTime()) / MINUTES;
  const start = minutesOfDay >= calendar.cutOffMinutesUtc
    ? new Date(midnight.getTime() + DAY)
    : midnight;

  return isBusinessDay(calendar, start) ? start : nextBusinessDay(calendar, start);
}

export function nextBusinessDay(calendar: BusinessCalendar, day: Date): Date {
  // Bounded so a calendar that accidentally declares every day a holiday fails loudly
  // instead of looping forever.
  let candidate = new Date(day.getTime() + DAY);
  for (let step = 0; step < 400; step += 1) {
    if (isBusinessDay(calendar, candidate)) return candidate;
    candidate = new Date(candidate.getTime() + DAY);
  }
  throw new Error(
    'No business day found within a year. Check the calendar: its weekend and holiday ' +
      'lists between them appear to cover every day.',
  );
}

export function addBusinessDays(
  calendar: BusinessCalendar,
  day: Date,
  count: number,
): Date {
  let result = day;
  for (let step = 0; step < count; step += 1) result = nextBusinessDay(calendar, result);
  return result;
}

/**
 * When the money was due: the cut-off time on the Nth business day after the payment's
 * effective day.
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
  return new Date(due.getTime() + calendar.cutOffMinutesUtc * MINUTES);
}

/** True once the deadline *and* the grace period have both passed. */
export function isOverdue(
  calendar: BusinessCalendar,
  occurredAt: Date,
  asOf: Date,
): boolean {
  const escalatesAt =
    settlementDeadline(calendar, occurredAt).getTime() + calendar.graceMinutes * MINUTES;
  return asOf.getTime() > escalatesAt;
}
