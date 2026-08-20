import type { BusinessCalendar, CalendarDate, HolidayCalendar } from '@recon/canon';

/**
 * Nigerian public holidays, as versioned data.
 *
 * Two of these move. Eid al-Fitr and Eid al-Adha follow the lunar calendar and are
 * announced by the federal government — sometimes days beforehand — and Nigeria routinely
 * declares an extra day beside them. So this is a table somebody maintains, not a formula
 * somebody derives.
 *
 * The consequence is why each edition carries a `revision` rather than being a bare list.
 * The table for a year genuinely changes *during* that year, and a reconciliation run
 * before a correction and a replay run after it would otherwise disagree about whether a
 * payment was late, with nothing in the record to say why. A revision makes the correction
 * a citable fact: the deadline was computed against `NG-2026@1`, and the revision that
 * moved Eid is `NG-2026@2`, and both editions still exist.
 *
 * Coverage is explicit for the same reason. A payment in 2027, against a system holding
 * only 2025 and 2026, is not a payment with no holidays — it is a payment we cannot price
 * the calendar for, and `isCovered` in `@recon/canon` says so out loud rather than
 * silently treating every January day as a business day.
 *
 * Dates are local Nigerian dates. WAT is UTC+1 with no daylight saving, but nothing here
 * relies on that any more: the calendar names `Africa/Lagos` and the conversion is done
 * properly.
 */
export const NIGERIA_2025: HolidayCalendar = {
  calendarId: 'NG-2025',
  revision: 1,
  revisedAt: new Date('2025-01-01T00:00:00Z'),
  coversFrom: '2025-01-01',
  coversTo: '2025-12-31',
  days: [
    '2025-01-01', // New Year's Day
    '2025-03-31', // Eid al-Fitr
    '2025-04-01', // Eid al-Fitr, second day
    '2025-04-18', // Good Friday
    '2025-04-21', // Easter Monday
    '2025-05-01', // Workers' Day
    '2025-06-06', // Eid al-Adha
    '2025-06-09', // Eid al-Adha, observed
    '2025-06-12', // Democracy Day
    '2025-09-05', // Maulud an-Nabi
    '2025-10-01', // Independence Day
    '2025-12-25', // Christmas Day
    '2025-12-26', // Boxing Day
  ],
};

export const NIGERIA_2026: HolidayCalendar = {
  calendarId: 'NG-2026',
  revision: 1,
  revisedAt: new Date('2026-01-01T00:00:00Z'),
  coversFrom: '2026-01-01',
  coversTo: '2026-12-31',
  days: [
    '2026-01-01', // New Year's Day
    '2026-03-20', // Eid al-Fitr (lunar — confirm against the federal announcement)
    '2026-03-23', // Eid al-Fitr, second day
    '2026-04-03', // Good Friday
    '2026-04-06', // Easter Monday
    '2026-05-01', // Workers' Day
    '2026-05-27', // Eid al-Adha (lunar)
    '2026-05-28', // Eid al-Adha, second day
    '2026-06-12', // Democracy Day
    '2026-08-25', // Maulud an-Nabi (lunar)
    '2026-10-01', // Independence Day
    '2026-12-25', // Christmas Day
    '2026-12-28', // Boxing Day, observed
  ],
};

/**
 * Every edition this deployment holds, newest jurisdiction-year last.
 *
 * A correction is added to this list as a new `HolidayCalendar` with the same
 * `calendarId` and a higher `revision`; the superseded edition stays, because a
 * reconciliation that ran against it is still a reconciliation somebody has to be able to
 * explain.
 */
export const NIGERIA_HOLIDAYS: readonly HolidayCalendar[] = [NIGERIA_2025, NIGERIA_2026];

/** Nigeria's zone. No daylight saving, which is a fact about Lagos and not an assumption. */
export const LAGOS = 'Africa/Lagos';

/** Saturday and Sunday. Nigerian banks settle on neither. */
const WEEKEND = [0, 6] as const;

/**
 * Build a source's calendar from the three things it actually publishes: the zone its
 * cut-off is quoted in, when it stops accepting today's batch, and how many business days
 * later the money moves.
 *
 * `graceMinutes` is ours, not theirs. The deadline is when money was *expected*; the grace
 * period is how long we tolerate its absence before waking somebody. A day of grace on a
 * T+1 rail means an ordinary delay resolves itself overnight and only a real problem
 * survives to become an exception (ADR-0026).
 */
export function calendar(options: {
  cutOffMinutes: number;
  settlementBusinessDays: number;
  graceMinutes: number;
  timeZone?: string;
  holidayCalendars?: readonly HolidayCalendar[];
}): BusinessCalendar {
  return {
    timeZone: options.timeZone ?? LAGOS,
    cutOffMinutes: options.cutOffMinutes,
    settlementBusinessDays: options.settlementBusinessDays,
    weekend: WEEKEND,
    holidayCalendars: options.holidayCalendars ?? NIGERIA_HOLIDAYS,
    graceMinutes: options.graceMinutes,
  };
}

/**
 * 17:00 — the cut-off most Nigerian PSPs quote — as minutes past *local* midnight.
 *
 * It was `16 * 60` when calendars were expressed in UTC. That it is now the number on the
 * PSP's own pricing page, and the zone does the conversion, is the entire point of the
 * change: a constant that has to be adjusted by hand for an offset is a constant that will
 * eventually be adjusted wrongly.
 */
export const CUT_OFF_5PM_WAT = 17 * 60;
/** 22:00 local, for rails that batch late. */
export const CUT_OFF_10PM_WAT = 22 * 60;

export const ONE_DAY_GRACE = 24 * 60;
export const FOUR_HOURS_GRACE = 4 * 60;

/** Re-exported so a deployment can name a specific edition without importing `canon`. */
export type { CalendarDate, HolidayCalendar };
