import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';

import fc from 'fast-check';
import type { Pool } from 'pg';

import type { AccountId } from '@recon/canon';
import { ACCOUNT_IDS, money } from '@recon/canon';

import { allBalances, verifyBalances, verifyConservation } from './balance.js';
import { UnbalancedTransactionError } from './errors.js';
import { runMigrations } from './migrate.js';
import { createPool } from './pool.js';
import { postTransaction, type EntryInput } from './post.js';
import { getTransaction } from './read.js';
import { reverse } from './reverse.js';
import { currentState, transition } from './state.js';

/**
 * These tests need a real Postgres, because the invariants they check are enforced by
 * Postgres. Mocking the database here would test the mock's willingness to agree with us.
 *
 *   docker compose up -d postgres
 *   DATABASE_URL=postgres://recon:recon@localhost:5432/recon npm test
 */
const DATABASE_URL = process.env['DATABASE_URL'];

describe('the ledger', { skip: DATABASE_URL ? false : 'set DATABASE_URL to run' }, () => {
  let pool: Pool;

  /**
   * A schema of this suite's own.
   *
   * It posts a thousand random transactions, deliberately without narrating them to the
   * event log — they are synthetic fixtures, not happenings, and inventing an event type for
   * them would put fiction in the one table that proves everything else. But that makes them
   * exactly the drift `replay` exists to detect, so they must not land in the schema the
   * demo and the CLI use, or every replay of a dev database would report a fault that is
   * really just this file having run.
   */
  before(async () => {
    const schema = `ledger_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
    const bootstrap = createPool(DATABASE_URL);
    await bootstrap.query(`CREATE SCHEMA ${schema}`);
    await bootstrap.end();

    const url = new URL(DATABASE_URL!);
    url.searchParams.set('options', `-c search_path=${schema}`);
    pool = createPool(url.toString());

    await runMigrations(pool);
  });

  after(async () => {
    await pool.end();
  });

  const post = (entries: readonly EntryInput[], id = `test:${randomUUID()}`) =>
    postTransaction(pool, {
      transactionId: id,
      source: 'test',
      reference: id,
      occurredAt: new Date('2026-08-15T10:00:00Z'),
      recordedAt: new Date('2026-08-15T10:00:00Z'),
      initialState: 'authorized',
      entries,
    });

  test('a balanced transaction is accepted', async () => {
    const result = await post([
      { accountId: 'psp_receivable', amount: money(500_000n) },
      { accountId: 'merchant_revenue', amount: money(-500_000n) },
    ]);
    assert.equal(result.outcome, 'posted');
  });

  test('an unbalanced transaction is refused', async () => {
    await assert.rejects(
      post([
        { accountId: 'psp_receivable', amount: money(500_000n) },
        { accountId: 'merchant_revenue', amount: money(-400_000n) },
      ]),
      UnbalancedTransactionError,
    );
  });

  /**
   * The application check is a courtesy. The claim that matters is that the *database*
   * refuses, so this writes the entries the way a rogue script would — one statement at a
   * time, no application code involved — and expects COMMIT to be the thing that says no.
   */
  test('the database refuses an unbalanced transaction even when the app is bypassed', async () => {
    const id = `test:raw:${randomUUID()}`;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO ledger_transactions (transaction_id, source, reference, occurred_at, recorded_at)
              VALUES ($1, 'test', $1, now(), now())`,
        [id],
      );
      await client.query(
        `INSERT INTO entries (entry_id, transaction_id, ordinal, account_id, amount_kobo, currency)
              VALUES ($1, $2, 0, 'bank_account', 12345, 'NGN')`,
        [`${id}#0`, id],
      );
      await assert.rejects(client.query('COMMIT'), /LAW_1_VIOLATION/);
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
  });

  test('entries cannot be updated or deleted', async () => {
    await assert.rejects(pool.query('UPDATE entries SET amount_kobo = 0'), /LAW_2_VIOLATION/);
    await assert.rejects(pool.query('DELETE FROM entries'), /LAW_2_VIOLATION/);
  });

  test('posting the same event twice changes nothing', async () => {
    const id = `test:idem:${randomUUID()}`;
    const entries: EntryInput[] = [
      { accountId: 'psp_receivable', amount: money(750_000n) },
      { accountId: 'merchant_revenue', amount: money(-750_000n) },
    ];

    const before = (await allBalances(pool)).get('psp_receivable')!;
    assert.equal((await post(entries, id)).outcome, 'posted');
    const afterFirst = (await allBalances(pool)).get('psp_receivable')!;
    assert.equal((await post(entries, id)).outcome, 'duplicate');
    const afterSecond = (await allBalances(pool)).get('psp_receivable')!;

    assert.equal(afterFirst.kobo, before.kobo + 750_000n);
    assert.equal(afterSecond.kobo, afterFirst.kobo, 'the redelivery moved money');
  });

  test('a reversal cancels the original without touching it', async () => {
    const id = `test:rev:${randomUUID()}`;
    await post(
      [
        { accountId: 'psp_receivable', amount: money(300_000n) },
        { accountId: 'merchant_revenue', amount: money(-300_000n) },
      ],
      id,
    );

    const before = (await allBalances(pool)).get('psp_receivable')!;
    await reverse(pool, id, new Date('2026-08-15T12:00:00Z'));
    const after = (await allBalances(pool)).get('psp_receivable')!;

    assert.equal(after.kobo, before.kobo - 300_000n);

    const original = await getTransaction(pool, id);
    assert.equal(original?.state, 'reversed');
    assert.equal(original?.entries.length, 2, 'the original entries are untouched');
    assert.equal(original?.entries[0]?.amount.kobo, 300_000n);
  });

  test('reversing twice does not refund twice', async () => {
    const id = `test:rev2:${randomUUID()}`;
    await post(
      [
        { accountId: 'psp_receivable', amount: money(100_000n) },
        { accountId: 'merchant_revenue', amount: money(-100_000n) },
      ],
      id,
    );

    await reverse(pool, id, new Date('2026-08-15T12:00:00Z'));
    const between = (await allBalances(pool)).get('psp_receivable')!;
    const second = await reverse(pool, id, new Date('2026-08-15T13:00:00Z'));
    const after = (await allBalances(pool)).get('psp_receivable')!;

    assert.equal(second.outcome, 'duplicate');
    assert.equal(after.kobo, between.kobo);
  });

  test('terminal states are terminal', async () => {
    const id = `test:state:${randomUUID()}`;
    await post(
      [
        { accountId: 'psp_receivable', amount: money(200_000n) },
        { accountId: 'merchant_revenue', amount: money(-200_000n) },
      ],
      id,
    );

    await transition(pool, { transactionId: id, to: 'settled', at: new Date(), causedBy: null });
    assert.equal(await currentState(pool, id), 'settled');

    // Re-applying is a no-op, so a retried reconciliation run is safe.
    const repeat = await transition(pool, {
      transactionId: id,
      to: 'settled',
      at: new Date(),
      causedBy: null,
    });
    assert.equal(repeat.outcome, 'unchanged');

    await assert.rejects(
      transition(pool, { transactionId: id, to: 'reversed', at: new Date(), causedBy: null }),
      /cannot move from settled/,
    );
  });

  /**
   * Phase 1's exit criterion.
   *
   * Across many random *valid* transactions, two things must hold without exception:
   * every account's cached balance equals the balance recomputed from its entries
   * (Law 6), and every entry ever written still sums to zero (Law 1 at the scale of the
   * whole ledger). Random amounts, random accounts, random shapes — the invariants do
   * not get to depend on the data being convenient.
   */
  test('cached balances always equal recomputed balances', async () => {
    // ~150 runs of up to 15 transactions each is well over a thousand postings, which is
    // the scale at which a drifting cache reliably shows itself. Raise it when you have
    // reason to distrust something; the invariant does not get cheaper to satisfy.
    const runs = Number(process.env['LEDGER_PROPERTY_RUNS'] ?? 150);

    const balancedEntries = fc
      .array(
        fc.record({
          accountId: fc.constantFrom(...(ACCOUNT_IDS as readonly AccountId[])),
          kobo: fc.bigInt({ min: -50_000_000n, max: 50_000_000n }),
        }),
        { minLength: 1, maxLength: 5 },
      )
      .map((legs) => {
        // Whatever the random legs came to, one closing entry brings it to zero — which
        // is how a real posting is built, rather than a coincidence we filtered for.
        const total = legs.reduce((acc, leg) => acc + leg.kobo, 0n);
        return [
          ...legs.map((leg) => ({ accountId: leg.accountId, amount: money(leg.kobo) })),
          { accountId: 'suspense' as AccountId, amount: money(-total) },
        ];
      });

    await fc.assert(
      fc.asyncProperty(fc.array(balancedEntries, { minLength: 1, maxLength: 15 }), async (batch) => {
        for (const entries of batch) await post(entries);

        assert.deepEqual(await verifyBalances(pool), [], 'the cache drifted from the entries');
        assert.equal((await verifyConservation(pool)).kobo, 0n, 'the books stopped balancing');
      }),
      { numRuns: runs },
    );
  });
});
