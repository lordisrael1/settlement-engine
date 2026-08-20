import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';

import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';

import { deliveryAt, drain, INBOX_MIGRATIONS_DIR } from '@recon/inbox';
import { createPool, LEDGER_MIGRATIONS_DIR, runMigrations } from '@recon/ledger-core';
import { RECONCILER_MIGRATIONS_DIR } from '@recon/reconciler';

import { buildApp } from './app.js';
import type { Config } from './config.js';
import { interpretDelivery } from './worker.js';

/**
 * The contract, exercised through the real router.
 *
 * `app.inject()` rather than a port: the request goes through the same parsers, hooks,
 * schemas and error handler a socket would reach, and the suite neither picks a port nor
 * races a listener on teardown. Neither of those difficulties has anything to do with
 * reconciliation.
 *
 * What is deliberately *not* mocked is the database. Every claim worth making here — that a
 * webhook survives being accepted, that a settlement report books nothing, that an
 * unapproved write-off is refused — is a claim about what the engine and Postgres do
 * together, and a mock would only ever agree with the design we already believe.
 *
 *   docker compose up -d postgres
 *   DATABASE_URL=postgres://recon:recon@localhost:5432/recon npm test
 */
const DATABASE_URL = process.env['DATABASE_URL'];

const NOW = new Date('2026-08-15T10:00:00Z');
const API_KEY = 'test-key-0123456789abcdef';
const PAYSTACK_SECRET = 'sk_test_api_suite_secret';
const FLUTTERWAVE_SECRET = 'flw_test_api_suite_hash';

const CONFIG: Config = {
  host: '127.0.0.1',
  port: 0,
  apiKey: API_KEY,
  merchantId: 'merchant-under-test',
  bankAccountId: 'gtb-3011',
  bank: 'gtbank',
  // Two of the four, so that "we have an adapter but no secret" is a state the suite can
  // actually reach — it is a 503, and it is the one webhook failure that is our fault.
  webhookSecret: (source) =>
    ({ paystack: PAYSTACK_SECRET, flutterwave: FLUTTERWAVE_SECRET })[source] ?? null,
  drain: { intervalMs: 1000, batch: 50, maxAttempts: 3 },
  limits: { webhookBytes: 256 * 1024, uploadBytes: 8 * 1024 * 1024 },
  reconcileLimit: 500,
};

/**
 * Signing the way each provider signs, because here the suite is standing in for four
 * remote systems that have no reason to agree with each other. Paystack uses HMAC-SHA512 in
 * hex and Flutterwave HMAC-SHA256 in base64 — which is exactly why verification lives in a
 * library and not in this layer's head.
 */
const sign = (raw: Buffer): string =>
  createHmac('sha512', PAYSTACK_SECRET).update(raw).digest('hex');

const signFlutterwave = (raw: Buffer): string =>
  createHmac('sha256', FLUTTERWAVE_SECRET).update(raw).digest('base64');

const charge = (reference: string, kobo: number) => ({
  event: 'charge.success',
  data: {
    id: 4210771,
    domain: 'live',
    status: 'success',
    reference,
    amount: kobo,
    gateway_response: 'Successful',
    paid_at: '2026-08-13T09:14:22.000Z',
    created_at: '2026-08-13T09:14:02.000Z',
    channel: 'card',
    currency: 'NGN',
    fees: 25000,
    customer: { id: 88213, email: 'amaka@example.com', customer_code: 'CUS_3kd91xzq0' },
    authorization: { authorization_code: 'AUTH_k2p9wz', last4: '4412', brand: 'verve' },
  },
});

/**
 * Three Flutterwave promises whose gross is exactly the settlement report's below — the
 * batch stage two has to discover by arithmetic, since Flutterwave names the movement and
 * not the charges inside it.
 */
const charged = (reference: string, naira: number) => ({
  type: 'charge.completed',
  webhook_id: `wbk_${reference}`,
  timestamp: 1_755_079_200_000,
  data: {
    id: `chg_${reference}`,
    amount: naira,
    currency: 'NGN',
    status: 'succeeded',
    reference,
    created_datetime: '2026-08-13T10:00:00.000Z',
    payment_method: { type: 'card' },
  },
});

const SETTLEMENT = {
  status: 'success',
  message: 'Settlements fetched',
  data: [
    {
      id: 'stm_apitest01',
      net_amount: 11832,
      gross_amount: 12000,
      currency: 'NGN',
      status: 'completed',
      due_datetime: '2026-08-14T09:00:00.000Z',
      transaction_datetime: '2026-08-13T14:22:10.000Z',
      fees: [
        { type: 'stamp_duty', amount: 50 },
        { type: 'charge_fee', amount: 118 },
      ],
      destination: 'bank',
      charge_count: '3',
      created_datetime: '2026-08-14T09:00:00.000Z',
    },
  ],
};

const STATEMENT = [
  {
    id: 'GTB-API-0001',
    date: '2026-08-14T14:05:00Z',
    amount: '7450.00',
    type: 'credit',
    narration: 'NIP TRF FROM ADEBAYO VENTURES LTD',
    balance: '7450.00',
  },
];

describe('the service', { skip: DATABASE_URL ? false : 'set DATABASE_URL to run' }, () => {
  let pool: Pool;
  let app: FastifyInstance;

  before(async () => {
    const schema = `api_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
    const bootstrap = createPool(DATABASE_URL);
    await bootstrap.query(`CREATE SCHEMA ${schema}`);
    await bootstrap.end();

    const url = new URL(DATABASE_URL!);
    url.searchParams.set('options', `-c search_path=${schema}`);
    pool = createPool(url.toString());

    await runMigrations(pool, [
      LEDGER_MIGRATIONS_DIR,
      RECONCILER_MIGRATIONS_DIR,
      INBOX_MIGRATIONS_DIR,
    ]);

    // The clock is an argument, so the suite owns it. Nothing here waits for a real day to
    // pass to find out whether a settlement window closed (determinism).
    app = buildApp({ pool, config: CONFIG, now: () => NOW });
    await app.ready();
  });

  after(async () => {
    await app.close();
    await pool.end();
  });

  const authed = (extra: Record<string, string> = {}) => ({ 'x-api-key': API_KEY, ...extra });

  /** The worker's own handler, run on demand rather than on its timer. */
  const work = () =>
    drain(pool, interpretDelivery(CONFIG, () => NOW), { at: NOW, limit: 50, maxAttempts: 3 });

  const balanceOf = async (accountId: string): Promise<bigint> => {
    const response = await app.inject({ method: 'GET', url: '/balances', headers: authed() });
    const body = response.json() as { balances: { accountId: string; kobo: string }[] };
    return BigInt(body.balances.find((entry) => entry.accountId === accountId)?.kobo ?? '0');
  };

  // ── The edge that answers without a credential ────────────────────────────

  test('health reports the database and how far behind the workers are', async () => {
    const response = await app.inject({ method: 'GET', url: '/health' });

    assert.equal(response.statusCode, 200);
    const body = response.json() as { status: string; inbox: { pending: number } };
    assert.equal(body.status, 'ok');
    // "Up" and "working" are different questions. An inbox whose pending count only grows
    // is a service accepting deliveries and quietly not working them, which a bare 200
    // would hide completely.
    assert.equal(typeof body.inbox.pending, 'number');
  });

  test('management needs a key; webhooks must not', async () => {
    const none = await app.inject({ method: 'GET', url: '/balances' });
    const wrong = await app.inject({
      method: 'GET',
      url: '/balances',
      headers: { 'x-api-key': 'not-the-key-aaaaaaaaaa' },
    });
    const right = await app.inject({ method: 'GET', url: '/balances', headers: authed() });

    assert.equal(none.statusCode, 401);
    assert.equal(wrong.statusCode, 401);
    assert.equal(right.statusCode, 200);
  });

  // ── The fast rail ─────────────────────────────────────────────────────────

  test('an unknown source is 404 and a source we hold no secret for is 503', async () => {
    const unknown = await app.inject({
      method: 'POST',
      url: '/webhooks/interswitch',
      payload: '{}',
      headers: { 'content-type': 'application/json' },
    });
    const unconfigured = await app.inject({
      method: 'POST',
      url: '/webhooks/nomba',
      payload: '{}',
      headers: { 'content-type': 'application/json' },
    });

    // "We have never heard of this provider" and "we are misconfigured for one we have"
    // lead to different phone calls.
    assert.equal(unknown.statusCode, 404);
    assert.equal(unconfigured.statusCode, 503);
  });

  test('an unsigned delivery is refused and nothing is stored', async () => {
    const body = JSON.stringify(charge('PSK_unsigned', 500_000));
    const response = await app.inject({
      method: 'POST',
      url: '/webhooks/paystack',
      payload: body,
      headers: { 'content-type': 'application/json', 'x-paystack-signature': 'deadbeef' },
    });

    assert.equal(response.statusCode, 401);
    const stored = await pool.query('SELECT 1 FROM webhook_inbox WHERE raw = $1', [
      Buffer.from(body, 'utf8'),
    ]);
    assert.equal(stored.rowCount, 0);
  });

  test('a signed delivery is accepted durably, and books nothing until a worker runs', async () => {
    const raw = Buffer.from(JSON.stringify(charge('PSK_api_001', 1_000_000)), 'utf8');

    const accepted = await app.inject({
      method: 'POST',
      url: '/webhooks/paystack',
      payload: raw,
      headers: { 'content-type': 'application/json', 'x-paystack-signature': sign(raw) },
    });

    assert.equal(accepted.statusCode, 200);
    const { deliveryId, duplicate } = accepted.json() as {
      deliveryId: string;
      duplicate: boolean;
    };
    assert.equal(duplicate, false);

    // The promise made to the provider is "we have this", and it is kept by a row rather
    // than by a booking. Nothing has reached the books yet, on purpose.
    const pending = await deliveryAt(pool, deliveryId);
    assert.equal(pending?.state, 'pending');
    assert.equal(pending?.transactionId, null);
    assert.equal(await balanceOf('psp_receivable'), 0n);

    // The redelivery every provider guarantees: same bytes, same id, nothing written.
    const again = await app.inject({
      method: 'POST',
      url: '/webhooks/paystack',
      payload: raw,
      headers: { 'content-type': 'application/json', 'x-paystack-signature': sign(raw) },
    });
    assert.equal(again.statusCode, 200);
    assert.equal((again.json() as { duplicate: boolean }).duplicate, true);

    // …and then the worker gives it meaning.
    const report = await work();
    assert.equal(report.processed, 1);

    const worked = await deliveryAt(pool, deliveryId);
    assert.equal(worked?.state, 'processed');
    assert.notEqual(worked?.transactionId, null);

    // Revenue at gross, the receivable open, and no fee booked — the fee is not knowable
    // yet, and a guess in the books is a correction waiting to happen (ADR-0004).
    assert.equal(await balanceOf('psp_receivable'), 1_000_000n);
    assert.equal(await balanceOf('merchant_revenue'), -1_000_000n);
    assert.equal(await balanceOf('fees_expense'), 0n);
    assert.equal(await balanceOf('bank_account'), 0n);

    const delivery = await app.inject({
      method: 'GET',
      url: `/deliveries/${deliveryId}`,
      headers: authed(),
    });
    assert.equal(delivery.statusCode, 200);
    assert.equal((delivery.json() as { state: string }).state, 'processed');
  });

  test('an authentic delivery we cannot book reaches a terminal state, and books nothing', async () => {
    const before = await balanceOf('psp_receivable');
    // Authentic, well-formed enough to be signed, and not a promise of money: whatever the
    // connector makes of it, the one thing that must not happen is a ledger entry.
    const raw = Buffer.from(JSON.stringify({ event: 'charge.success', data: {} }), 'utf8');

    const accepted = await app.inject({
      method: 'POST',
      url: '/webhooks/paystack',
      payload: raw,
      headers: { 'content-type': 'application/json', 'x-paystack-signature': sign(raw) },
    });
    assert.equal(accepted.statusCode, 200);

    await work();

    const worked = await deliveryAt(pool, (accepted.json() as { deliveryId: string }).deliveryId);
    assert.notEqual(worked?.state, 'pending');
    assert.notEqual(worked?.state, 'processed');
    // Whatever it was, it is written down with a reason rather than dropped.
    assert.equal(typeof worked?.detail, 'string');
    assert.equal(await balanceOf('psp_receivable'), before);
  });

  test('a different provider, a different signature scheme, the same canonical promise', async () => {
    const before = await balanceOf('psp_receivable');

    for (const [reference, naira] of [
      ['ORD-4417', 5500],
      ['ORD-4418', 4000],
      ['ORD-4419', 2500],
    ] as const) {
      const raw = Buffer.from(JSON.stringify(charged(reference, naira)), 'utf8');
      const response = await app.inject({
        method: 'POST',
        url: '/webhooks/flutterwave',
        payload: raw,
        headers: { 'content-type': 'application/json', 'flutterwave-signature': signFlutterwave(raw) },
      });
      assert.equal(response.statusCode, 200);
    }

    const report = await work();
    assert.equal(report.processed, 3);

    // Nothing above this line knew which provider it was talking to except the connector.
    // Amounts in naira there, kobo here — converted once, at the boundary (integer kobo).
    assert.equal(await balanceOf('psp_receivable'), before + 1_200_000n);
  });

  // ── The slow rails ────────────────────────────────────────────────────────

  test('a source with no settlement adapter is 501, not a guess', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/ingest/settlement/paystack',
      payload: JSON.stringify(SETTLEMENT),
      headers: authed({ 'content-type': 'application/json' }),
    });

    // Paystack's export has no fixture-verified column layout, so there is no parser.
    // Inventing one produces a parser that looks right and books the wrong amounts (ADR-0025).
    assert.equal(response.statusCode, 501);
  });

  test('a settlement report is stored, hashed, and books nothing', async () => {
    const before = await balanceOf('bank_account');

    const response = await app.inject({
      method: 'POST',
      url: '/ingest/settlement/flutterwave?filename=flw-api-test.json',
      payload: JSON.stringify(SETTLEMENT),
      headers: authed({ 'content-type': 'application/json', 'x-recon-operator': 'amaka@example.com' }),
    });

    assert.equal(response.statusCode, 201);
    const body = response.json() as {
      evidenceId: string;
      payouts: { stored: number; duplicates: number };
    };
    assert.equal(body.payouts.stored, 1);
    assert.equal(await balanceOf('bank_account'), before);

    // Content-addressed: the same export again is one evidence record and no new rows.
    const reuploaded = await app.inject({
      method: 'POST',
      url: '/ingest/settlement/flutterwave',
      payload: JSON.stringify(SETTLEMENT),
      headers: authed({ 'content-type': 'application/json' }),
    });
    const second = reuploaded.json() as {
      evidenceId: string;
      payouts: { stored: number; duplicates: number };
    };
    assert.equal(second.evidenceId, body.evidenceId);
    assert.equal(second.payouts.stored, 0);
    assert.equal(second.payouts.duplicates, 1);

    // The uploader is recorded, because "who put this in front of us" is one of the
    // questions actually asked six months later (ADR-0033).
    const evidence = await pool.query<{ received_from: string; filename: string | null }>(
      'SELECT received_from, filename FROM evidence WHERE evidence_id = $1',
      [body.evidenceId],
    );
    assert.equal(evidence.rows[0]?.received_from, 'amaka@example.com');
    assert.equal(evidence.rows[0]?.filename, 'flw-api-test.json');
  });

  test('a bank statement is stored, and is still not cash until the matcher says so', async () => {
    const before = await balanceOf('bank_account');

    const response = await app.inject({
      method: 'POST',
      url: '/ingest/bank?account=gtb-3011&bank=gtbank',
      payload: JSON.stringify(STATEMENT),
      headers: authed({ 'content-type': 'application/json' }),
    });

    assert.equal(response.statusCode, 201);
    assert.equal((response.json() as { lines: { stored: number } }).lines.stored, 1);
    assert.equal(await balanceOf('bank_account'), before);
  });

  test('an empty upload is a 400, not an empty evidence record', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/ingest/bank',
      payload: '',
      headers: authed({ 'content-type': 'application/octet-stream' }),
    });

    assert.equal(response.statusCode, 400);
  });

  // ── Matching, and the queue it fills ──────────────────────────────────────

  test('a run reports what it concluded and what it could not', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/reconcile/runs',
      headers: authed(),
    });

    assert.equal(response.statusCode, 201);
    const run = response.json() as {
      asOf: string;
      exceptions: { reason: string; count: number }[];
      failures: unknown[];
      queue: { raised: number };
    };
    assert.equal(new Date(run.asOf).getTime(), NOW.getTime());
    assert.deepEqual(run.failures, []);
    // A credit naming a payout we hold no promises for cannot be identified, and the
    // matcher escalates rather than guessing (ADR-0035).
    assert.equal(run.exceptions.length > 0, true);
    assert.equal(run.queue.raised > 0, true);
  });

  test('the queue is readable, worst first, with the working attached', async () => {
    const response = await app.inject({ method: 'GET', url: '/exceptions', headers: authed() });

    assert.equal(response.statusCode, 200);
    const { exceptions } = response.json() as {
      exceptions: { key: string; reason: string; considered: unknown[] }[];
    };
    assert.equal(exceptions.length > 0, true);
    assert.equal(Array.isArray(exceptions[0]?.considered), true);

    const detail = await app.inject({
      method: 'GET',
      url: `/exceptions/${encodeURIComponent(exceptions[0]!.key)}`,
      headers: authed(),
    });
    assert.equal(detail.statusCode, 200);
    // Nothing was ever overwritten, so the history is the whole story.
    assert.equal((detail.json() as { history: unknown[] }).history.length > 0, true);
  });

  test('a summary counts the three buckets and the money still in the air', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/reconciliation/summary?from=2026-08-01T00:00:00Z&to=2026-08-31T00:00:00Z`,
      headers: authed(),
    });

    assert.equal(response.statusCode, 200);
    const summary = response.json() as {
      totals: { match: number; explanation: number; exception: number };
      awaitingBankCredit: { count: number; expectedNet: { kobo: string } };
    };
    assert.equal(typeof summary.totals.match, 'number');
    // Reported by a PSP and not yet seen by the bank: neither matched nor missing, and the
    // number a two-way reconciliation cannot express at all.
    assert.equal(summary.awaitingBankCredit.count >= 1, true);
    assert.equal(typeof summary.awaitingBankCredit.expectedNet.kobo, 'string');
  });

  test('a bad date is a 400', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/reconciliation/summary?from=last%20tuesday',
      headers: authed(),
    });
    assert.equal(response.statusCode, 400);
  });

  // ── The one write a human makes ───────────────────────────────────────────

  test('resolving refuses self-approval, refuses to touch cash, and then works', async () => {
    const queue = await app.inject({ method: 'GET', url: '/exceptions', headers: authed() });
    const item = (queue.json() as { exceptions: { key: string; subject: string }[] }).exceptions[0]!;

    const resolve = (body: unknown) =>
      app.inject({
        method: 'POST',
        url: `/exceptions/${encodeURIComponent(item.key)}/resolve`,
        payload: body as Record<string, unknown>,
        headers: authed({ 'content-type': 'application/json' }),
      });

    const malformed = await resolve({ action: 'write_off' });
    assert.equal(malformed.statusCode, 400);

    // Maker-checker: one person named twice is one person. Refused by the engine, and
    // independently by a database constraint (ADR-0042).
    const selfApproved = await resolve({
      resolutionKey: 'api-test:self-approved',
      action: 'write_off',
      reason: 'Signed off by me, to me.',
      amountKobo: '500000',
      resolvedBy: 'ops.amaka@example.com',
      approvedBy: 'ops.amaka@example.com',
    });
    assert.equal(selfApproved.statusCode, 422);
    assert.match((selfApproved.json() as { error: string }).error, /cannot approve their own/);

    // Cash moves on bank evidence, and a human's conclusion is not bank evidence. The
    // moment this is allowed "once, carefully", the three-way model is decoration.
    const phantomCash = await resolve({
      resolutionKey: 'api-test:phantom-cash',
      action: 'clear_phantom',
      reason: 'I am sure the money is there.',
      amountKobo: '500000',
      resolvedBy: 'ops.amaka@example.com',
      approvedBy: 'controller.tunde@example.com',
      entries: [
        { accountId: 'bank_account', kobo: '500000' },
        { accountId: 'suspense', kobo: '-500000' },
      ],
    });
    assert.equal(phantomCash.statusCode, 422);
    assert.match((phantomCash.json() as { error: string }).error, /bank evidence/);

    const accepted = await resolve({
      resolutionKey: 'api-test:written-off',
      action: 'write_off',
      reason: 'Correspondent bank confirmed the credit belongs to another mandate.',
      amountKobo: '745000',
      resolvedBy: 'ops.amaka@example.com',
      approvedBy: 'controller.tunde@example.com',
    });
    assert.equal(accepted.statusCode, 201);
    const outcome = accepted.json() as { exceptionClosed: boolean; bookedTransactionId: null };
    assert.equal(outcome.exceptionClosed, true);
    // A decision that moves nothing is recorded as a decision, not as an empty transaction.
    assert.equal(outcome.bookedTransactionId, null);

    const closed = await app.inject({
      method: 'GET',
      url: `/exceptions/${encodeURIComponent(item.key)}`,
      headers: authed(),
    });
    const state = (closed.json() as { exception: { state: string; resolutionKey: string } })
      .exception;
    assert.equal(state.state, 'resolved');
    assert.equal(state.resolutionKey, 'api-test:written-off');

    // Retried by an impatient operator: appended once, because the key is the decision's.
    const retried = await resolve({
      resolutionKey: 'api-test:written-off',
      action: 'write_off',
      reason: 'Correspondent bank confirmed the credit belongs to another mandate.',
      amountKobo: '745000',
      resolvedBy: 'ops.amaka@example.com',
      approvedBy: 'controller.tunde@example.com',
    });
    assert.equal(retried.statusCode, 201);
    const resolutions = await pool.query(
      'SELECT 1 FROM resolutions WHERE resolution_key = $1',
      ['api-test:written-off'],
    );
    assert.equal(resolutions.rowCount, 1);
  });

  test('resolving something that does not exist is a 404', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/exceptions/nothing-here/resolve',
      payload: {
        resolutionKey: 'api-test:nowhere',
        action: 'write_off',
        reason: 'x',
        resolvedBy: 'ops.amaka@example.com',
      },
      headers: authed({ 'content-type': 'application/json' }),
    });

    assert.equal(response.statusCode, 404);
  });
});
