import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { redact } from '@recon/protect';

import { ingestWebhook } from './webhook.js';

/**
 * The keep-list, checked against the connectors rather than against an opinion.
 *
 * `@recon/protect` names the paths reconciliation reads. Whether that list is *complete* is
 * a fact about `@pay-normalize`'s parsers, not about the redactor, so the claim is made
 * here, where both are in scope: take a real provider payload, redact it, parse both
 * copies, and assert the canonical payment is identical.
 *
 * This is the test that fails when a connector starts reading a field the keep-list does
 * not carry — which is the failure worth catching, because the alternative is discovering
 * six months of redacted deliveries that no longer explain themselves.
 */
const SECRET = 'sk_test_whatever';

const fixture = (name: string): unknown[] =>
  JSON.parse(
    readFileSync(new URL(`../../../apps/pipeline/fixtures/${name}`, import.meta.url), 'utf8'),
  ) as unknown[];

function paystack(body: unknown) {
  const rawBody = Buffer.from(JSON.stringify(body), 'utf8');
  return {
    source: 'paystack',
    rawBody,
    secret: SECRET,
    headers: { 'x-paystack-signature': createHmac('sha512', SECRET).update(rawBody).digest('hex') },
  };
}

function flutterwave(body: unknown) {
  const rawBody = Buffer.from(JSON.stringify(body), 'utf8');
  return {
    source: 'flutterwave',
    rawBody,
    secret: SECRET,
    headers: { 'verif-hash': SECRET },
  };
}

test('a redacted Paystack delivery still means exactly what the original meant', () => {
  for (const body of fixture('paystack-webhooks.json')) {
    const original = ingestWebhook(paystack(body));
    const reduced = ingestWebhook(paystack(JSON.parse(redact(Buffer.from(JSON.stringify(body), 'utf8')).bytes.toString('utf8'))));

    assert.deepEqual(reduced, original, `redaction changed the meaning of ${JSON.stringify(body).slice(0, 80)}`);
  }
});

test('a redacted Flutterwave delivery still means exactly what the original meant', () => {
  for (const body of fixture('flutterwave-webhooks.json')) {
    const original = ingestWebhook(flutterwave(body));
    const reduced = ingestWebhook(flutterwave(JSON.parse(redact(Buffer.from(JSON.stringify(body), 'utf8')).bytes.toString('utf8'))));

    assert.deepEqual(reduced, original);
  }
});

test('and the personal data is gone from the bytes that remain', () => {
  const [first] = fixture('paystack-webhooks.json');
  const reduced = redact(Buffer.from(JSON.stringify(first), 'utf8')).bytes.toString('utf8');

  for (const leaked of ['Amaka', 'amaka@example.com', '102.89.34.11', 'AUTH_k2p9wz', 'exp_year']) {
    assert.ok(!reduced.includes(leaked), `${leaked} survived redaction`);
  }
});

test('a delivery carrying a real card number is refused, authentic or not', () => {
  // The invariant, at the boundary that produces canonical records: a synthetic PAN goes
  // in, and what comes back is a refusal rather than a payment. Nothing downstream of this
  // is ever handed the bytes.
  const smuggled = {
    event: 'charge.success',
    data: {
      status: 'success',
      reference: 'PSK_bad',
      amount: 1_000_000,
      currency: 'NGN',
      channel: 'card',
      paid_at: '2026-08-13T09:14:22.000Z',
      created_at: '2026-08-13T09:14:02.000Z',
      authorization: { card_number: '5060991234564413' },
    },
  };

  const result = ingestWebhook(paystack(smuggled));
  assert.equal(result.kind, 'rejected');
  if (result.kind !== 'rejected') return;
  assert.match(result.reason, /tokens and approved truncations only/);
  // The refusal names the field and never the digits.
  assert.ok(!result.reason.includes('5060991234564413'));
});
