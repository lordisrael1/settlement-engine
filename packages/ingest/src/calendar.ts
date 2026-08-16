import type { BusinessCalendar, CalendarDate } from '@recon/canon';

/**
 * Nigerian public holidays, as data.
 *
 * Two of these move: Eid al-Fitr and Eid al-Adha follow the lunar calendar and are
 * announced by the federal government, sometimes days beforehand, and Nigeria routinely
 * declares an extra day beside them. So this is a table somebody maintains, not a formula
 * somebody derives — and when it goes stale the failure is visible and mild: a settlement
 * that was never late gets flagged as late, which is a false alert rather than a silent
 * miss.
 *
 * Dates are UTC, matching how the calendar arithmetic in `@recon/canon` reads them. WAT is
 * UTC+1 and has no daylight saving, so a Nigerian calendar day and a UTC day differ only
 * for the first hour after midnight — well before any PSP's cut-off.
 */
export const NIGERIA_HOLIDAYS_2026: readonly CalendarDate[] = [
  '2026-01-01', // New Year's Day
  '2026-03-20', // Eid al-Fitr (approximate — confirm against the federal announcement)
  '2026-03-23', // Eid al-Fitr, second day
  '2026-04-03', // Good Friday
  '2026-04-06', // Easter Monday
  '2026-05-01', // Workers' Day
  '2026-05-27', // Eid al-Adha (approximate)
  '2026-05-28', // Eid al-Adha, second day
  '2026-06-12', // Democracy Day
  '2026-08-25', // Maulud an-Nabi (approximate)
  '2026-10-01', // Independence Day
  '2026-12-25', // Christmas Day
  '2026-12-28', // Boxing Day, observed
];

/** Saturday and Sunday. Nigerian banks settle on neither. */
const WEEKEND = [0, 6] as const;

/**
 * Build a source's calendar from the two things it actually publishes: when it stops
 * accepting today's batch, and how many business days later the money moves.
 *
 * `graceMinutes` is ours, not theirs. The deadline is when money was *expected*; the grace
 * period is how long we tolerate its absence before waking somebody. A day of grace on a
 * T+1 rail means an ordinary delay resolves itself overnight and only a real problem
 * survives to become an exception (D-026).
 */
export function calendar(options: {
  cutOffMinutesUtc: number;
  settlementBusinessDays: number;
  graceMinutes: number;
  holidays?: readonly CalendarDate[];
}): BusinessCalendar {
  return {
    cutOffMinutesUtc: options.cutOffMinutesUtc,
    settlementBusinessDays: options.settlementBusinessDays,
    weekend: WEEKEND,
    holidays: options.holidays ?? NIGERIA_HOLIDAYS_2026,
    graceMinutes: options.graceMinutes,
  };
}

/** 17:00 WAT — the cut-off most Nigerian PSPs quote — expressed in UTC minutes. */
export const CUT_OFF_5PM_WAT = 16 * 60;
/** 22:00 WAT, for rails that batch late. */
export const CUT_OFF_10PM_WAT = 21 * 60;

export const ONE_DAY_GRACE = 24 * 60;
export const FOUR_HOURS_GRACE = 4 * 60;
