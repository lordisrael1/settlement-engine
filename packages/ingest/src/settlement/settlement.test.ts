import assert from 'node:assert/strict';
import { test } from 'node:test';

import { payoutArithmetic } from '@recon/canon';

import { ingestBankStatement } from '../bank.js';
import { dedupe } from '../dedupe.js';
import { ingestSettlement, NoSettlementAdapterError } from './index.js';
import type { SettlementContext } from './types.js';

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
        { type: 'stamp_duty', amount: 50 },
        { type: 'charge_fee', amount: 118 },
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

const CONTEXT: SettlementContext = {
  merchantId: 'merchant-under-test',
  filename: 'settlements.json',
  receivedFrom: 'test-suite',
  receivedAt: new Date('2026-08-15T10:00:00Z'),
};

const bytes = (json: string) => Buffer.from(json, 'utf8');
const flutterwave = () => ingestSettlement('flutterwave', bytes(FLUTTERWAVE_SETTLEMENTS), CONTEXT);

/**
 * Flutterwave reports payouts, not transactions: each record is one money movement
 * covering several charges it does not enumerate. Recognising that is what lets the
 * matcher attach payments to a movement the PSP has already named, instead of inferring
 * the grouping from arithmetic alone.
 */
test('a settlement payload becomes canonical payouts in integer kobo', () => {
  const result = flutterwave();

  assert.equal(result.format, 'flutterwave-settlements-api-v4');
  assert.equal(result.payouts.length, 2);
  assert.equal(result.lines.length, 0, 'this source names movements, not charges');

  const first = result.payouts[0]!;
  assert.equal(first.payoutReference, 'stm_ngn_ok');
  assert.equal(first.gross.kobo, 1_200_000n);
  assert.equal(first.expectedNet.kobo, 1_183_200n);
  assert.equal(first.status, 'reported', 'a report is a claim, never cash');
  assert.equal(first.idempotencyKey, 'payout:flutterwave:settlement:stm_ngn_ok');
});

/**
 * The heart of the deductions ADR. A ₦168 shortfall is not "the fee"; it is a ₦118 fee and
 * a ₦50 stamp duty, and those book to different accounts and mean different things. One
 * goes to the PSP, the other to the government.
 */
test('deductions are named and split by kind, not summed into a fee', () => {
  const payout = flutterwave().payouts[0]!;

  assert.deepEqual(
    payout.adjustments.map((a) => [a.kind, a.amount.kobo]),
    [
      ['tax', 5_000n],
      ['fee', 11_800n],
    ],
  );
});

/**
 * A settlement whose fee quietly includes a clawback is the most misleading row in
 * reconciliation: the arithmetic balances, so nothing looks wrong. Lifting it out as a
 * typed adjustment means it books to `chargebacks` and reaches a human as a chargeback,
 * rather than disappearing into an unusually expensive fee.
 */
test('a chargeback folded into a payout is lifted out as its own deduction', () => {
  const payout = flutterwave().payouts.find((p) => p.payoutReference === 'stm_ngn_chargeback');

  assert.ok(payout);
  assert.deepEqual(
    payout.adjustments.map((a) => [a.kind, a.amount.kobo]),
    [
      ['fee', 7_000n],
      ['chargeback', 5_000n],
    ],
  );
});

/**
 * Does the PSP's own report add up? `expectedNet` is taken verbatim rather than
 * recomputed, precisely so this question can be asked — a payout whose declared net does
 * not equal its gross less its own itemised deductions has something in it nobody has
 * told us about.
 */
test('a payout is checked against its own arithmetic', () => {
  for (const payout of flutterwave().payouts) {
    const arithmetic = payoutArithmetic(payout);
    assert.ok(arithmetic.consistent, `${payout.payoutReference}: ${arithmetic.unexplained.kobo}`);
  }
});

test('a non-NGN row is refused rather than converted', () => {
  const { payouts, rejected } = flutterwave();

  assert.ok(!payouts.some((payout) => payout.payoutReference === 'stm_usd'));
  assert.ok(rejected.some((row) => row.kind === 'not-a-settlement' && row.reason.includes('USD')));
});

/**
 * Evidence, as a test. Every record carries the SHA-256 of the file it came from and the
 * version of the parser that read it, so a conclusion drawn six months ago can be traced
 * to bytes and to the code that interpreted them.
 */
test('every record is traceable to the bytes it came from', () => {
  const result = flutterwave();

  assert.equal(result.evidence.evidenceId.length, 64);
  assert.equal(result.evidence.kind, 'psp_settlement');
  assert.equal(result.evidence.parserVersion, 'flutterwave-settlements/2');
  assert.equal(result.evidence.receivedFrom, 'test-suite');
  for (const payout of result.payouts) {
    assert.equal(payout.evidenceId, result.evidence.evidenceId);
  }
});

test('the same bytes always hash to the same evidence id', () => {
  assert.equal(flutterwave().evidence.evidenceId, flutterwave().evidence.evidenceId);
});

test('re-ingesting the same payload is a no-op', () => {
  const first = flutterwave();
  const second = flutterwave();

  const seen = new Set(first.payouts.map((payout) => payout.idempotencyKey));
  const { fresh, duplicates } = dedupe(second.payouts, seen);

  assert.equal(fresh.length, 0);
  assert.equal(duplicates.length, first.payouts.length);
});

test('ingestion is deterministic — same bytes, same records', () => {
  assert.deepEqual(flutterwave().payouts, flutterwave().payouts);
});

test('a malformed payload is rejected as one bad row, not an exception', () => {
  const result = ingestSettlement('flutterwave', bytes('{ not json'), CONTEXT);

  assert.equal(result.payouts.length, 0);
  assert.equal(result.rejected.length, 1);
  assert.equal(result.rejected[0]!.kind, 'malformed');
});

test('a source without a fixture-verified export format says so plainly', () => {
  assert.throws(() => ingestSettlement('paystack', bytes('{}'), CONTEXT), NoSettlementAdapterError);
});

/**
 * Law 7, as a test. The two adapters read completely different foreign shapes — an
 * envelope of payouts, and a bare array of transactions — and produce values of one type
 * with one set of field names. Nothing downstream can tell them apart.
 */
test('different sources produce identically shaped results', () => {
  const a = flutterwave();
  const b = ingestSettlement('nomba', bytes('[]'), CONTEXT);

  assert.deepEqual(Object.keys(a).sort(), Object.keys(b).sort());
});

// ── The bank half ───────────────────────────────────────────────────────────

const STATEMENT = JSON.stringify([
  {
    id: 'BNK-9001',
    date: '2026-08-15T09:00:00Z',
    amount: '11832.00',
    type: 'credit',
    narration: 'FLW SETTLEMENT stm_ngn_ok /REF 8891',
    balance: '250000.00',
  },
  {
    id: 'BNK-9002',
    date: '2026-08-15T09:05:00Z',
    amount: '1200.50',
    type: 'debit',
    narration: 'COMMISSION ON TURNOVER',
  },
  { id: '', date: '2026-08-15T09:06:00Z', amount: '10.00', type: 'credit', narration: 'x' },
]);

const bankStatement = () =>
  ingestBankStatement(bytes(STATEMENT), {
    bankAccountId: 'gtb-0001',
    bank: 'gtbank',
    filename: 'statement.json',
    receivedFrom: 'test-suite',
    receivedAt: new Date('2026-08-15T10:00:00Z'),
  });

test('a bank statement becomes canonical lines in integer kobo', () => {
  const result = bankStatement();

  assert.equal(result.lines.length, 2);
  const credit = result.lines[0]!;
  assert.equal(credit.amount.kobo, 1_183_200n);
  assert.equal(credit.direction, 'credit');
  assert.equal(credit.balanceAfter?.kobo, 25_000_000n);
  assert.equal(credit.idempotencyKey, 'bank:gtbank:BNK-9001');
});

/**
 * A debit is kept, not filtered. A returned payout and a chargeback both arrive as debits,
 * and dropping them would make the two most alarming bank events invisible.
 */
test('debits are kept rather than filtered out', () => {
  const debit = bankStatement().lines.find((line) => line.direction === 'debit');
  assert.ok(debit);
  assert.equal(debit.amount.kobo, 120_050n);
});

/**
 * The parser extracts candidates and stops. Deciding that one of them names a particular
 * payout is the matcher's job, done against payouts we actually hold — a parser that
 * picked one would be guessing invisibly.
 */
test('narration is tokenised into candidates, never resolved to a reference', () => {
  const credit = bankStatement().lines[0]!;

  assert.equal(credit.statedReference, null, 'the bank supplied no structured reference');
  assert.deepEqual(credit.narrationTokens, ['SETTLEMENT', 'STM_NGN_OK']);
  // `FLW` and `REF` are below the threshold: short runs are words, and matching on them
  // would attach unrelated payouts to each other by coincidence.
  assert.ok(!credit.narrationTokens.includes('FLW'));
  // The verbatim narration survives regardless, as evidence for a human.
  assert.ok(credit.narration.includes('stm_ngn_ok'));
});

test('a row with no bank transaction id is rejected, not invented', () => {
  const { rejected } = bankStatement();
  assert.equal(rejected.length, 1);
  assert.match(rejected[0]!.reason, /no bank transaction id/);
});
