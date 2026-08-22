import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ingestBankStatement } from './bank.js';

/**
 * The two clauses of the bank identity contract, checked here because nothing else can check
 * them.
 *
 * The conversion from a bank's own export into this shape lives outside the repository by
 * design (ADR-0057): every Nigerian bank exports a different CSV and the per-bank knowledge
 * belongs where it is maintained. What that leaves is a hand-off with two requirements — a
 * per-row id that is unique within the account, and a date that is ISO-8601 — sitting
 * directly on top of the only evidence in the system that can book cash.
 *
 * Both used to be assumptions. A violation of the first dropped a real credit as though it
 * were a redelivery; a violation of the second moved a credit a month without an error
 * (ADR-0068).
 */

const CONTEXT = {
  bankAccountId: 'gtb-3011',
  bank: 'gtbank',
  filename: 'statement.json',
  receivedFrom: 'test',
  receivedAt: new Date('2026-08-20T00:00:00Z'),
};

const ingest = (rows: unknown) =>
  ingestBankStatement(Buffer.from(JSON.stringify(rows), 'utf8'), CONTEXT);

const row = (over: Record<string, unknown> = {}) => ({
  id: 'GTB-1',
  date: '2026-08-14T11:20:00Z',
  amount: '11832.00',
  type: 'credit',
  narration: 'TRF FROM ALPHA',
  balance: '11832.00',
  ...over,
});

test('a well-formed statement parses', () => {
  const result = ingest([row(), row({ id: 'GTB-2', amount: '500.00', balance: '12332.00' })]);

  assert.equal(result.lines.length, 2);
  assert.equal(result.rejected.length, 0);
  assert.equal(result.lines[0]!.amount.kobo, 1_183_200n);
  assert.equal(result.lines[0]!.valueDate.toISOString(), '2026-08-14T11:20:00.000Z');
});

// ── Identity ────────────────────────────────────────────────────────────────

/**
 * The failure this exists for, in the shape it actually takes.
 *
 * A converter with no per-row id from the bank synthesises one, and the obvious synthesis is
 * a hash of date, amount and narration. Two customers pay the same ₦5,000 subscription with
 * the same generic narration on the same day, and it produces one id for two credits. The
 * database's `ON CONFLICT DO NOTHING` cannot tell that from a redelivery, so one credit
 * disappears and the payout it should have confirmed escalates days later as a missing
 * settlement — while the cash sits in the account, invisible.
 */
test('two rows claiming one id: the second is refused, not silently dropped', () => {
  const result = ingest([
    row({ id: 'HASH-COLLIDES', amount: '5000.00', narration: 'NIP TRF' }),
    row({ id: 'HASH-COLLIDES', amount: '5000.00', narration: 'NIP TRF' }),
  ]);

  assert.equal(result.lines.length, 1, 'only the first row may be stored');
  assert.equal(result.rejected.length, 1);

  // Not `malformed`. Nothing about the row is malformed — it parses, the money is real, and
  // the converter's id scheme is what is broken.
  assert.equal(result.rejected[0]!.kind, 'colliding-identity');
  assert.match(result.rejected[0]!.reason, /unique within the account/);
  assert.match(result.rejected[0]!.reason, /running balance|sequence/);
});

/**
 * …and it reaches the drift queue, keyed by the *format* rather than by the colliding id.
 *
 * A converter with a broken scheme produces a class of collisions, not one. Keying on the id
 * would make forty collisions forty queue entries with forty histories, which is a log rather
 * than a queue — the same reasoning `malformedRow` uses.
 */
test('a collision is drift about the converter, counted once for the file', () => {
  const result = ingest([
    row({ id: 'DUP' }),
    row({ id: 'DUP' }),
    row({ id: 'DUP' }),
    row({ id: 'FINE' }),
  ]);

  const collisions = result.anomalies.filter((a) => a.kind === 'colliding_identity');
  assert.equal(collisions.length, 1, 'one anomaly, not one per row');
  assert.equal(collisions[0]!.occurrences, 2);
  assert.equal(collisions[0]!.rowsInFile, 4);
});

// ── Dates ───────────────────────────────────────────────────────────────────

/**
 * The landmine. `new Date("02/01/2026")` is the 1st of February in every JavaScript engine,
 * and a Nigerian export written DD/MM means the 2nd of January — a month of drift, into the
 * window that decides whether a credit can match a payout at all.
 */
test('an ambiguous date is refused rather than guessed at', () => {
  for (const date of ['02/01/2026', '2 Jan 2026', '20260102', 'Jan 2, 2026', '']) {
    const result = ingest([row({ date })]);
    assert.equal(result.lines.length, 0, `"${date}" must not parse`);
    assert.equal(result.rejected.length, 1);
    assert.match(result.rejected[0]!.reason, /ISO-8601/);
  }
});

test('a date the calendar does not have is refused, not rolled forward', () => {
  // `new Date("2026-02-31")` is the 3rd of March. A date that does not exist is a converter
  // bug, and a March credit is not the right answer to it.
  const result = ingest([row({ date: '2026-02-31' })]);
  assert.equal(result.lines.length, 0);
  assert.match(result.rejected[0]!.reason, /ISO-8601/);
});

/** A bare date is midnight **UTC**, explicitly — not the engine's local midnight. */
test('a bare ISO date is anchored to UTC', () => {
  const result = ingest([row({ date: '2026-08-14' })]);
  assert.equal(result.lines.length, 1);
  assert.equal(result.lines[0]!.valueDate.toISOString(), '2026-08-14T00:00:00.000Z');
});

/**
 * A date column whose format changed is a statement about the *file*, not about one row —
 * so it lands as drift on the `date` field, and a wholesale change is one queue entry rather
 * than five thousand rejected rows nobody reads.
 */
test('a changed date format is reported as drift, not only as rejected rows', () => {
  const result = ingest([row({ date: '14/08/2026' }), row({ id: 'GTB-2', date: '15/08/2026' })]);

  const drift = result.anomalies.filter((a) => a.kind === 'unknown_value');
  assert.equal(drift.length, 1, 'one anomaly for the column, not one per row');
  // Keyed by the *shape*, because every row carries a different date and keying on the value
  // would turn a five-thousand-row file into five thousand queue entries.
  assert.match(drift[0]!.detail, /^date=D\/M\/Y or M\/D\/Y/);
  assert.equal(drift[0]!.occurrences, 2);
});
