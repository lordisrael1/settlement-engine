import assert from 'node:assert/strict';
import { test } from 'node:test';

import { dedupe } from '../dedupe.js';
import { ingestSettlement, NoSettlementAdapterError } from './index.js';

const FLUTTERWAVE_SETTLEMENTS = JSON.stringify({
  status: 'success',
  message: 'Settlements fetched',
  data: [
    {
      id: 'stm_ngn_ok',
      gross_amount: 12000,
      net_amount: 11832,
      currency: 'NGN',
      status: 'completed',
      due_datetime: '2026-08-14T09:00:00.000Z',
      fees: [
        { type: 'stamp_duty', amount: 0 },
        { type: 'charge_fee', amount: 168 },
      ],
      charge_count: '3',
    },
    {
      id: 'stm_ngn_chargeback',
      gross_amount: 5000,
      net_amount: 4880,
      currency: 'NGN',
      status: 'completed',
      due_datetime: '2026-08-14T09:00:00.000Z',
      fees: [{ type: 'charge_fee', amount: 70 }],
      chargeback: 50,
      charge_count: '1',
    },
    {
      id: 'stm_usd',
      gross_amount: 150,
      net_amount: 150,
      currency: 'USD',
      status: 'completed',
      due_datetime: '2026-08-14T11:00:00.000Z',
      fees: [],
      charge_count: '1',
    },
  ],
});

const bytes = (json: string) => Buffer.from(json, 'utf8');

test('a settlement payload becomes canonical lines in integer kobo', () => {
  const result = ingestSettlement('flutterwave', bytes(FLUTTERWAVE_SETTLEMENTS));

  assert.equal(result.format, 'flutterwave-settlements-api-v4');
  assert.equal(result.lines.length, 2);

  const first = result.lines[0]!;
  assert.equal(first.reference, 'stm_ngn_ok');
  assert.equal(first.gross.kobo, 1_200_000n);
  assert.equal(first.fee.kobo, 16_800n);
  assert.equal(first.net.kobo, 1_183_200n);
  assert.equal(first.status, 'settled');
  assert.equal(first.idempotencyKey, 'settlement:flutterwave:settlement:stm_ngn_ok');
});

/**
 * `gross − fee == net` is the line's own internal consistency. A source whose numbers
 * disagree with themselves is not something to reconcile against, it is something to
 * reject at the boundary.
 */
test('every accepted line is internally consistent', () => {
  const { lines } = ingestSettlement('flutterwave', bytes(FLUTTERWAVE_SETTLEMENTS));
  for (const line of lines) {
    assert.equal(line.gross.kobo - line.fee.kobo, line.net.kobo, line.reference);
  }
});

test('a non-NGN row is refused rather than converted', () => {
  const { lines, rejected } = ingestSettlement('flutterwave', bytes(FLUTTERWAVE_SETTLEMENTS));

  assert.ok(!lines.some((line) => line.reference === 'stm_usd'));
  assert.ok(rejected.some((row) => row.kind === 'not-a-settlement' && row.reason.includes('USD')));
});

/**
 * A settlement whose fee quietly includes a clawback is the most misleading row in
 * reconciliation: the arithmetic balances, so nothing looks wrong. The adapter lifts it
 * into a hint so the reconciler can reach for CHARGEBACK instead of shrugging at a fee.
 */
test('a chargeback folded into the fee is surfaced as a hint', () => {
  const { lines } = ingestSettlement('flutterwave', bytes(FLUTTERWAVE_SETTLEMENTS));
  const line = lines.find((l) => l.reference === 'stm_ngn_chargeback');

  assert.ok(line);
  assert.ok(line.reasonHints.includes('deduction:chargeback'));
  assert.equal(line.fee.kobo, 12_000n, 'fee aggregates the charge fee and the clawback');
});

test('re-ingesting the same payload is a no-op', () => {
  const first = ingestSettlement('flutterwave', bytes(FLUTTERWAVE_SETTLEMENTS));
  const second = ingestSettlement('flutterwave', bytes(FLUTTERWAVE_SETTLEMENTS));

  const seen = new Set(first.lines.map((line) => line.idempotencyKey));
  const { fresh, duplicates } = dedupe(second.lines, seen);

  assert.equal(fresh.length, 0);
  assert.equal(duplicates.length, first.lines.length);
});

test('ingestion is deterministic — same bytes, same lines', () => {
  const a = ingestSettlement('flutterwave', bytes(FLUTTERWAVE_SETTLEMENTS));
  const b = ingestSettlement('flutterwave', bytes(FLUTTERWAVE_SETTLEMENTS));
  assert.deepEqual(
    a.lines.map((l) => [l.reference, l.gross.kobo, l.fee.kobo, l.net.kobo]),
    b.lines.map((l) => [l.reference, l.gross.kobo, l.fee.kobo, l.net.kobo]),
  );
});

test('a malformed payload is rejected as one bad row, not an exception', () => {
  const result = ingestSettlement('flutterwave', bytes('{ not json'));

  assert.equal(result.lines.length, 0);
  assert.equal(result.rejected.length, 1);
  assert.equal(result.rejected[0]!.kind, 'malformed');
});

test('a source without a fixture-verified export format says so plainly', () => {
  assert.throws(
    () => ingestSettlement('paystack', bytes('{}')),
    NoSettlementAdapterError,
  );
});

/**
 * Law 7, as a test. The two adapters read completely different foreign shapes — an
 * envelope with a data array, and a bare array of records — and produce values of one
 * type with one set of field names. Nothing downstream can tell them apart.
 */
test('different sources produce identically shaped lines', () => {
  const flutterwave = ingestSettlement('flutterwave', bytes(FLUTTERWAVE_SETTLEMENTS));
  const nomba = ingestSettlement('nomba', bytes('[]'));

  assert.deepEqual(Object.keys(flutterwave).sort(), Object.keys(nomba).sort());
  for (const line of flutterwave.lines) {
    assert.deepEqual(Object.keys(line).sort(), [
      'fee',
      'gross',
      'idempotencyKey',
      'net',
      'reasonHints',
      'reference',
      'settledAt',
      'source',
      'status',
    ]);
  }
});
