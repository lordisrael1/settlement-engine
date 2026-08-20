import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';

import type { Pool } from 'pg';

import { localKeyRing, parseLocalKey } from '@recon/protect';

import type {
  AccountId,
  BankStatementLine,
  BusinessCalendar,
  Evidence,
  FeeContract,
  Money,
  Payout,
  SettlementAdjustment,
} from '@recon/canon';
import { ANY_CHANNEL, feeFor, feeModel, money, NO_LINEAGE, DEFAULT_RETENTION } from '@recon/canon';
import {
  bookAuthorizedPayment,
  createPool,
  getTransaction,
  LEDGER_MIGRATIONS_DIR,
  runMigrations,
  verifyBalances,
  verifyConservation,
} from '@recon/ledger-core';

import type { PolicyLookup } from './policy.js';
import { reconcile } from './run.js';
import {
  allocationsOf,
  loadFeeContracts,
  matchOf,
  recordBankLines,
  recordPayouts,
  recordResolution,
  resolutionsFor,
  RECONCILER_MIGRATIONS_DIR,
  saveFeeContract,
} from './store.js';

import { readEvidenceBytes, recordEvidence, type EvidenceVault } from './evidence.js';

/**
 * A key ring for the suite. Evidence is encrypted on the way in with no unencrypted path
 * (ADR-0063), so a test that stores a document needs one exactly as a deployment does.
 */
const VAULT: EvidenceVault = {
  keyRing: localKeyRing([parseLocalKey(`test:${Buffer.alloc(32, 1).toString('base64')}`)], 'test'),
  retention: DEFAULT_RETENTION,
};

/**
 * The three-way claim, against a real Postgres — because the things being asserted are
 * what the database will and will not accept, and a mock would only ever agree with us.
 *
 *   docker compose up -d postgres
 *   DATABASE_URL=postgres://recon:recon@localhost:5432/recon npm test
 */
const DATABASE_URL = process.env['DATABASE_URL'];

const PAID_AT = new Date('2026-08-12T09:00:00Z');
const VALUE_DATE = new Date('2026-08-13T09:00:00Z');
const ASOF = new Date('2026-08-13T12:00:00Z');
const MERCHANT = 'merchant-under-test';

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

describe('three-way reconciliation', { skip: DATABASE_URL ? false : 'set DATABASE_URL to run' }, () => {
  let pool: Pool;

  /**
   * A schema of this suite's own. The ledger suite posts a thousand random transactions
   * against the same database in parallel with this one, and sharing `public` with it
   * would make every global assertion here a measurement of the other suite's weather.
   */
  before(async () => {
    const schema = `recon_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
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

  /** Each test invents its own source, so runs cannot see each other's records. */
  const scenario = () => {
    const run = randomUUID().slice(0, 8);
    const source = `src-${run}`;
    return {
      run,
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
    storageLocation: `s3://evidence/${id}`,
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
      lineage: { rowNumber: 0, path: '$.data[0]' },
      idempotencyKey: `payout:${source}:${reference}`,
    };
  };

  const deduction = (kind: SettlementAdjustment['kind'], kobo: bigint): SettlementAdjustment => ({
    kind,
    amount: money(kobo),
    narration: kind,
  });

  const credit = (
    key: string,
    amount: bigint,
    narration: string,
    evidenceId: string,
  ): BankStatementLine => ({
    reference: key,
    bankAccountId: 'gtb-0001',
    direction: 'credit',
    amount: money(amount),
    balanceAfter: null,
    valueDate: VALUE_DATE,
    narration,
    narrationTokens: narration.toUpperCase().match(/[A-Z0-9][A-Z0-9_-]{5,}/g) ?? [],
    statedReference: null,
    evidenceId,
    lineage: { rowNumber: 2, path: '$[2]' },
    idempotencyKey: key,
  });

  const entriesOf = async (transactionId: string): Promise<[AccountId, bigint][]> => {
    const transaction = await getTransaction(pool, transactionId);
    assert.ok(transaction, `no ledger transaction "${transactionId}"`);
    return transaction.entries.map((entry) => [entry.accountId, entry.amount.kobo]);
  };

  // ── The headline claim ────────────────────────────────────────────────────

  /**
   * The whole point of the redesign, in one test: a PSP's settlement report moves no
   * money, and an independent bank credit is what books it. Under the two-way design the
   * first `reconcile` here would already have credited `bank_account` — on nothing more
   * than the PSP's word.
   */
  test('a PSP report books nothing; the bank statement books everything', async () => {
    const { source, id, policy } = scenario();

    await promise(source, id('pay-1'), 600_000n);
    await promise(source, id('pay-2'), 400_000n);

    await recordEvidence(pool, evidence(id('ev-psp'), 'psp_settlement', source), Buffer.from('{}'), VAULT);
    await recordPayouts(pool, [
      payout(
        source,
        id('PO-2026-0001'),
        1_000_000n,
        [deduction('fee', 15_000n), deduction('tax', 1_125n), deduction('reserve', 40_000n)],
        id('ev-psp'),
      ),
    ]);

    // ── Stage two ─────────────────────────────────────────────────────────
    const reported = await reconcile(pool, { asOf: ASOF, policyFor: policy, limit: 50_000 });

    assert.equal(reported.allocation.prepared.length, 1);
    assert.equal(reported.allocation.prepared[0]!.result.reason, 'PAYOUT_MATCH');
    assert.equal(reported.booked.length, 0, 'a PSP report is a claim, not cash');
    assert.equal(
      reported.confirmation.deferred[0]?.reason,
      'AWAITING_BANK_CREDIT',
      'the money is reported and unconfirmed — neither matched nor missing',
    );

    // The promises are still owed. Nothing has moved.
    assert.equal((await getTransaction(pool, id('pay-1')))?.state, 'authorized');

    // ── Stage three ───────────────────────────────────────────────────────
    await recordEvidence(pool, evidence(id('ev-bank'), 'bank_statement', source), Buffer.from('[]'), VAULT);
    await recordBankLines(pool, [
      credit(id('bank-1'), 943_875n, `TRF SETTLEMENT ${id('PO-2026-0001')}`, id('ev-bank')),
    ]);

    const confirmed = await reconcile(pool, { asOf: ASOF, policyFor: policy, limit: 50_000 });

    assert.equal(confirmed.failures.length, 0, JSON.stringify(confirmed.failures));
    assert.equal(confirmed.booked.length, 1);
    assert.equal(confirmed.booked[0]!.reason, 'BANK_CONFIRMED');

    // Cash, every named deduction to its own account, and the receivable closed — in one
    // transaction, balanced without a plug.
    assert.deepEqual(await entriesOf(id('bank-1')), [
      ['bank_account', 943_875n],
      ['fees_expense', 15_000n],
      ['taxes_withheld', 1_125n],
      ['psp_reserve', 40_000n],
      ['psp_receivable', -1_000_000n],
    ]);

    assert.equal((await getTransaction(pool, id('pay-1')))?.state, 'settled');
    assert.equal((await getTransaction(pool, id('pay-2')))?.state, 'settled');

    // The payout's own lifecycle moved with it: `reported` was Flutterwave's claim,
    // `confirmed` is the bank's answer.
    const status = await pool.query<{ status: string }>(
      'SELECT status FROM payouts WHERE payout_reference = $1',
      [id('PO-2026-0001')],
    );
    assert.equal(status.rows[0]!.status, 'confirmed');

    assert.deepEqual(await verifyBalances(pool), [], 'the cache drifted from the entries');
    assert.equal((await verifyConservation(pool)).kobo, 0n, 'the books stopped balancing');
  });

  /**
   * One payout, many payments, named by the PSP rather than inferred. The allocation
   * records which receivable each part of the movement closed.
   */
  test('a payout records which payments it covers', async () => {
    const { source, id, policy } = scenario();

    await promise(source, id('pay-1'), 600_000n);
    await promise(source, id('pay-2'), 400_000n);
    await recordEvidence(pool, evidence(id('ev'), 'psp_settlement', source), null, VAULT);
    await recordPayouts(pool, [
      payout(source, id('PO-2026-0002'), 1_000_000n, [deduction('fee', 15_000n)], id('ev')),
    ]);

    await reconcile(pool, { asOf: ASOF, policyFor: policy, limit: 50_000 });

    const allocations = await allocationsOf(pool, id('PO-2026-0002'));
    assert.deepEqual(
      allocations.map((allocation) => [allocation.transactionId, allocation.amount.kobo]).sort(),
      [
        [id('pay-1'), 600_000n],
        [id('pay-2'), 400_000n],
      ].sort(),
    );
  });

  /**
   * A payment may never be allocated for more than it was worth. Without this, two payouts
   * could each claim the whole of one payment and the ledger would discharge the same
   * receivable twice — so the database refuses, whatever the application believes.
   */
  test('the database refuses to allocate a payment beyond its value', async () => {
    const { source, id, policy } = scenario();

    await promise(source, id('pay-1'), 1_000_000n);
    await recordEvidence(pool, evidence(id('ev'), 'psp_settlement', source), null, VAULT);
    await recordPayouts(pool, [
      payout(source, id('PO-2026-0003'), 1_000_000n, [], id('ev')),
    ]);
    await reconcile(pool, { asOf: ASOF, policyFor: policy, limit: 50_000 });

    // A rogue script, bypassing every line of our code.
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO expected_inflows
                (inflow_key, source, derived, gross_kobo, expected_net_kobo, currency,
                 deductions, value_date, evidence_id, reported_at)
         VALUES ($1, $2, false, 1, 1, 'NGN', '[]'::jsonb, now(), $3, now())`,
        [id('rogue'), source, id('ev')],
      );
      await client.query(
        `INSERT INTO inflow_allocations (inflow_key, transaction_id, amount_kobo)
              VALUES ($1, $2, 1)`,
        [id('rogue'), id('pay-1')],
      );
      await assert.rejects(client.query('COMMIT'), /OVER_ALLOCATION/);
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
  });

  /**
   * Idempotency across a whole run. A reconciliation retried — because the process died, a cron
   * overlapped, or somebody ran it twice — must move exactly no money the second time.
   */
  test('running the same reconciliation twice moves nothing', async () => {
    const { source, id, policy } = scenario();

    // Amounts here are deliberately unlike every other test's. Inflows left open by
    // earlier tests share this schema, and a credit that fits two of them equally well is
    // refused — correctly, but it would make this test about the wrong thing.
    await promise(source, id('pay-1'), 1_200_000n);
    await recordEvidence(pool, evidence(id('ev'), 'psp_settlement', source), null, VAULT);
    await recordPayouts(pool, [
      payout(source, id('PO-2026-0004'), 1_200_000n, [deduction('fee', 18_000n)], id('ev')),
    ]);
    await recordBankLines(pool, [credit(id('bank-1'), 1_182_000n, 'TRF INBOUND', id('ev'))]);

    await reconcile(pool, { asOf: ASOF, policyFor: policy, limit: 50_000 });
    const first = await entriesOf(id('bank-1'));

    const second = await reconcile(pool, { asOf: ASOF, policyFor: policy, limit: 50_000 });

    assert.equal(second.booked.length, 0, 'the second run found the credit again');
    assert.deepEqual(await entriesOf(id('bank-1')), first, 'the second run wrote more entries');
  });

  /**
   * One credit confirms one inflow. A duplicated statement row must not be able to confirm
   * a second payout and book the same cash twice — enforced by a partial unique index, so
   * a second service cannot walk past it either.
   */
  test('the database refuses to let one bank credit confirm two payouts', async () => {
    const { source, id, policy } = scenario();

    await promise(source, id('pay-1'), 1_500_000n);
    await promise(source, id('pay-2'), 700_000n);
    await recordEvidence(pool, evidence(id('ev'), 'psp_settlement', source), null, VAULT);
    await recordPayouts(pool, [
      payout(source, id('PO-2026-0005'), 1_500_000n, [deduction('fee', 22_500n)], id('ev')),
      payout(source, id('PO-2026-0006'), 700_000n, [deduction('fee', 10_500n)], id('ev')),
    ]);
    await recordBankLines(pool, [credit(id('bank-1'), 1_477_500n, 'TRF INBOUND', id('ev'))]);

    const run = await reconcile(pool, { asOf: ASOF, policyFor: policy, limit: 50_000 });
    assert.equal(run.booked.length, 1, 'the first payout is confirmed and booked');

    await assert.rejects(
      pool.query(
        `UPDATE expected_inflows SET confirmed_by = $1, confirmed_at = now()
          WHERE inflow_key = $2`,
        [id('bank-1'), id('PO-2026-0006')],
      ),
      /duplicate key|unique/i,
    );
  });

  // ── Evidence ──────────────────────────────────────────────────────────────

  /**
   * Every record traces to bytes somebody can produce, and those bytes cannot be quietly
   * revised afterwards. Without this, "the system matched it" is the only answer available
   * six months later, and it is not an answer.
   */
  test('evidence is stored with its bytes, encrypted, and cannot be rewritten', async () => {
    const { source, id } = scenario();
    const bytes = Buffer.from('{"settlements":[],"payer":"amaka@example.com"}', 'utf8');

    assert.deepEqual(
      await recordEvidence(pool, evidence(id('ev'), 'psp_settlement', source), bytes, VAULT),
      { stored: 1, duplicates: 0 },
    );
    // Content-addressed: the same file twice is one record, with no remembering involved.
    assert.deepEqual(
      await recordEvidence(pool, evidence(id('ev'), 'psp_settlement', source), bytes, VAULT),
      { stored: 0, duplicates: 1 },
    );

    const stored = await pool.query<{ parser_version: string; received_from: string }>(
      'SELECT parser_version, received_from FROM evidence WHERE evidence_id = $1',
      [id('ev')],
    );
    assert.equal(stored.rows[0]!.parser_version, 'test/1');
    assert.equal(stored.rows[0]!.received_from, 'test-suite');

    // The bytes come back through the key ring, and only through it. What is in the column
    // is ciphertext: a `pg_dump`, a read replica or a leaked backup carries nothing
    // readable, which is the exposure that actually happens (ADR-0063).
    const column = await pool.query<{ ciphertext: Buffer; content: string }>(
      'SELECT ciphertext, content FROM evidence_blobs WHERE evidence_id = $1',
      [id('ev')],
    );
    assert.ok(!column.rows[0]!.ciphertext.includes(Buffer.from('amaka@example.com', 'utf8')));
    assert.equal(column.rows[0]!.content, 'original');

    const held = await readEvidenceBytes(pool, id('ev'), VAULT);
    assert.deepEqual(held?.bytes, bytes);
    assert.equal(held?.hashMatchesId, true);

    // The identity, the lineage and the hash stay append-only. Only the bytes are allowed
    // to change, and only by expiring — which is the whole of the split (ADR-0065).
    await assert.rejects(
      pool.query('UPDATE evidence SET parser_version = $1 WHERE evidence_id = $2', [
        'tampered/9',
        id('ev'),
      ]),
      /LAW_2_VIOLATION/,
    );
  });

  test('a conclusion is a conclusion, not a draft', async () => {
    const { source, id, policy } = scenario();

    await promise(source, id('pay-1'), 1_000_000n);
    await recordEvidence(pool, evidence(id('ev'), 'psp_settlement', source), null, VAULT);
    await recordPayouts(pool, [
      payout(source, id('PO-2026-0007'), 1_000_000n, [deduction('fee', 15_000n)], id('ev')),
    ]);
    await reconcile(pool, { asOf: ASOF, policyFor: policy, limit: 50_000 });

    assert.equal((await matchOf(pool, `allocate:${id('PO-2026-0007')}`))?.reason, 'PAYOUT_MATCH');
    // Stage two books nothing, and the record says so.
    assert.equal(
      (await matchOf(pool, `allocate:${id('PO-2026-0007')}`))?.bookedTransactionId,
      null,
    );

    await assert.rejects(
      pool.query('UPDATE matches SET reason = $1 WHERE match_id = $2', [
        'BANK_CONFIRMED',
        `allocate:${id('PO-2026-0007')}`,
      ]),
      /LAW_2_VIOLATION/,
    );
  });

  // ── Fee contracts ─────────────────────────────────────────────────────────

  /**
   * Reconciling March with April's renegotiated rate would invent a fee variance on every
   * March payment. History does not change because a contract did.
   */
  test('fee contracts are versioned, and history is priced at its own rates', async () => {
    const { source } = scenario();
    const boundary = new Date('2026-04-01T00:00:00Z');

    const published: FeeContract = {
      contractId: `${source}-published`,
      source,
      merchantId: MERCHANT,
      channel: 'card',
      currency: 'NGN',
      effectiveFrom: new Date(0),
      effectiveTo: boundary,
      rateCard: CARD,
      approvedBy: 'published-rate-card',
      approvedAt: new Date(0),
    };
    const negotiated: FeeContract = {
      ...published,
      contractId: `${source}-negotiated`,
      effectiveFrom: boundary,
      effectiveTo: null,
      rateCard: { ...CARD, percentBasisPoints: 100 },
      approvedBy: 'cfo@example.com',
      approvedAt: boundary,
    };

    await saveFeeContract(pool, published);
    await saveFeeContract(pool, negotiated);

    const contracts = await loadFeeContracts(pool, source, MERCHANT);
    assert.equal(contracts.length, 2);

    const model = feeModel(contracts);
    const march = new Date('2026-03-15T10:00:00Z');
    const may = new Date('2026-05-15T10:00:00Z');

    assert.equal(model(money(1_000_000n), march, 'card')?.fee.kobo, 15_000n);
    assert.equal(model(money(1_000_000n), may, 'card')?.fee.kobo, 10_000n);
    // VAT is its own number, bound for its own account.
    assert.equal(model(money(1_000_000n), may, 'card')?.vat.kobo, 750n);
    // Neither contract was quoted for transfers, and neither is stretched to cover one.
    assert.equal(model(money(1_000_000n), may, 'bank_transfer'), null);
  });

  /**
   * Two contracts in force at once for one merchant and source is a data error that would
   * silently make fee expectations non-deterministic. The database makes it impossible
   * rather than merely discouraged.
   */
  test('the database refuses two contracts in force at the same time', async () => {
    const { source } = scenario();
    const base: FeeContract = {
      contractId: `${source}-a`,
      source,
      merchantId: MERCHANT,
      channel: 'card',
      currency: 'NGN',
      effectiveFrom: new Date('2026-01-01T00:00:00Z'),
      effectiveTo: new Date('2026-06-01T00:00:00Z'),
      rateCard: CARD,
      approvedBy: 'cfo@example.com',
      approvedAt: new Date(0),
    };

    await saveFeeContract(pool, base);
    await assert.rejects(
      saveFeeContract(pool, {
        ...base,
        contractId: `${source}-b`,
        effectiveFrom: new Date('2026-03-01T00:00:00Z'),
        effectiveTo: null,
      }),
      /fee_contracts_no_overlap|exclusion/i,
    );
  });

  // ── Human resolutions ─────────────────────────────────────────────────────

  /**
   * A reviewer never edits a match. They append a statement of what they concluded, who
   * they are, when, why, and what they were looking at — and a change of mind is a second
   * resolution, not a correction of the first.
   */
  test('a human resolution is appended with an identity and an approver', async () => {
    const { source, id } = scenario();
    await recordEvidence(pool, evidence(id('ev'), 'bank_statement', source), null, VAULT);

    await recordResolution(pool, {
      resolutionKey: id('res-1'),
      subject: 'bank_credit',
      subjectId: id('bank-99'),
      action: 'write_off',
      reason: 'Correspondent bank charge below the investigation threshold.',
      amount: money(5_250n),
      resolvedBy: 'ops.amaka@example.com',
      resolvedAt: ASOF,
      evidenceId: id('ev'),
      approvedBy: 'controller.tunde@example.com',
      approvedAt: ASOF,
    });

    await recordResolution(pool, {
      resolutionKey: id('res-2'),
      subject: 'bank_credit',
      subjectId: id('bank-99'),
      action: 'reopened',
      reason: 'The bank refunded the charge after all.',
      amount: null,
      resolvedBy: 'ops.amaka@example.com',
      resolvedAt: new Date('2026-08-14T09:00:00Z'),
      evidenceId: null,
      approvedBy: null,
      approvedAt: null,
    });

    const history = await resolutionsFor(pool, 'bank_credit', id('bank-99'));
    assert.deepEqual(
      history.map((entry) => [entry.resolution.action, entry.resolution.approvedBy]),
      [
        ['write_off', 'controller.tunde@example.com'],
        ['reopened', null],
      ],
      'both decisions survive, in the order they were made',
    );

    await assert.rejects(
      pool.query('DELETE FROM resolutions WHERE subject_id = $1', [id('bank-99')]),
      /LAW_2_VIOLATION/,
    );
  });

  /** An approval is either complete or absent. A half-recorded one is worse than none. */
  test('an approval cannot be half-recorded', async () => {
    const { id } = scenario();
    await assert.rejects(
      pool.query(
        `INSERT INTO resolutions
                (resolution_key, subject, subject_id, action, reason, resolved_by,
                 resolved_at, approved_by)
         VALUES ($1, 'payout', $2, 'write_off', 'x', 'ops@example.com', now(), 'boss@example.com')`,
        [id('half-key'), id('half')],
      ),
      /resolutions_approval_complete/,
    );
  });

  // ── Maker-checker ─────────────────────────────────────────────────────────

  /**
   * The failure mode this exists for: the person who noticed a discrepancy is the person
   * best placed to make it disappear. They are usually acting in good faith. A second named
   * human is the cheapest control that tells the two cases apart.
   */
  test('a write-off without an approver is refused', async () => {
    const { id } = scenario();

    await assert.rejects(
      recordResolution(pool, {
        resolutionKey: id('unapproved'),
        subject: 'payout',
        subjectId: id('PO-X'),
        action: 'write_off',
        reason: 'It has been three months.',
        amount: money(4_000_000n),
        resolvedBy: 'ops.amaka@example.com',
        resolvedAt: ASOF,
        evidenceId: null,
        approvedBy: null,
        approvedAt: null,
      }),
      /requires an approver/,
    );
  });

  /**
   * One person named twice is one person. Refused by the application, and independently by
   * a database constraint — because a control enforced in one layer is one refactor away
   * from not existing.
   */
  test('nobody approves their own resolution, in either layer', async () => {
    const { id } = scenario();
    const selfApproved = {
      resolutionKey: id('self'),
      subject: 'payout' as const,
      subjectId: id('PO-Y'),
      action: 'write_off',
      reason: 'Signed off by me, to me.',
      amount: money(1_000n),
      resolvedBy: 'ops.amaka@example.com',
      resolvedAt: ASOF,
      evidenceId: null,
      approvedBy: 'ops.amaka@example.com',
      approvedAt: ASOF,
    };

    await assert.rejects(recordResolution(pool, selfApproved), /cannot approve their own/);

    // And again with the application walked past entirely.
    await assert.rejects(
      pool.query(
        `INSERT INTO resolutions
                (resolution_key, subject, subject_id, action, reason, resolved_by,
                 resolved_at, approved_by, approved_at)
         VALUES ($1, 'payout', $2, 'write_off', 'x', 'ops@example.com', now(),
                 'ops@example.com', now())`,
        [id('self-raw'), id('PO-Y')],
      ),
      /resolutions_no_self_approval/,
    );
  });

  // ── Compensating entries ──────────────────────────────────────────────────

  /**
   * The ADR's own example. An operator finds the PSP's reserve notice and concludes that a
   * ₦1,000 "fee" was a rolling reserve. The original booking is not touched — it recorded
   * what we knew — and a second transaction moves the money to the account that describes
   * it. An auditor sees the mistake and the correction, which is more than seeing neither.
   */
  test('a resolution posts its compensating entry, with the decision, in one write', async () => {
    const { id } = scenario();

    const recorded = await recordResolution(
      pool,
      {
        resolutionKey: id('reclass'),
        subject: 'payout',
        subjectId: id('PO-Z'),
        action: 'reclassify',
        reason: 'PSP reserve notice: the ₦1,000 was a 90-day rolling reserve, not a fee.',
        amount: money(100_000n),
        resolvedBy: 'ops.amaka@example.com',
        resolvedAt: ASOF,
        evidenceId: null,
        approvedBy: 'controller.tunde@example.com',
        approvedAt: ASOF,
      },
      {
        entries: [
          { accountId: 'psp_reserve', amount: money(100_000n) },
          { accountId: 'fees_expense', amount: money(-100_000n) },
        ],
      },
    );

    assert.equal(recorded.bookedTransactionId, `resolution:${id('reclass')}`);
    assert.deepEqual(await entriesOf(`resolution:${id('reclass')}`), [
      ['psp_reserve', 100_000n],
      ['fees_expense', -100_000n],
    ]);

    // The decision and its booking are one write, and the resolution names the transaction.
    const history = await resolutionsFor(pool, 'payout', id('PO-Z'));
    assert.equal(history[0]!.bookedTransactionId, `resolution:${id('reclass')}`);

    assert.deepEqual(await verifyBalances(pool), [], 'the cache drifted from the entries');
    assert.equal((await verifyConservation(pool)).kobo, 0n, 'the books stopped balancing');
  });

  /**
   * The three-way design in one refusal. An operator who believes the bank balance is wrong
   * has found either a statement line we have not ingested, or a genuine bank error that
   * comes back as a statement line. Neither is fixed by typing a number — and the moment
   * this is allowed "once, carefully", cash stops meaning bank evidence.
   */
  test('no human decision may move the bank balance', async () => {
    const { id } = scenario();

    await assert.rejects(
      recordResolution(
        pool,
        {
          resolutionKey: id('cash'),
          subject: 'bank_credit',
          subjectId: id('bank-x'),
          action: 'clear_phantom',
          reason: 'I am sure the money is there.',
          amount: money(500_000n),
          resolvedBy: 'ops.amaka@example.com',
          resolvedAt: ASOF,
          evidenceId: null,
          approvedBy: 'controller.tunde@example.com',
          approvedAt: ASOF,
        },
        {
          entries: [
            { accountId: 'bank_account', amount: money(500_000n) },
            { accountId: 'suspense', amount: money(-500_000n) },
          ],
        },
      ),
      /bank evidence/,
    );

    // Nothing was written: not the booking, and not the decision that justified it.
    assert.equal(await getTransaction(pool, `resolution:${id('cash')}`), null);
    assert.deepEqual(await resolutionsFor(pool, 'bank_credit', id('bank-x')), []);
  });

  /** A retried request appends one decision and books once (idempotency, on the human half). */
  test('recording the same resolution twice books once', async () => {
    const { id } = scenario();
    const resolution = {
      resolutionKey: id('retried'),
      subject: 'payout' as const,
      subjectId: id('PO-R'),
      action: 'reclassify',
      reason: 'Reserve, not fee.',
      amount: money(20_000n),
      resolvedBy: 'ops.amaka@example.com',
      resolvedAt: ASOF,
      evidenceId: null,
      approvedBy: 'controller.tunde@example.com',
      approvedAt: ASOF,
    };
    const entries = [
      { accountId: 'psp_reserve' as const, amount: money(20_000n) },
      { accountId: 'fees_expense' as const, amount: money(-20_000n) },
    ];

    const first = await recordResolution(pool, resolution, { entries });
    const second = await recordResolution(pool, resolution, { entries });

    assert.equal(second.bookedTransactionId, first.bookedTransactionId);
    assert.equal((await resolutionsFor(pool, 'payout', id('PO-R'))).length, 1);
    assert.equal((await entriesOf(`resolution:${id('retried')}`)).length, 2);
  });

  // ── What the decision was priced by ───────────────────────────────────────

  /**
   * A fee model is administered data that changes. Recomputing a March decision against
   * today's contract table can reach a different answer than the one we acted on, so the
   * contract that priced each promise is stored with the conclusion.
   */
  test('a match records the fee contract that explained it', async () => {
    const { source, id, policy } = scenario();

    await promise(source, id('pay-1'), 800_000n);
    await recordEvidence(pool, evidence(id('ev'), 'psp_settlement', source), null, VAULT);
    await recordPayouts(pool, [
      payout(source, id('PO-2026-0010'), 800_000n, [deduction('fee', 12_000n)], id('ev')),
    ]);
    await reconcile(pool, { asOf: ASOF, policyFor: policy, limit: 50_000 });

    const match = await matchOf(pool, `allocate:${id('PO-2026-0010')}`);
    assert.deepEqual(match?.explainedBy, [
      {
        transactionId: id('pay-1'),
        contractId: 'test-contract',
        channel: '*',
        expectedFee: money(12_000n),
        expectedVat: money(900n),
        observedFee: money(12_000n),
      },
    ]);
  });

  /**
   * One batch fee across two payments. Stored rather than recomputed, because the
   * apportionment rule is a choice and a stored answer stays reproducible after it changes.
   */
  test('an allocation carries its apportioned share of the deductions', async () => {
    const { source, id, policy } = scenario();

    await promise(source, id('pay-1'), 900_000n);
    await promise(source, id('pay-2'), 2_100_000n);
    await recordEvidence(pool, evidence(id('ev'), 'psp_settlement', source), null, VAULT);
    await recordPayouts(pool, [
      payout(source, id('PO-2026-0011'), 3_000_000n, [deduction('fee', 45_000n)], id('ev')),
    ]);
    await reconcile(pool, { asOf: ASOF, policyFor: policy, limit: 50_000 });

    const allocations = await allocationsOf(pool, id('PO-2026-0011'));
    assert.deepEqual(
      allocations.map((allocation) => [
        allocation.transactionId,
        allocation.amount.kobo,
        allocation.net.kobo,
        allocation.deductions.map((d) => [d.accountId, d.amount.kobo]),
      ]),
      [
        [id('pay-1'), 900_000n, 886_500n, [['fees_expense', 13_500n]]],
        [id('pay-2'), 2_100_000n, 2_068_500n, [['fees_expense', 31_500n]]],
      ],
    );
  });

  // ── Lineage ───────────────────────────────────────────────────────────────

  /**
   * "Which file?" was answerable before; "which line of it?" was not. In a five-thousand-row
   * export those are different questions, and only the second lets somebody reproduce a
   * conclusion without reading the whole file.
   */
  test('a record traces to a row of a file, not merely to the file', async () => {
    const { source, id } = scenario();
    await recordEvidence(pool, evidence(id('ev'), 'psp_settlement', source), Buffer.from('{}'), VAULT);
    await recordPayouts(pool, [
      payout(source, id('PO-2026-0012'), 500_000n, [], id('ev')),
    ]);

    const stored = await pool.query<{
      source_row_number: number;
      source_path: string;
      storage_location: string;
    }>(
      `SELECT p.source_row_number, p.source_path, e.storage_location
         FROM payouts p JOIN evidence e ON e.evidence_id = p.evidence_id
        WHERE p.payout_reference = $1`,
      [id('PO-2026-0012')],
    );

    assert.equal(stored.rows[0]!.source_row_number, 0);
    assert.equal(stored.rows[0]!.source_path, '$.data[0]');
    assert.equal(stored.rows[0]!.storage_location, `s3://evidence/${id('ev')}`);
  });
});
