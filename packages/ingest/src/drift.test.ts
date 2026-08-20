import assert from 'node:assert/strict';
import { test } from 'node:test';

import { anomalyKey, anomalySeverity, isDegraded } from '@recon/canon';

import { ingestBankStatement } from './bank.js';
import { ingestSettlement } from './settlement/index.js';
import type { SettlementContext } from './settlement/types.js';

/**
 * Detecting that a foreign format has moved.
 *
 * Everything asserted here was already being *handled* correctly before any of it existed —
 * unread fields were ignored, unrecognised entry types were refused, malformed rows were
 * counted. What none of it did was leave a record, which meant the counters could describe a
 * bad file but never name a format change, and nothing accumulated across files.
 *
 * So these tests are mostly about a distinction rather than about parsing: the same file
 * yields the same rows as before, and additionally says which of its oddities were news.
 */

const CONTEXT: SettlementContext = {
  merchantId: 'merchant-under-test',
  filename: 'settlements.json',
  receivedFrom: 'test-suite',
  receivedAt: new Date('2026-08-15T10:00:00Z'),
};

const BANK_CONTEXT = {
  bankAccountId: 'gtb-0001',
  bank: 'gtbank',
  filename: 'statement.json',
  receivedFrom: 'test-suite',
  receivedAt: new Date('2026-08-15T10:00:00Z'),
};

const bytes = (value: unknown) => Buffer.from(JSON.stringify(value), 'utf8');

/** A Flutterwave settlements envelope, with whatever the caller wants inside its rows. */
const envelope = (rows: readonly unknown[]) =>
  bytes({ status: 'success', message: 'Settlements fetched', data: rows });

const PAYOUT = {
  id: 'stm_ngn_ok',
  gross_amount: 12000,
  net_amount: 11832,
  currency: 'NGN',
  status: 'completed',
  due_datetime: '2026-08-14T09:00:00.000Z',
  fees: [
    { type: 'stamp_duty', amount: 50 },
    { type: 'charge_fee', amount: 118 },
  ],
  charge_count: '3',
};

/**
 * The earliest warning available, and the only one that arrives while everything still works.
 *
 * A provider adding a field breaks nothing today: the row parses, the money is right, and the
 * old behaviour was to discard the key in silence. It is worth an entry in a queue precisely
 * *because* nothing is wrong yet — this is the notice that arrives with time to act on it,
 * months before the field starts carrying something that matters.
 */
test('a field nobody reads is reported, and the row still parses', () => {
  const result = ingestSettlement(
    'flutterwave',
    envelope([{ ...PAYOUT, settlement_fee: 25 }]),
    CONTEXT,
  );

  assert.equal(result.payouts.length, 1, 'the payout is unaffected');
  assert.equal(result.rejected.length, 0, 'and nothing was refused');

  const drift = result.anomalies.find((a) => a.kind === 'unknown_field');
  assert.ok(drift, 'the new field was noticed');
  assert.equal(drift.detail, '$.data[].settlement_fee');
  assert.equal(drift.firstSeenAt.path, '$.data[0]', 'and somebody can go and look at it');
});

/**
 * The connectors cannot raise this themselves, and that is a structural fact rather than an
 * oversight: their schemas end in `.passthrough()`, which is right for a normalisation library
 * — refusing a row because it grew a field would break every host on the provider's schedule —
 * and is also exactly "accept what you do not understand and say nothing".
 */
test('unknown fields are found inside a nested envelope, not just at the top', () => {
  const result = ingestSettlement(
    'monnify',
    bytes([
      {
        requestSuccessful: true,
        responseBody: {
          transactionReference: 'MNFY-1',
          amountPaid: '5000.00',
          settlementAmount: '4950.00',
          paymentStatus: 'PAID',
          currency: 'NGN',
          paidOn: '2026-08-14T09:00:00.000Z',
          reserveHeld: '50.00',
        },
      },
    ]),
    CONTEXT,
  );

  const paths = result.anomalies
    .filter((a) => a.kind === 'unknown_field')
    .map((a) => a.detail);
  assert.deepEqual(paths, ['$[].responseBody.reserveHeld']);
});

/**
 * A vocabulary moving, as opposed to a broken row.
 *
 * On a bank statement there is no connector in between to normalise anything, so `type` is
 * whatever the converter put there. `DR`/`CR` instead of `debit`/`credit` produces rows that
 * are individually "malformed" and collectively a format change, and the old counters could
 * only ever report the first reading.
 */
test('an entry type nobody recognises is drift, not merely a bad row', () => {
  const result = ingestBankStatement(
    bytes([
      { id: 'GTB-1', date: '2026-08-14T11:20:00Z', amount: '11832.00', type: 'CR', narration: 'X' },
      { id: 'GTB-2', date: '2026-08-14T11:22:00Z', amount: '3500.00', type: 'CR', narration: 'Y' },
    ]),
    BANK_CONTEXT,
  );

  assert.equal(result.lines.length, 0);
  assert.equal(result.rejected.length, 2, 'both rows are still refused, as before');

  const drift = result.anomalies.find((a) => a.kind === 'unknown_value');
  assert.ok(drift);
  assert.equal(drift.detail, 'type=CR');
  assert.equal(drift.occurrences, 2);
  assert.equal(drift.rowsInFile, 2);
});

/**
 * The ratio is what separates a slip from an incident, and it is the reason the denominator
 * counts rejected rows rather than surviving ones. Measuring the share of rows that *parsed*
 * would report a file where everything failed as perfectly healthy.
 */
test('a wholesale change outranks the same drift affecting a few rows', () => {
  const wholesale = ingestBankStatement(
    bytes([
      { id: 'A', date: '2026-08-14T11:20:00Z', amount: '100.00', type: 'CR' },
      { id: 'B', date: '2026-08-14T11:21:00Z', amount: '100.00', type: 'CR' },
    ]),
    BANK_CONTEXT,
  ).anomalies.find((a) => a.kind === 'unknown_value');

  const isolated = ingestBankStatement(
    bytes([
      { id: 'A', date: '2026-08-14T11:20:00Z', amount: '100.00', type: 'credit' },
      { id: 'B', date: '2026-08-14T11:21:00Z', amount: '100.00', type: 'credit' },
      { id: 'C', date: '2026-08-14T11:22:00Z', amount: '100.00', type: 'credit' },
      { id: 'D', date: '2026-08-14T11:23:00Z', amount: '100.00', type: 'CR' },
    ]),
    BANK_CONTEXT,
  ).anomalies.find((a) => a.kind === 'unknown_value');

  assert.ok(wholesale);
  assert.ok(isolated);
  assert.equal(wholesale.detail, isolated.detail, 'the same drift, so the same key');
  assert.ok(
    anomalySeverity(wholesale) > anomalySeverity(isolated),
    'but every row is a different situation from one row',
  );
  assert.equal(isDegraded([wholesale]), true);
  assert.equal(isDegraded([isolated]), false, 'one odd row must not cry wolf');
});

/**
 * The identity that makes this a queue rather than a log.
 *
 * The same drift in two files has to produce one key, or the table grows by the number of
 * uploads rather than by the number of things wrong — which for an hourly cron is the
 * difference between something people read and something people mute.
 */
test('the same drift in two different files derives the same key', () => {
  const monday = ingestSettlement(
    'flutterwave',
    envelope([{ ...PAYOUT, id: 'stm_monday', settlement_fee: 25 }]),
    CONTEXT,
  );
  const tuesday = ingestSettlement(
    'flutterwave',
    envelope([
      { ...PAYOUT, id: 'stm_tuesday_a', settlement_fee: 30 },
      { ...PAYOUT, id: 'stm_tuesday_b', settlement_fee: 40 },
    ]),
    { ...CONTEXT, receivedAt: new Date('2026-08-16T10:00:00Z') },
  );

  const first = monday.anomalies.find((a) => a.kind === 'unknown_field');
  const second = tuesday.anomalies.find((a) => a.kind === 'unknown_field');

  assert.ok(first);
  assert.ok(second);
  assert.equal(first.key, second.key);
  assert.equal(first.key, anomalyKey('flutterwave', 'unknown_field', '$.data[].settlement_fee'));
  assert.notEqual(first.evidenceId, second.evidenceId, 'two files, one problem');
});

/**
 * A new deduction type is booked correctly and is still news.
 *
 * The existing handling is right and is unchanged: the money is real, so it books as a fee and
 * keeps its own label rather than being dropped. But booking it is not understanding it — an
 * unrecognised deduction absorbed into `fee` forever is a permanent overstatement of what this
 * source charges, surfacing as a fee variance nobody can trace to the day it started.
 */
test('an unrecognised deduction still books as a fee, and is also reported', () => {
  const result = ingestSettlement(
    'flutterwave',
    // The deductions must still add up to gross - net: the connector refuses a row whose own
    // money fields disagree, so a fixture that did not balance would never reach the mapping
    // this test is about.
    envelope([{ ...PAYOUT, fees: [{ type: 'cross_border_levy', amount: 168 }] }]),
    CONTEXT,
  );

  const payout = result.payouts[0]!;
  assert.deepEqual(
    payout.adjustments.map((a) => [a.kind, a.amount.kobo, a.narration]),
    [['fee', 16_800n, 'cross_border_levy']],
    'losing money quietly is worse than filing it imprecisely',
  );

  const drift = result.anomalies.find((a) => a.detail === 'fees[].type=cross_border_levy');
  assert.ok(drift, 'and the label that was kept is also a thing somebody should look at');
});

/**
 * The container moving is the loudest failure available, and the one most likely to be
 * mistaken for a quiet day: a parser handed an envelope whose row array has been renamed finds
 * no rows and reports an empty file, which is indistinguishable from a day on which nothing
 * settled.
 */
test('a renamed row container is reported as shape drift, not as an empty file', () => {
  const result = ingestSettlement(
    'flutterwave',
    bytes({ status: 'success', settlements: [PAYOUT] }),
    CONTEXT,
  );

  assert.equal(result.payouts.length, 0);

  const drift = result.anomalies.find((a) => a.kind === 'unknown_shape');
  assert.ok(drift, 'an empty result and a moved container must not look alike');
  assert.equal(drift.detail, 'no $.data array');
  assert.equal(isDegraded(result.anomalies), true);
});

/**
 * The other half of the contract, and the one that keeps the queue readable: a file that
 * matches the format produces nothing at all. An alerting mechanism that fires on ordinary
 * days is one people turn off.
 */
test('a file that matches the format reports no drift whatsoever', () => {
  const result = ingestSettlement('flutterwave', envelope([PAYOUT]), CONTEXT);

  assert.equal(result.payouts.length, 1);
  assert.deepEqual(result.anomalies, []);
  assert.equal(isDegraded(result.anomalies), false);
});

/**
 * Ordinary refusals are not drift.
 *
 * A USD row is a currency we knowingly do not keep books in and a pending row is money that
 * has not moved yet; both arrive constantly and both are correctly refused. Reporting either
 * as a format change would bury the entries that mean something.
 */
test('rows refused for reasons we understand are not reported as drift', () => {
  const result = ingestSettlement(
    'flutterwave',
    envelope([
      { ...PAYOUT, id: 'stm_usd', currency: 'USD', gross_amount: 150, net_amount: 150, fees: [] },
    ]),
    CONTEXT,
  );

  assert.equal(result.rejected.length, 1, 'still refused');
  assert.equal(result.rejected[0]!.kind, 'not-a-settlement');
  assert.deepEqual(
    result.anomalies.filter((a) => a.kind === 'unknown_value'),
    [],
    'a currency we decline is a decision, not a surprise',
  );
});
