import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { BusinessCalendar } from './calendar.js';
import { effectiveBusinessDay, isOverdue, settlementDeadline } from './calendar.js';

/**
 * T+1 is a business rule, not twenty-four hours. These tests are the difference between an
 * exception queue somebody reads and one they learn to ignore.
 */

/** 5pm WAT cut-off, T+1, weekends off, one public holiday, a day of grace. */
const T_PLUS_1: BusinessCalendar = {
  cutOffMinutesUtc: 16 * 60,
  settlementBusinessDays: 1,
  weekend: [0, 6],
  holidays: ['2026-10-01'], // Independence Day, a Thursday
  graceMinutes: 24 * 60,
};

const at = (iso: string) => new Date(iso);

test('a payment before the cut-off settles the next business day', () => {
  // Tuesday 14:00 UTC (15:00 WAT) — inside the cut-off.
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
  // Friday 2026-09-11, 17:00 UTC — after the cut-off.
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
  assert.equal(
    effectiveBusinessDay(T_PLUS_1, at('2026-09-12T09:00:00Z')).toISOString(),
    '2026-09-14T00:00:00.000Z',
  );
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
