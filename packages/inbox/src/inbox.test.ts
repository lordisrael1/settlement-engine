import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';

import type { Pool } from 'pg';

import { createPool, LEDGER_MIGRATIONS_DIR, runMigrations } from '@recon/ledger-core';

import {
  accept,
  deliveryAt,
  deliveryId,
  drain,
  inboxDepth,
  inboxOriginals,
  redactInboxOriginals,
  retryAfter,
  INBOX_MIGRATIONS_DIR,
  type DeliveryHandler,
  type Redactor,
} from './inbox.js';

/**
 * The claims here are about what the *database* does — a conflicting insert, a claimed row,
 * an attempt counter that survives a rolled-back transaction — so they are made against a
 * real Postgres. A mock of a queue would only ever agree with the queue we imagined.
 *
 *   docker compose up -d postgres
 *   DATABASE_URL=postgres://recon:recon@localhost:5432/recon npm test
 */
const DATABASE_URL = process.env['DATABASE_URL'];
const AT = new Date('2026-08-17T09:00:00Z');

describe('the webhook inbox', { skip: DATABASE_URL ? false : 'set DATABASE_URL to run' }, () => {
  let pool: Pool;

  /** A schema of this suite's own, so the other DB suites' weather is not measured here. */
  before(async () => {
    const schema = `inbox_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
    const bootstrap = createPool(DATABASE_URL);
    await bootstrap.query(`CREATE SCHEMA ${schema}`);
    await bootstrap.end();

    const url = new URL(DATABASE_URL!);
    url.searchParams.set('options', `-c search_path=${schema}`);
    pool = createPool(url.toString());

    await runMigrations(pool, [LEDGER_MIGRATIONS_DIR, INBOX_MIGRATIONS_DIR]);
  });

  after(async () => {
    await pool.end();
  });

  /** Each test invents its own source so the drains cannot see each other's deliveries. */
  const scenario = () => `src-${randomUUID().slice(0, 8)}`;

  const booked = (id: string): DeliveryHandler =>
    async () => ({ state: 'processed', transactionId: id, detail: 'posted' });

  test('the delivery id is the bytes, so a redelivery is one row', async () => {
    const source = scenario();
    const body = Buffer.from('{"event":"charge.success"}', 'utf8');

    const first = await accept(pool, { source, headers: { a: '1' }, rawBody: body, receivedAt: AT });
    const again = await accept(pool, {
      source,
      // Different headers, different receipt time, same bytes: the provider retrying.
      headers: { a: '2' },
      rawBody: body,
      receivedAt: new Date(AT.getTime() + 60_000),
    });

    assert.equal(first.duplicate, false);
    assert.equal(again.duplicate, true);
    assert.equal(again.deliveryId, first.deliveryId);
    assert.equal(first.deliveryId, deliveryId(source, body));

    // The first delivery's headers and receipt time stand. A redelivery does not rewrite
    // what we recorded of the original — the evidence half of the row is append-only in
    // practice even though the column is not.
    const stored = await deliveryAt(pool, first.deliveryId);
    assert.equal(stored?.receivedAt.getTime(), AT.getTime());
  });

  test('the same bytes from two sources are two deliveries', async () => {
    const body = Buffer.from('{"ref":"shared"}', 'utf8');
    const a = await accept(pool, { source: scenario(), headers: {}, rawBody: body, receivedAt: AT });
    const b = await accept(pool, { source: scenario(), headers: {}, rawBody: body, receivedAt: AT });

    assert.notEqual(a.deliveryId, b.deliveryId);
  });

  test('a drained delivery carries what it became', async () => {
    const source = scenario();
    const accepted = await accept(pool, {
      source,
      headers: { 'x-signature': 'abc' },
      rawBody: Buffer.from('{"amount":1000}', 'utf8'),
      receivedAt: AT,
    });

    // Counts the deliveries the earlier tests left pending too, which is the point of a
    // queue: a pass works whatever is there, not whatever this test just put there.
    const report = await drain(pool, booked('txn:1'), { at: AT, limit: 10 });
    assert.equal(report.processed >= 1, true);

    const stored = await deliveryAt(pool, accepted.deliveryId);
    assert.equal(stored?.state, 'processed');
    assert.equal(stored?.transactionId, 'txn:1');
    assert.equal(stored?.processedAt?.getTime(), AT.getTime());

    // Nothing is left to do, and a second pass says so rather than working it again.
    const second = await drain(pool, booked('txn:2'), { at: AT, limit: 10 });
    assert.equal(second.claimed, 0);
    assert.equal((await deliveryAt(pool, accepted.deliveryId))?.transactionId, 'txn:1');
  });

  test('the handler writes in the delivery’s own transaction', async () => {
    const source = scenario();
    const accepted = await accept(pool, {
      source,
      headers: {},
      rawBody: Buffer.from('{"joined":true}', 'utf8'),
      receivedAt: AT,
    });

    // A row written by the handler and the state change that records it either both land or
    // neither does. Asserted by writing something in the handler and finding it afterwards
    // beside a delivery marked processed — the pair is the invariant, not either half.
    const handler: DeliveryHandler = async (delivery, db) => {
      await db.query(
        `INSERT INTO ledger_transactions (transaction_id, source, reference, occurred_at, recorded_at)
              VALUES ($1, $2, $3, $4, $4)`,
        [`inbox-test:${delivery.deliveryId.slice(0, 8)}`, delivery.source, 'joined', AT],
      );
      return { state: 'processed', transactionId: `inbox-test:${delivery.deliveryId.slice(0, 8)}`, detail: 'posted' };
    };

    await drain(pool, handler, { at: AT, limit: 10 });

    const stored = await deliveryAt(pool, accepted.deliveryId);
    const written = await pool.query('SELECT 1 FROM ledger_transactions WHERE transaction_id = $1', [
      stored?.transactionId,
    ]);
    assert.equal(stored?.state, 'processed');
    assert.equal(written.rowCount, 1);
  });

  test('ignored and rejected are terminal, and say why', async () => {
    const source = scenario();
    const ignored = await accept(pool, {
      source,
      headers: {},
      rawBody: Buffer.from('{"event":"transfer.success"}', 'utf8'),
      receivedAt: AT,
    });
    const rejected = await accept(pool, {
      source,
      headers: {},
      rawBody: Buffer.from('{"event":"charge.success","data":null}', 'utf8'),
      receivedAt: new Date(AT.getTime() + 1000),
    });

    const report = await drain(
      pool,
      async (delivery) =>
        delivery.deliveryId === ignored.deliveryId
          ? { state: 'ignored', detail: 'debit event — money leaving' }
          : { state: 'rejected', detail: 'no data object' },
      { at: AT, limit: 10 },
    );

    assert.equal(report.ignored, 1);
    assert.equal(report.rejected, 1);
    assert.equal((await deliveryAt(pool, ignored.deliveryId))?.detail, 'debit event — money leaving');
    // Neither is retried: a provider event we have no use for, redelivered by us to
    // ourselves every second, is an infinite loop with a log file.
    assert.equal((await drain(pool, booked('never'), { at: AT, limit: 10 })).claimed, 0);
  });

  test('a delivery that keeps throwing is retried, then handed to a human', async () => {
    const source = scenario();
    const accepted = await accept(pool, {
      source,
      headers: {},
      rawBody: Buffer.from('{"poison":true}', 'utf8'),
      receivedAt: AT,
    });

    const throwing: DeliveryHandler = async () => {
      throw new Error('the ledger is unreachable');
    };

    // The attempt counter must survive the rolled-back transaction that incremented
    // nothing — without that, a delivery that always throws is claimed forever with
    // `attempts` stuck at zero and never becomes anybody's problem.
    const first = await drain(pool, throwing, { at: AT, limit: 1, maxAttempts: 2 });
    assert.equal(first.retrying, 1);
    assert.equal((await deliveryAt(pool, accepted.deliveryId))?.attempts, 1);

    // …and it must not burn the next attempt in the same second. A pass at the same instant
    // finds nothing claimable, which is the whole of the backoff: a transient failure gets
    // time to stop being one instead of consuming eight attempts in four seconds.
    const immediately = await drain(pool, throwing, { at: AT, limit: 1, maxAttempts: 2 });
    assert.equal(immediately.claimed, 0);
    assert.equal(immediately.deferred, 1);

    const later = new Date(AT.getTime() + 60_000);
    const second = await drain(pool, throwing, { at: later, limit: 1, maxAttempts: 2 });
    assert.equal(second.failed, 1);

    const stored = await deliveryAt(pool, accepted.deliveryId);
    assert.equal(stored?.state, 'failed');
    assert.match(stored?.lastError ?? '', /ledger is unreachable/);

    // Failed means nobody tries again without a person, and the bytes are still here.
    assert.equal((await drain(pool, throwing, { at: later, limit: 5, maxAttempts: 2 })).claimed, 0);
    assert.equal((await inboxDepth(pool)).failed >= 1, true);
  });

  test('the retry delay grows, and two workers compute the same one', async () => {
    // Deterministic, and derived from the delivery id rather than a random source. Two
    // workers must agree about when a row becomes claimable again, or a redrained queue is
    // not reproducible — which is this package's whole claim.
    const id = 'a'.repeat(62) + '80';
    assert.equal(retryAfter(1, id), retryAfter(1, id));
    assert.ok(retryAfter(2, id) > retryAfter(1, id));
    assert.ok(retryAfter(3, id) > retryAfter(2, id));

    // Capped, so a delivery that has failed twenty times is not scheduled for next week.
    assert.ok(retryAfter(20, id) <= 300_000 * 1.125);

    // Jittered, so a thousand deliveries that failed together do not return together.
    assert.notEqual(retryAfter(4, 'b'.repeat(62) + '00'), retryAfter(4, 'b'.repeat(62) + 'ff'));

    // Eight attempts must span minutes, not the four seconds a fixed interval gave them.
    let total = 0;
    for (let attempt = 1; attempt <= 8; attempt += 1) total += retryAfter(attempt, id);
    assert.ok(total > 4 * 60_000, `eight attempts spanned only ${total}ms`);
  });

  test('a delivery that throws once is worked on the next pass', async () => {
    const source = scenario();
    const accepted = await accept(pool, {
      source,
      headers: {},
      rawBody: Buffer.from('{"transient":true}', 'utf8'),
      receivedAt: AT,
    });

    let attempts = 0;
    const flaky: DeliveryHandler = async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('connection reset');
      return { state: 'processed', transactionId: 'txn:recovered', detail: 'posted' };
    };

    await drain(pool, flaky, { at: AT, limit: 1, maxAttempts: 5 });
    // The next pass, a minute later. Same instant would find it still backing off — see the
    // test above; here the point is that the recovery happens on its own, with no person.
    await drain(pool, flaky, { at: new Date(AT.getTime() + 60_000), limit: 1, maxAttempts: 5 });

    const stored = await deliveryAt(pool, accepted.deliveryId);
    assert.equal(stored?.state, 'processed');
    assert.equal(stored?.transactionId, 'txn:recovered');
    // Cleared when the delivery finally worked: a stale error beside a processed delivery
    // is a support ticket about a problem that fixed itself.
    assert.equal(stored?.lastError, null);
  });

  test('two workers draining at once never work the same delivery twice', async () => {
    const source = scenario();
    for (let i = 0; i < 6; i += 1) {
      await accept(pool, {
        source,
        headers: {},
        rawBody: Buffer.from(`{"n":${i}}`, 'utf8'),
        receivedAt: new Date(AT.getTime() + i),
      });
    }

    const worked: string[] = [];
    const record: DeliveryHandler = async (delivery) => {
      worked.push(delivery.deliveryId);
      return { state: 'processed', transactionId: `txn:${delivery.deliveryId.slice(0, 6)}`, detail: 'posted' };
    };

    // `FOR UPDATE SKIP LOCKED` is the whole of the coordination between workers: they do
    // not queue behind each other and they do not collide, so scaling is starting more.
    const [a, b] = await Promise.all([
      drain(pool, record, { at: AT, limit: 6 }),
      drain(pool, record, { at: AT, limit: 6 }),
    ]);

    assert.equal(a.claimed + b.claimed, 6);
    assert.equal(new Set(worked).size, 6);
  });
  // ── Redaction ─────────────────────────────────────────────────────────────
  //
  // The claims here are about *when* the original stops existing, which is a claim about a
  // transaction boundary and therefore only checkable against a real database.

  /** A stand-in for the keep-list: everything but the reference goes. */
  const keepReference: Redactor = (delivery) => {
    const body = JSON.parse(delivery.rawBody.toString('utf8')) as { reference?: string };
    return {
      bytes: Buffer.from(JSON.stringify({ reference: body.reference }), 'utf8'),
      dropped: 3,
    };
  };

  const rawOf = async (id: string): Promise<{ raw: string; content: string; at: Date | null }> => {
    const result = await pool.query<{ raw: Buffer; content: string; redacted_at: Date | null }>(
      'SELECT raw, content, redacted_at FROM webhook_inbox WHERE delivery_id = $1',
      [id],
    );
    const row = result.rows[0]!;
    return { raw: row.raw.toString('utf8'), content: row.content, at: row.redacted_at };
  };

  test('a worked delivery keeps its meaning and loses the customer', async () => {
    const source = scenario();
    const body = Buffer.from(
      JSON.stringify({ reference: 'PSK_1', email: 'amaka@example.com', ip: '102.89.34.11' }),
      'utf8',
    );
    const accepted = await accept(pool, { source, headers: {}, rawBody: body, receivedAt: AT });

    await drain(pool, booked('txn:1'), { at: AT, limit: 1, redact: keepReference });

    const stored = await rawOf(accepted.deliveryId);
    assert.equal(stored.content, 'redacted');
    assert.equal(stored.at?.getTime(), AT.getTime());
    assert.ok(!stored.raw.includes('amaka@example.com'));
    assert.ok(stored.raw.includes('PSK_1'));

    // The delivery id is unchanged and still names the original bytes. It is the hash of
    // what arrived, and what arrived did arrive — the payload is gone, not the fact of it.
    assert.equal(accepted.deliveryId, deliveryId(source, body));
    const delivery = await deliveryAt(pool, accepted.deliveryId);
    assert.equal(delivery?.state, 'processed');
  });

  test('a delivery that threw keeps its bytes, because it will be verified again', async () => {
    const source = scenario();
    const accepted = await accept(pool, {
      source,
      headers: {},
      rawBody: Buffer.from(JSON.stringify({ reference: 'PSK_2', email: 'tunde@example.com' }), 'utf8'),
      receivedAt: AT,
    });

    const throwing: DeliveryHandler = async () => {
      throw new Error('the ledger is unreachable');
    };
    await drain(pool, throwing, { at: AT, limit: 1, maxAttempts: 5, redact: keepReference });

    // Redacting here would leave a pending delivery whose signature can never be checked
    // again — the drain re-verifies on every attempt.
    const stored = await rawOf(accepted.deliveryId);
    assert.equal(stored.content, 'original');
    assert.ok(stored.raw.includes('tunde@example.com'));
  });

  test('the sweep catches what the drain will never work', async () => {
    const source = scenario();
    const old = new Date(AT.getTime() - 60 * 24 * 60 * 60 * 1000);
    const accepted = await accept(pool, {
      source,
      headers: {},
      rawBody: Buffer.from(JSON.stringify({ reference: 'PSK_3', email: 'ngozi@example.com' }), 'utf8'),
      receivedAt: old,
    });

    const before = await inboxOriginals(pool);
    assert.ok(before.originals >= 1);

    const swept = await redactInboxOriginals(pool, {
      before: new Date(AT.getTime() - 30 * 24 * 60 * 60 * 1000),
      at: AT,
      redact: keepReference,
    });

    assert.ok(swept.redacted >= 1);
    const stored = await rawOf(accepted.deliveryId);
    assert.equal(stored.content, 'redacted');
    assert.ok(!stored.raw.includes('ngozi@example.com'));
  });

  test('a redaction already done is not done again', async () => {
    // The sweep is a cron job, and a cron job runs. Its query selects on content, so a
    // second pass over an already-redacted inbox finds nothing rather than re-writing rows.
    const swept = await redactInboxOriginals(pool, {
      before: new Date(AT.getTime() - 30 * 24 * 60 * 60 * 1000),
      at: AT,
      redact: keepReference,
    });
    assert.equal(swept.redacted, 0);
  });
});
