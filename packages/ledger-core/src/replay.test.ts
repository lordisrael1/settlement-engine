import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';

import type { Pool } from 'pg';

import { foldBalances, money } from '@recon/canon';

import {
  bookAuthorizedPayment,
  bookChargeback,
  bookReversal,
} from './bookings.js';
import { countEvents, eventsAbout, readEvents } from './events.js';
import { LEDGER_MIGRATIONS_DIR, runMigrations } from './migrate.js';
import { createPool } from './pool.js';
import { postTransaction } from './post.js';
import { rebuildBalancesFromEvents, replay } from './replay.js';

/**
 * The proof, exercised.
 *
 * Everything else asserts that the books are right. These assert that the books can be
 * *rebuilt* — and that three independently written records of the same truth agree.
 *
 *   docker compose up -d postgres
 *   DATABASE_URL=postgres://recon:recon@localhost:5432/recon npm test
 */
const DATABASE_URL = process.env['DATABASE_URL'];

const AT = new Date('2026-08-12T09:00:00Z');

describe('replay', { skip: DATABASE_URL ? false : 'set DATABASE_URL to run' }, () => {
  let pool: Pool;

  /** Its own schema: a replay is a statement about *everything*, so it cannot share one. */
  before(async () => {
    const schema = `replay_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
    const bootstrap = createPool(DATABASE_URL);
    await bootstrap.query(`CREATE SCHEMA ${schema}`);
    await bootstrap.end();

    const url = new URL(DATABASE_URL!);
    url.searchParams.set('options', `-c search_path=${schema}`);
    pool = createPool(url.toString());

    await runMigrations(pool, [LEDGER_MIGRATIONS_DIR]);
  });

  after(async () => {
    await pool.end();
  });

  const payment = (id: string, gross: bigint, source = 'alpha') =>
    bookAuthorizedPayment(
      pool,
      {
        reference: id,
        source,
        gross: money(gross),
        status: 'SUCCESSFUL',
        channel: 'card',
        occurredAt: AT,
        idempotencyKey: id,
      },
      AT,
    );

  /**
   * Delete the projection, fold the log from event zero, and the numbers come back.
   */
  test('deleting the balances and replaying the log reproduces them exactly', async () => {
    await payment('replay-pay-1', 1_000_000n);
    await payment('replay-pay-2', 250_000n);
    await bookReversal(
      pool,
      { key: 'replay-rev-1', source: 'alpha', reference: 'replay-pay-2', at: AT },
      { transactionId: 'replay-pay-2', receivable: money(250_000n), amount: money(250_000n) },
    );

    const before = await replay(pool);
    assert.equal(before.agrees, true, JSON.stringify(before.drift));

    const rebuilt = await rebuildBalancesFromEvents(pool);
    assert.equal(rebuilt.agrees, true, JSON.stringify(rebuilt.drift));
    assert.deepEqual([...rebuilt.balances], [...before.balances]);

    // And the numbers are the ones the entries say, not merely self-consistent ones.
    assert.equal(rebuilt.balances.get('psp_receivable'), 1_000_000n);
    assert.equal(rebuilt.balances.get('merchant_revenue'), -1_250_000n);
    assert.equal(rebuilt.balances.get('reversals'), 250_000n);
  });

  /**
   * The check that makes agreement evidence rather than tautology.
   *
   * When the log is the only writer, replaying it can only reproduce itself. Here the
   * entries and the log are written by different code in the same transaction, so a
   * divergence is detectable — and this proves the detector actually detects.
   */
  test('a projection that drifts from the log is caught, not smoothed over', async () => {
    await payment('replay-pay-3', 400_000n);
    assert.equal((await replay(pool)).agrees, true);

    // Corrupt the cache the way a bad migration or a rogue script would. It is a cache and
    // is deliberately not append-only protected, which is exactly why it needs checking.
    await pool.query(
      `UPDATE account_balances SET balance_kobo = balance_kobo + 100 WHERE account_id = 'psp_receivable'`,
    );

    const drifted = await replay(pool);
    assert.equal(drifted.agrees, false);
    assert.equal(drifted.drift[0]?.what, 'balance');
    assert.equal(drifted.drift[0]?.key, 'psp_receivable');

    // The entries still agree with the log — which localises the fault to the cache rather
    // than leaving three suspects.
    assert.equal(drifted.drift.filter((entry) => entry.what === 'entries').length, 0);

    const repaired = await rebuildBalancesFromEvents(pool);
    assert.equal(repaired.agrees, true, 'the log is what puts it back');
  });

  /**
   * A transaction posted without narrating itself is invisible to the fold — so the fold
   * must notice. This is the check that stops the log quietly falling behind the ledger as
   * new booking functions are added.
   */
  test('entries written with no event are caught by the fold', async () => {
    await postTransaction(pool, {
      transactionId: 'replay-silent',
      source: 'alpha',
      reference: 'silent',
      occurredAt: AT,
      recordedAt: AT,
      initialState: 'settled',
      // No `event`: this transaction tells the log nothing about itself.
      entries: [
        { accountId: 'suspense', amount: money(50_000n) },
        { accountId: 'merchant_revenue', amount: money(-50_000n) },
      ],
    });

    const report = await replay(pool);
    assert.equal(report.agrees, false);
    assert.ok(
      report.drift.some((entry) => entry.what === 'entries' && entry.key === 'suspense'),
      'the entries hold money the log never mentioned',
    );
  });

  /** Append-only, on the record that proves every other record. */
  test('the log itself cannot be rewritten', async () => {
    await assert.rejects(
      pool.query(`UPDATE events SET type = 'ChargebackBooked'`),
      /LAW_2_VIOLATION/,
    );
    await assert.rejects(pool.query('DELETE FROM events'), /LAW_2_VIOLATION/);
  });

  /**
   * "Show me everything that happened to this money, in order" — the question the log
   * exists to answer, and one that previously meant joining six tables and hoping.
   */
  test('the log answers what happened to one thing, in order', async () => {
    await payment('replay-pay-4', 90_000n);
    await bookChargeback(
      pool,
      { key: 'replay-cb-1', source: 'alpha', reference: 'replay-pay-4', at: AT },
      money(90_000n),
    );

    assert.deepEqual(
      (await eventsAbout(pool, 'replay-pay-4')).map((event) => event.type),
      ['PaymentAuthorized'],
    );
    const clawback = await eventsAbout(pool, 'replay-cb-1');
    assert.equal(clawback[0]?.type, 'ChargebackBooked');
    // The edges of the trail: this event answers that one.
    assert.equal(clawback[0]?.causedBy, null);
    assert.equal(clawback[0]?.entries.length, 2);
  });

  /**
   * A retried request appends one happening, not two. The id is derived from the type and
   * the subject, so redelivery collides in the database rather than in a check-then-insert
   * window (idempotency, one level up from the ledger's own).
   */
  test('replaying the same happening twice appends one event', async () => {
    const before = await countEvents(pool);
    await payment('replay-pay-5', 10_000n);
    await payment('replay-pay-5', 10_000n);
    assert.equal(await countEvents(pool), before + 1);
  });

  /**
   * The log is read in numeric order, and paging over it visits each event exactly once.
   *
   * This is a regression test for a bug worth remembering. The select list casts `sequence`
   * to text so a `BIGINT` never rides through a JS number (integer kobo) — and an unqualified
   * `ORDER BY sequence` binds to that *output* column, sorting the log lexically as
   * 1, 10, 11, 2, 3. Paging over that order re-reads events 10 and up, folds them twice,
   * and produces a ledger that appears to have doubled. It passes unnoticed until the log
   * has more than nine events in it, which is to say until roughly ten minutes after
   * anybody starts using it.
   */
  test('the log pages in numeric order, visiting each event once', async () => {
    for (let index = 0; index < 12; index += 1) {
      await payment(`replay-page-${index}`, 1_000n);
    }

    const total = await countEvents(pool);
    const all = await readEvents(pool, { limit: 10_000 });
    assert.equal(all.length, total, 'one read returns the whole log');
    assert.deepEqual(
      all.map((event) => event.sequence),
      [...all.map((event) => event.sequence)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
      'and it comes back in numeric order',
    );

    // The paged fold — what `replay` actually does — must count every event exactly once.
    // Only the count is asserted here: an earlier test in this suite deliberately writes a
    // transaction with no event, so the books are *meant* to disagree by then, and folding
    // that in would make this test about the wrong thing.
    const report = await replay(pool);
    assert.equal(report.events, total, 'no event folded twice, none skipped');
  });

  /**
   * Determinism, at the scale of the whole system. The fold is a pure function of the log, so
   * folding it twice — or in pages, or in one go — must reach the same numbers.
   */
  test('the fold is a pure function of the log', async () => {
    const all = await readEvents(pool, { limit: 10_000 });
    const inOneGo = foldBalances(all);

    const inPages = new Map<string, bigint>();
    for (let index = 0; index < all.length; index += 3) {
      for (const [accountId, amount] of foldBalances(all.slice(index, index + 3))) {
        inPages.set(accountId, (inPages.get(accountId) ?? 0n) + amount);
      }
    }

    assert.deepEqual([...inPages].sort(), [...inOneGo].sort());
  });
});
