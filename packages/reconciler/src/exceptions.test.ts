import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';

import type { Pool } from 'pg';

import { localKeyRing, parseLocalKey } from '@recon/protect';

import type {
  BankStatementLine,
  BusinessCalendar,
  Evidence,
  Money,
  Payout,
  SettlementAdjustment,
} from '@recon/canon';
import { ANY_CHANNEL, exceptionKey, feeFor, money, NO_LINEAGE, DEFAULT_RETENTION } from '@recon/canon';
import {
  bookAuthorizedPayment,
  createPool,
  currentState,
  getTransaction,
  LEDGER_MIGRATIONS_DIR,
  runMigrations,
  verifyBalances,
  verifyConservation,
} from '@recon/ledger-core';

import {
  acknowledge,
  exceptionAt,
  exceptionHistory,
  openExceptions,
  resolveByHuman,
} from './exceptions.js';
import type { PolicyLookup } from './policy.js';
import { reconcile } from './run.js';
import {
  recordBankLines,
  recordPayouts,
  recordResolution,
  RECONCILER_MIGRATIONS_DIR,
} from './store.js';

import { recordEvidence, type EvidenceVault } from './evidence.js';

/**
 * A key ring for the suite. Evidence is encrypted on the way in with no unencrypted path
 * (ADR-0063), so a test that stores a document needs one exactly as a deployment does.
 */
const VAULT: EvidenceVault = {
  keyRing: localKeyRing([parseLocalKey(`test:${Buffer.alloc(32, 1).toString('base64')}`)], 'test'),
  retention: DEFAULT_RETENTION,
};

/**
 * The queue, against a real Postgres — because what is being asserted is that the *derived*
 * view agrees with the appended events, and a mock of a view is a mock of the thing under
 * test.
 *
 *   docker compose up -d postgres
 *   DATABASE_URL=postgres://recon:recon@localhost:5432/recon npm test
 */
const DATABASE_URL = process.env['DATABASE_URL'];

const PAID_AT = new Date('2026-08-12T09:00:00Z');
const VALUE_DATE = new Date('2026-08-13T09:00:00Z');
const ASOF = new Date('2026-08-13T12:00:00Z');
/** Well past the deadline and its grace, so anything unmatched has escalated. */
const LATER = new Date('2026-08-25T12:00:00Z');

const CALENDAR: BusinessCalendar = {
  timeZone: 'Africa/Lagos',
  cutOffMinutes: 17 * 60,
  settlementBusinessDays: 1,
  weekend: [0, 6],
  holidayCalendars: [],
  graceMinutes: 24 * 60,
};

const CARD = {
  percentBasisPoints: 150,
  flatKobo: 0n,
  flatWaivedBelowKobo: null,
  capKobo: null,
  vatBasisPoints: 750,
};

const CARD_CONTRACT = {
  contractId: 'test-contract',
  channel: ANY_CHANNEL,
  effectiveFrom: new Date(0),
} as const;

describe('the exception queue', { skip: DATABASE_URL ? false : 'set DATABASE_URL to run' }, () => {
  let pool: Pool;

  before(async () => {
    const schema = `queue_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
    const bootstrap = createPool(DATABASE_URL);
    await bootstrap.query(`CREATE SCHEMA ${schema}`);
    await bootstrap.end();

    const url = new URL(DATABASE_URL!);
    url.searchParams.set('options', `-c search_path=${schema}`);
    pool = createPool(url.toString());

    await runMigrations(pool, [LEDGER_MIGRATIONS_DIR, RECONCILER_MIGRATIONS_DIR]);
  });

  after(async () => {
    await pool.end();
  });

  const scenario = () => {
    const run = randomUUID().slice(0, 8);
    const source = `src-${run}`;
    return {
      source,
      id: (name: string) => `${run}-${name}`,
      policy: ((asked) =>
        asked === source
          ? {
              calendar: CALENDAR,
              expectedFee: (gross: Money) => feeFor(CARD, gross, CARD_CONTRACT),
              bankChargeAllowance: 10_000n,
            }
          : null) satisfies PolicyLookup,
    };
  };

  const evidence = (id: string, kind: Evidence['kind'], source: string): Evidence => ({
    evidenceId: id,
    kind,
    source,
    filename: `${kind}.json`,
    byteLength: 12,
    storageLocation: null,
    receivedFrom: 'test-suite',
    receivedAt: ASOF,
    parserVersion: 'test/1',
  });

  const promise = (source: string, id: string, gross: bigint) =>
    bookAuthorizedPayment(
      pool,
      {
        reference: id,
        source,
        gross: money(gross),
        status: 'SUCCESSFUL',
        channel: 'card',
        occurredAt: PAID_AT,
        idempotencyKey: id,
      },
      PAID_AT,
    );

  const payout = (
    source: string,
    reference: string,
    gross: bigint,
    adjustments: readonly SettlementAdjustment[],
    evidenceId: string,
  ): Payout => {
    const deducted = adjustments.reduce((total, a) => total + a.amount.kobo, 0n);
    return {
      payoutReference: reference,
      source,
      status: 'reported',
      gross: money(gross),
      expectedNet: money(gross - deducted),
      adjustments,
      reportedAt: VALUE_DATE,
      valueDate: VALUE_DATE,
      evidenceId,
      lineage: NO_LINEAGE,
      idempotencyKey: `payout:${source}:${reference}`,
    };
  };

  const deduction = (kind: SettlementAdjustment['kind'], kobo: bigint): SettlementAdjustment => ({
    kind,
    amount: money(kobo),
    narration: kind,
  });

  const statementLine = (
    key: string,
    amount: bigint,
    narration: string,
    evidenceId: string,
    direction: 'credit' | 'debit' = 'credit',
    valueDate = VALUE_DATE,
  ): BankStatementLine => ({
    reference: key,
    bankAccountId: 'gtb-0001',
    direction,
    amount: money(amount),
    balanceAfter: null,
    valueDate,
    narration,
    narrationTokens: narration.toUpperCase().match(/[A-Z0-9][A-Z0-9_-]{5,}/g) ?? [],
    statedReference: null,
    evidenceId,
    lineage: NO_LINEAGE,
    idempotencyKey: key,
  });

  const queueFor = async (subjectId: string) =>
    (await openExceptions(pool, { limit: 5000 })).filter(
      (item) => item.subjectId === subjectId,
    );

  // ── The queue lifecycle ───────────────────────────────────────────────────

  /**
   * The whole lifecycle in one test. A straggler sits inside its window and troubles
   * nobody; past the window it escalates; and when the file finally arrives it clears
   * itself with no human involved.
   */
  test('a straggler waits, escalates, then clears itself when the evidence arrives', async () => {
    const { source, id, policy } = scenario();
    await promise(source, id('pay-1'), 700_000n);

    // Inside the window: pending, not an exception.
    const early = await reconcile(pool, { asOf: ASOF, policyFor: policy, limit: 50_000 });
    assert.equal(early.deferred[0]?.reason, 'PENDING_T_PLUS_N');
    assert.deepEqual(await queueFor(id('pay-1')), []);

    // Past the window and its grace: escalated, and the ledger says so too.
    const late = await reconcile(pool, { asOf: LATER, policyFor: policy, limit: 50_000 });
    assert.equal(late.queue.raised, 1);
    assert.equal(await currentState(pool, id('pay-1')), 'exception');

    const [raised] = await queueFor(id('pay-1'));
    assert.equal(raised?.reason, 'MISSING_SETTLEMENT');
    assert.equal(raised?.state, 'open');

    // A second run finds the same problem and must not report it twice.
    const again = await reconcile(pool, { asOf: LATER, policyFor: policy, limit: 50_000 });
    assert.equal(again.queue.raised, 0);
    assert.equal(again.queue.unchanged, 1);
    assert.equal((await queueFor(id('pay-1'))).length, 1, 'one problem, not one per run');

    // The settlement file turns up. Nobody is woken; the question simply stops being asked.
    await recordEvidence(pool, evidence(id('ev'), 'psp_settlement', source), null, VAULT);
    await recordPayouts(pool, [
      payout(source, id('PO-late'), 700_000n, [deduction('fee', 10_500n)], id('ev')),
    ]);

    const cleared = await reconcile(pool, { asOf: LATER, policyFor: policy, limit: 50_000 });
    assert.ok(cleared.queue.cleared >= 1);
    assert.deepEqual(await queueFor(id('pay-1')), [], 'the queue emptied itself');

    const history = await exceptionHistory(
      pool,
      exceptionKey('transaction', id('pay-1'), 'MISSING_SETTLEMENT'),
    );
    assert.deepEqual(
      history.map((entry) => [entry.from, entry.to, entry.cause]),
      [
        [null, 'open', null],
        ['open', 'resolved', 'evidence_arrived'],
      ],
      'the whole life of the exception, appended and intact',
    );
  });

  /**
   * A phantom credit reaches a human immediately with the working attached: the candidate
   * explanations the matcher considered and rejected. Without them the entry is a mystery;
   * with them it is a decision.
   */
  test('a phantom credit is queued at once, carrying what the matcher rejected', async () => {
    const { source, id, policy } = scenario();
    await promise(source, id('pay-1'), 500_000n);

    await recordEvidence(pool, evidence(id('ev'), 'psp_settlement', source), null, VAULT);
    await recordPayouts(pool, [
      payout(source, id('PO-phantom'), 999_999n, [], id('ev')),
    ]);

    const run = await reconcile(pool, { asOf: ASOF, policyFor: policy, limit: 50_000 });
    assert.equal(run.queue.raised, 1);

    const [item] = await queueFor(id('PO-phantom'));
    assert.equal(item?.reason, 'PHANTOM_CREDIT');
    assert.equal(item?.state, 'open');
    assert.deepEqual(
      item?.considered.map((candidate) => [candidate.candidateId, candidate.rejectedBecause]),
      [[id('pay-1'), 'amount_differs']],
    );
    // …and by how much, so nobody has to subtract two numbers out of two other screens.
    assert.equal(item?.considered[0]?.difference?.kobo, -499_999n);
  });

  // ── The human half ────────────────────────────────────────────────────────

  /**
   * Ownership is not resolution. Acknowledging says the item is no longer *unowned*, which
   * is the difference between a queue two people are both working and one nobody is.
   */
  test('a human takes an item, then answers it with a resolution', async () => {
    const { source, id, policy } = scenario();
    await recordEvidence(pool, evidence(id('ev'), 'bank_statement', source), null, VAULT);
    await recordBankLines(pool, [
      statementLine(id('bank-stray'), 424_242n, 'MISC INBOUND', id('ev')),
    ]);

    await reconcile(pool, { asOf: ASOF, policyFor: policy, limit: 50_000 });
    const key = exceptionKey('bank_credit', id('bank-stray'), 'UNIDENTIFIED_CREDIT');
    assert.equal((await exceptionAt(pool, key))?.state, 'open');

    assert.equal(await acknowledge(pool, key, 'ops.amaka@example.com', ASOF), true);
    const owned = await exceptionAt(pool, key);
    assert.equal(owned?.state, 'acknowledged');
    assert.equal(owned?.acknowledgedBy, 'ops.amaka@example.com');
    // Still unexplained. Owning a problem is not solving it.
    assert.equal(owned?.reason, 'UNIDENTIFIED_CREDIT');

    // The answer is a resolution, with its own approver and its own audit trail.
    await recordResolution(pool, {
      resolutionKey: id('res-stray'),
      subject: 'bank_credit',
      subjectId: id('bank-stray'),
      action: 'confirmed_fraud',
      reason: 'Traced to a mistaken inbound transfer; the sender has been asked to reclaim.',
      amount: money(424_242n),
      resolvedBy: 'ops.amaka@example.com',
      resolvedAt: ASOF,
      evidenceId: id('ev'),
      approvedBy: 'controller.tunde@example.com',
      approvedAt: ASOF,
    });
    assert.equal(
      await resolveByHuman(pool, key, 'ops.amaka@example.com', id('res-stray'), ASOF),
      true,
    );

    const answered = await exceptionAt(pool, key);
    assert.equal(answered?.state, 'resolved');
    assert.equal(answered?.resolvedCause, 'resolved_by_human');
    assert.equal(answered?.resolutionKey, id('res-stray'));
    // And it points at the decision that closed it. An exception that closed with no
    // reference to why is the silent disappearance this whole system exists to prevent.
    assert.deepEqual(await queueFor(id('bank-stray')), []);
  });

  /** Append-only, reaching the judgements: nothing in the trail may be edited or deleted. */
  test('the exception trail is append-only', async () => {
    const { source, id, policy } = scenario();
    await recordEvidence(pool, evidence(id('ev'), 'bank_statement', source), null, VAULT);
    await recordBankLines(pool, [
      statementLine(id('bank-odd'), 313_131n, 'UNKNOWN CREDIT', id('ev')),
    ]);
    await reconcile(pool, { asOf: ASOF, policyFor: policy, limit: 50_000 });

    await assert.rejects(
      pool.query(`UPDATE exception_events SET to_state = 'resolved'`),
      /LAW_2_VIOLATION/,
    );
    await assert.rejects(
      pool.query(`DELETE FROM exception_events`),
      /LAW_2_VIOLATION/,
    );
  });

  /**
   * An exception cannot be closed without saying why. That one field is what makes the
   * table able to answer the question it exists for: how much of this queue clears itself?
   */
  test('the database refuses a resolution with no cause', async () => {
    const { id } = scenario();
    await assert.rejects(
      pool.query(
        `INSERT INTO exception_events
                (exception_key, subject, subject_id, reason, to_state, at)
         VALUES ($1, 'payout', $2, 'PHANTOM_CREDIT', 'resolved', now())`,
        [id('no-cause-key'), id('no-cause')],
      ),
      /exception_events_resolved_has_cause/,
    );
  });

  // ── Bank-side exceptions ──────────────────────────────────────────────────

  /**
   * The event the two-way design could not see at all: cash that arrived, was booked, and
   * then bounced. It is a *debit*, which is why stage three cannot filter the statement
   * down to credits — and booking it back is an exact negation, not an unwinding.
   */
  test('a returned payout is booked back and queued', async () => {
    const { source, id, policy } = scenario();
    await promise(source, id('pay-1'), 2_400_000n);
    await recordEvidence(pool, evidence(id('ev'), 'psp_settlement', source), null, VAULT);
    await recordPayouts(pool, [
      payout(source, id('PO-returned'), 2_400_000n, [deduction('fee', 36_000n)], id('ev')),
    ]);
    await recordBankLines(pool, [
      statementLine(id('bank-in'), 2_364_000n, `TRF ${id('PO-returned')}`, id('ev')),
    ]);

    const banked = await reconcile(pool, { asOf: ASOF, policyFor: policy, limit: 50_000 });
    assert.equal(banked.booked.filter((entry) => entry.reason === 'BANK_CONFIRMED').length, 1);

    // Two days later the bank sends it back.
    await recordBankLines(pool, [
      statementLine(
        id('bank-out'),
        2_364_000n,
        `RETURN ${id('PO-returned')}`,
        id('ev'),
        'debit',
        new Date('2026-08-15T09:00:00Z'),
      ),
    ]);

    const bounced = await reconcile(pool, { asOf: LATER, policyFor: policy, limit: 50_000 });
    assert.equal(bounced.failures.length, 0, JSON.stringify(bounced.failures));
    assert.equal(bounced.confirmation.returned.length, 1);

    // An exact negation of the confirming transaction: every account it touched moves back,
    // so the receivable reopens and the PSP owes us again.
    const original = await getTransaction(pool, id('bank-in'));
    const reversal = await getTransaction(pool, id('bank-out'));
    assert.ok(reversal);
    assert.deepEqual(
      reversal.entries.map((entry) => [entry.accountId, entry.amount.kobo]),
      original!.entries.map((entry) => [entry.accountId, -entry.amount.kobo]),
    );

    const status = await pool.query<{ status: string }>(
      'SELECT status FROM payouts WHERE payout_reference = $1',
      [id('PO-returned')],
    );
    assert.equal(status.rows[0]!.status, 'returned');

    const [item] = await queueFor(id('PO-returned'));
    assert.equal(item?.reason, 'RETURNED_PAYOUT');

    assert.deepEqual(await verifyBalances(pool), [], 'the cache drifted from the entries');
    assert.equal((await verifyConservation(pool)).kobo, 0n, 'the books stopped balancing');
  });

  /**
   * Money we appear to have been paid twice. It must not book — and it must not be filed
   * as "unidentified", which is technically true and describes the wrong problem.
   */
  test('a second credit for a banked payout is queued as a duplicate', async () => {
    const { source, id, policy } = scenario();
    await promise(source, id('pay-1'), 3_300_000n);
    await recordEvidence(pool, evidence(id('ev'), 'psp_settlement', source), null, VAULT);
    await recordPayouts(pool, [
      payout(source, id('PO-twice'), 3_300_000n, [deduction('fee', 49_500n)], id('ev')),
    ]);
    await recordBankLines(pool, [
      statementLine(id('bank-1'), 3_250_500n, `TRF ${id('PO-twice')}`, id('ev')),
    ]);
    await reconcile(pool, { asOf: ASOF, policyFor: policy, limit: 50_000 });

    // The same credit again, on a later statement.
    await recordBankLines(pool, [
      statementLine(id('bank-2'), 3_250_500n, `TRF ${id('PO-twice')}`, id('ev')),
    ]);
    const second = await reconcile(pool, { asOf: ASOF, policyFor: policy, limit: 50_000 });

    assert.equal(second.booked.length, 0, 'a duplicate credit books nothing');
    const [item] = await queueFor(id('bank-2'));
    assert.equal(item?.reason, 'DUPLICATE_BANK_CREDIT');
    assert.deepEqual(item?.payoutReferences, [id('PO-twice')]);

    assert.equal((await verifyConservation(pool)).kobo, 0n);
  });

  /**
   * The queue is triaged by what the problem *is*, not by when it arrived. Cash we hold and
   * cannot explain outranks money that is merely late, because the first may have to be
   * sent back and the second usually turns up.
   */
  test('the queue puts the alarming things first', async () => {
    const { source, id, policy } = scenario();
    await promise(source, id('pay-late'), 111_111n);
    await recordEvidence(pool, evidence(id('ev'), 'bank_statement', source), null, VAULT);
    await recordBankLines(pool, [
      statementLine(id('bank-mystery'), 222_222n, 'NO IDEA', id('ev')),
    ]);

    await reconcile(pool, { asOf: LATER, policyFor: policy, limit: 50_000 });

    const mine = (await openExceptions(pool, { limit: 5000 })).filter((item) =>
      [id('pay-late'), id('bank-mystery')].includes(item.subjectId),
    );
    assert.deepEqual(
      mine.map((item) => item.reason),
      ['UNIDENTIFIED_CREDIT', 'MISSING_SETTLEMENT'],
      'unexplained cash outranks a late settlement',
    );
  });
});
