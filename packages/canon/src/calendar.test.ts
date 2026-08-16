import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { BusinessCalendar, HolidayCalendar } from './calendar.js';
import {
  deadlineProvenance,
  effectiveBusinessDay,
  holidayCalendarFor,
  isBusinessDay,
  isCovered,
  isOverdue,
  settlementDeadline,
} from './calendar.js';
import { instantAt, offsetMinutes, zonedCalendarDate } from './zone.js';

/**
 * T+1 is a business rule, not twenty-four hours. These tests are the difference between an
 * exception queue somebody reads and one they learn to ignore.
 */

const NG_2026: HolidayCalendar = {
  calendarId: 'NG-2026',
  revision: 1,
  revisedAt: new Date('2026-01-01T00:00:00Z'),
  coversFrom: '2026-01-01',
  coversTo: '2026-12-31',
  days: ['2026-10-01'], // Independence Day, a Thursday
};

/** 5pm Lagos cut-off, T+1, weekends off, one public holiday, a day of grace. */
const T_PLUS_1: BusinessCalendar = {
  timeZone: 'Africa/Lagos',
  cutOffMinutes: 17 * 60,
  settlementBusinessDays: 1,
  weekend: [0, 6],
  holidayCalendars: [NG_2026],
  graceMinutes: 24 * 60,
};

const at = (iso: string) => new Date(iso);

test('a payment before the cut-off settles the next business day', () => {
  // Tuesday 14:00 UTC — 15:00 in Lagos, inside the 17:00 cut-off.
  const deadline = settlementDeadline(T_PLUS_1, at('2026-09-08T14:00:00Z'));
  assert.equal(deadline.toISOString(), '2026-09-09T16:00:00.000Z');
});

/**
 * The cut-off is the whole reason a calendar exists. A payment at one minute past has
 * missed today's batch and belongs to tomorrow's, and a system that ignores this reports
 * every evening payment as a day early.
 */
test('a payment after the cut-off belongs to the next business day', () => {
  const before = settlementDeadline(T_PLUS_1, at('2026-09-08T15:59:00Z'));
  const after = settlementDeadline(T_PLUS_1, at('2026-09-08T16:01:00Z'));

  assert.equal(before.toISOString(), '2026-09-09T16:00:00.000Z');
  assert.equal(after.toISOString(), '2026-09-10T16:00:00.000Z', 'one minute cost it a day');
});

/**
 * The Friday-evening case, which is the single most common false alert in Nigerian
 * settlement. A payment after Friday's cut-off has missed Friday's batch; it enters
 * Monday's, and T+1 from Monday is Tuesday. Under a naive 24-hour rule the same payment is
 * "overdue" on Saturday afternoon — every weekend, for every merchant.
 */
test('a Friday-evening payment enters Monday’s batch and is due Tuesday', () => {
  // Friday 2026-09-11, 17:00 UTC — 18:00 in Lagos, after the cut-off.
  const deadline = settlementDeadline(T_PLUS_1, at('2026-09-11T17:00:00Z'));

  assert.equal(deadline.toISOString(), '2026-09-15T16:00:00.000Z');
  assert.equal(deadline.getUTCDay(), 2, 'Tuesday');
  // Four days later than a 24-hour rule would have claimed, and not one of them an alert.
  assert.ok(!isOverdue(T_PLUS_1, at('2026-09-11T17:00:00Z'), at('2026-09-12T18:00:00Z')));
});

test('weekends are not settlement days', () => {
  // Saturday. The clock does not start until Monday, so T+1 lands on Tuesday.
  const deadline = settlementDeadline(T_PLUS_1, at('2026-09-12T09:00:00Z'));
  assert.equal(deadline.toISOString(), '2026-09-15T16:00:00.000Z');
});

test('a public holiday is skipped like a weekend', () => {
  // Wednesday 2026-09-30, before cut-off. T+1 would be Thursday 1 October — Independence
  // Day — so the deadline moves to Friday.
  const deadline = settlementDeadline(T_PLUS_1, at('2026-09-30T09:00:00Z'));
  assert.equal(deadline.toISOString(), '2026-10-02T16:00:00.000Z');
});

test('the effective day skips forward off a weekend', () => {
  assert.equal(effectiveBusinessDay(T_PLUS_1, at('2026-09-12T09:00:00Z')), '2026-09-14');
});

/**
 * Due and late are different questions. The deadline says when money was expected; grace
 * says how long its absence is tolerated before somebody is woken. Conflating them is what
 * makes a queue cry wolf.
 */
test('grace separates "due" from "late"', () => {
  const paid = at('2026-09-08T14:00:00Z');
  const deadline = settlementDeadline(T_PLUS_1, paid); // Wed 16:00Z

  assert.ok(!isOverdue(T_PLUS_1, paid, deadline), 'at the deadline, not yet late');
  assert.ok(
    !isOverdue(T_PLUS_1, paid, new Date(deadline.getTime() + 23 * 60 * 60_000)),
    'inside the grace period',
  );
  assert.ok(
    isOverdue(T_PLUS_1, paid, new Date(deadline.getTime() + 25 * 60 * 60_000)),
    'past the grace period',
  );
});

/**
 * Near-instant rails settle the same business day. The arithmetic has to hold at T+0 too,
 * or every virtual-account credit looks a day early.
 */
test('a same-day calendar settles on the effective day itself', () => {
  const sameDay: BusinessCalendar = { ...T_PLUS_1, settlementBusinessDays: 0, graceMinutes: 0 };
  const deadline = settlementDeadline(sameDay, at('2026-09-08T09:00:00Z'));
  assert.equal(deadline.toISOString(), '2026-09-08T16:00:00.000Z');
});

/**
 * A calendar that declares every day a holiday is a configuration error, and it must fail
 * loudly rather than spin. The bound is what stops a bad table becoming a hung process.
 */
test('a calendar with no business days at all fails loudly', () => {
  const impossible: BusinessCalendar = { ...T_PLUS_1, weekend: [0, 1, 2, 3, 4, 5, 6] };
  assert.throws(
    () => settlementDeadline(impossible, at('2026-09-08T09:00:00Z')),
    /No business day found within a year/,
  );
});

// ── The zone ────────────────────────────────────────────────────────────────

/**
 * The reason the cut-off is no longer stored in UTC. Lagos is UTC+1 all year, so the old
 * `cutOffMinutesUtc: 16 * 60` was right by hand-arithmetic — and the moment this reconciles
 * a rail in a zone that observes daylight saving, hand-arithmetic is wrong for half the
 * year, silently, in the direction of false alerts.
 */
test('a cut-off is a local time, not an offset somebody subtracted by hand', () => {
  assert.equal(offsetMinutes(at('2026-01-15T12:00:00Z'), 'Africa/Lagos'), 60);
  assert.equal(offsetMinutes(at('2026-07-15T12:00:00Z'), 'Africa/Lagos'), 60, 'no DST in Lagos');

  // 17:00 in Lagos is 16:00Z, and this is derived rather than assumed.
  assert.equal(
    instantAt('Africa/Lagos', '2026-09-09', 17 * 60).toISOString(),
    '2026-09-09T16:00:00.000Z',
  );
});

/**
 * The same calendar, in a zone that does observe daylight saving, produces two different
 * instants for the same wall-clock cut-off — which is the correct answer and the one the
 * UTC-minutes model could not express at all.
 */
test('a summer and a winter deadline differ by the zone’s own offset', () => {
  const london: BusinessCalendar = { ...T_PLUS_1, timeZone: 'Europe/London', holidayCalendars: [] };

  const winter = settlementDeadline(london, at('2026-01-13T09:00:00Z')); // Tue → Wed
  const summer = settlementDeadline(london, at('2026-07-14T09:00:00Z')); // Tue → Wed

  assert.equal(winter.toISOString(), '2026-01-14T17:00:00.000Z', 'GMT');
  assert.equal(summer.toISOString(), '2026-07-15T16:00:00.000Z', 'BST — an hour earlier in UTC');
});

/**
 * A payment just after midnight Lagos time is the case a UTC-day model gets wrong: 00:30
 * WAT is 23:30 UTC *the previous day*, so a system reading UTC days would put it in
 * yesterday's batch and expect the money a day early.
 */
test('the day a payment belongs to is the day in the source’s own zone', () => {
  const justAfterMidnight = at('2026-09-08T23:30:00Z'); // 00:30 on the 9th, in Lagos
  assert.equal(zonedCalendarDate(justAfterMidnight, 'Africa/Lagos'), '2026-09-09');
  assert.equal(effectiveBusinessDay(T_PLUS_1, justAfterMidnight), '2026-09-09');
});

// ── Versioned holiday tables ────────────────────────────────────────────────

/**
 * Eid moves, and it is announced days beforehand. So the table for a year is revised during
 * the year it describes — and a run before the revision and a replay after it would
 * otherwise disagree about whether a payment was late, with nothing in the record to say
 * why. The later revision wins, and the earlier one still exists to explain what it decided.
 */
test('a later revision of a holiday table supersedes an earlier one', () => {
  const corrected: HolidayCalendar = {
    ...NG_2026,
    revision: 2,
    revisedAt: new Date('2026-09-20T00:00:00Z'),
    days: ['2026-10-01', '2026-10-02'], // the federal government added a second day
  };
  const revised: BusinessCalendar = { ...T_PLUS_1, holidayCalendars: [NG_2026, corrected] };

  assert.equal(holidayCalendarFor(revised, '2026-10-02')?.revision, 2);
  assert.ok(!isBusinessDay(revised, '2026-10-02'), 'the added day is no longer a business day');
  assert.ok(isBusinessDay(T_PLUS_1, '2026-10-02'), 'under revision 1 it still was');

  // Same editions, loaded the other way round: the answer cannot depend on array order.
  const shuffled: BusinessCalendar = { ...T_PLUS_1, holidayCalendars: [corrected, NG_2026] };
  assert.equal(holidayCalendarFor(shuffled, '2026-10-02')?.revision, 2);
});

/**
 * A year we hold no table for is not a year with no holidays — it is a year we cannot
 * answer for. The deadline still computes, because a missing holiday table can only produce
 * a mild, visible failure (a settlement that was never late looking late), but the gap is
 * askable rather than silent.
 */
test('a day outside every table’s coverage is reported as uncovered', () => {
  assert.ok(isCovered(T_PLUS_1, '2026-06-15'));
  assert.ok(!isCovered(T_PLUS_1, '2027-06-15'), 'no 2027 table is loaded');
  // It is still treated as an ordinary business day: a guess in the safe direction, stated.
  assert.ok(isBusinessDay(T_PLUS_1, '2027-06-15'));
});

/**
 * The answer to "why was this due on Tuesday?" is the zone, the cut-off, and the named
 * editions that said Monday was not a business day. Returned so it can be stored beside the
 * conclusion rather than re-derived later against a table that has since been revised.
 */
test('a deadline can name the holiday editions that produced it', () => {
  const provenance = deadlineProvenance(T_PLUS_1, at('2026-09-30T09:00:00Z'));

  assert.equal(provenance.effectiveDay, '2026-09-30');
  assert.equal(provenance.dueDay, '2026-10-02', 'Independence Day was skipped');
  assert.deepEqual(provenance.editions, ['NG-2026@1']);
  assert.equal(provenance.fullyCovered, true);

  const uncovered = deadlineProvenance(T_PLUS_1, at('2027-06-15T09:00:00Z'));
  assert.equal(uncovered.fullyCovered, false, 'and it says so, rather than pretending');
});
