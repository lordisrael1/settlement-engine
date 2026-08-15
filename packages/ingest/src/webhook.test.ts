import { createHmac } from 'node:crypto';
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { UnknownSourceError } from './sources.js';
import { ingestWebhook } from './webhook.js';

const SECRET = 'sk_test_whatever';

const CHARGE_SUCCESS = {
  event: 'charge.success',
  data: {
    id: 4210771,
    domain: 'live',
    status: 'success',
    reference: 'PSK_test_1',
    amount: 1_000_000,
    paid_at: '2026-08-13T09:14:22.000Z',
    created_at: '2026-08-13T09:14:02.000Z',
    channel: 'card',
    currency: 'NGN',
    fees: 25_000,
    customer: { id: 1, email: 'a@example.com', customer_code: 'CUS_x' },
    authorization: { authorization_code: 'AUTH_x', last4: '4412', brand: 'verve' },
  },
};

function delivery(body: unknown, secret = SECRET) {
  const rawBody = Buffer.from(JSON.stringify(body), 'utf8');
  return {
    source: 'paystack',
    rawBody,
    secret: SECRET,
    headers: {
      'x-paystack-signature': createHmac('sha512', secret).update(rawBody).digest('hex'),
    },
  };
}

test('an authentic charge becomes a canonical promise at gross', () => {
  const result = ingestWebhook(delivery(CHARGE_SUCCESS));

  assert.equal(result.kind, 'payment');
  if (result.kind !== 'payment') return;

  assert.equal(result.payment.reference, 'PSK_test_1');
  assert.equal(result.payment.source, 'paystack');
  assert.equal(result.payment.status, 'SUCCESSFUL');
  // The promise is what the customer paid. The fee is Paystack's business until a
  // settlement says otherwise, so it is nowhere in this value.
  assert.equal(result.payment.gross.kobo, 1_000_000n);

  // Note the `charge:` segment. Paystack's connector overrides the default
  // `${provider}:${reference}` composition because one Paystack reference is not
  // one-to-one with a transaction. Taking the connector's key whole preserves that
  // knowledge; recomposing it from provider and reference would have discarded it and
  // collided two distinct events onto one key.
  assert.equal(result.payment.idempotencyKey, 'payment:paystack:charge:PSK_test_1');
});

test('a forged signature is rejected before the payload is parsed', () => {
  const result = ingestWebhook(delivery(CHARGE_SUCCESS, 'the-wrong-secret'));
  assert.equal(result.kind, 'unverified');
});

test('a missing signature header is rejected', () => {
  const rawBody = Buffer.from(JSON.stringify(CHARGE_SUCCESS), 'utf8');
  const result = ingestWebhook({ source: 'paystack', rawBody, secret: SECRET, headers: {} });
  assert.equal(result.kind, 'unverified');
});

/**
 * Signatures are computed over bytes. Re-serialising a parsed body produces different
 * bytes — reordered keys, different whitespace — and fails verification for entirely
 * valid payloads. This pins that the raw bytes are what gets verified.
 */
test('verification is over the exact bytes, not an equivalent JSON value', () => {
  const canonical = JSON.stringify(CHARGE_SUCCESS);
  const reformatted = JSON.stringify(CHARGE_SUCCESS, null, 2);

  const rawBody = Buffer.from(reformatted, 'utf8');
  const signatureOverDifferentBytes = createHmac('sha512', SECRET).update(canonical).digest('hex');

  const result = ingestWebhook({
    source: 'paystack',
    rawBody,
    secret: SECRET,
    headers: { 'x-paystack-signature': signatureOverDifferentBytes },
  });

  assert.equal(result.kind, 'unverified');
});

test('an authentic event we have no use for is ignored, not rejected', () => {
  const result = ingestWebhook(
    delivery({ event: 'subscription.create', data: { id: 1, subscription_code: 'SUB_x' } }),
  );
  assert.equal(result.kind, 'ignored');
});

test('redelivery produces an identical canonical event', () => {
  const first = ingestWebhook(delivery(CHARGE_SUCCESS));
  const second = ingestWebhook(delivery(CHARGE_SUCCESS));
  assert.deepEqual(first, second);
});

test('an unknown source names the sources that do exist', () => {
  assert.throws(
    () => ingestWebhook({ ...delivery(CHARGE_SUCCESS), source: 'interswitch' }),
    UnknownSourceError,
  );
});
