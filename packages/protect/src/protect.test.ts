import assert from 'node:assert/strict';
import { test } from 'node:test';

import { localKeyRing, parseLocalKey, seal, unseal, DecryptionFailed } from './envelope.js';
import { redact } from './redact.js';
import { CardDataRefused, refuseCardData, scanForCardData } from './scan.js';

/**
 * A real Paystack `charge.success` body, with everything a live one carries. The fixture the
 * whole package is aimed at: nothing here is a card number, and almost all of it is personal
 * data we have no use for.
 */
const CHARGE_SUCCESS = {
  event: 'charge.success',
  data: {
    id: 4210771,
    domain: 'live',
    status: 'success',
    reference: 'PSK_9f3a2c',
    amount: 1_000_000,
    message: null,
    gateway_response: 'Successful',
    paid_at: '2026-08-13T09:14:22.000Z',
    created_at: '2026-08-13T09:14:02.000Z',
    channel: 'card',
    currency: 'NGN',
    ip_address: '102.89.34.11',
    fees: 25_000,
    customer: {
      id: 88_213,
      first_name: 'Amaka',
      last_name: 'Okafor',
      email: 'amaka@example.com',
      customer_code: 'CUS_3kd91xzq0',
      phone: null,
    },
    authorization: {
      authorization_code: 'AUTH_k2p9wz',
      bin: '506099',
      last4: '4412',
      exp_month: '04',
      exp_year: '2029',
      card_type: 'verve DEBIT',
      bank: 'Guaranty Trust Bank',
      brand: 'verve',
    },
  },
};

const bytes = (value: unknown): Buffer => Buffer.from(JSON.stringify(value), 'utf8');

// ── The guard ───────────────────────────────────────────────────────────────

test('a live provider payload is accepted: a BIN and a last four are not a card number', () => {
  // The claim the PCI position rests on, as a test rather than a paragraph. 506099 and 4412
  // are the first six and last four — the maximum PCI DSS permits to be displayed — and the
  // middle digits never reach this system.
  assert.equal(scanForCardData(bytes(CHARGE_SUCCESS)), null);
});

test('a Luhn-valid card number is refused, wherever in the payload it appears', () => {
  const smuggled = {
    ...CHARGE_SUCCESS,
    data: { ...CHARGE_SUCCESS.data, narration: 'refund to 5060 9912 3456 4413' },
  };

  const finding = scanForCardData(bytes(smuggled));
  assert.equal(finding?.kind, 'pan');
  // The finding travels into an error message and a log line, so it carries the masked form
  // and never the digits.
  assert.match(finding?.detail ?? '', /506099\*+4413/);
  assert.doesNotMatch(finding?.detail ?? '', /9912345/);
});

test('sensitive authentication data is refused by name, empty or not', () => {
  const withCvv = {
    ...CHARGE_SUCCESS,
    data: { ...CHARGE_SUCCESS.data, authorization: { ...CHARGE_SUCCESS.data.authorization, cvv: '' } },
  };

  const finding = scanForCardData(bytes(withCvv));
  assert.equal(finding?.kind, 'sad');
  assert.equal(finding?.at, '$.data.authorization.cvv');
});

test('bytes that are not JSON are still scanned — a statement is a CSV', () => {
  const statement = Buffer.from(
    'date,narration,amount\n2026-08-13,PAYSTACK 4111111111111111,10000\n',
    'utf8',
  );
  assert.equal(scanForCardData(statement)?.kind, 'pan');
});

test('ordinary long identifiers are not mistaken for cards', () => {
  // Luhn alone would refuse roughly one of these in ten. A ten-digit NUBAN, a kobo amount
  // and a provider reference all have to survive, or the guard gets switched off.
  const ordinary = {
    account_number: '0123456789',
    amount: 1_000_000,
    reference: '9f3a2c7710880045',
    settlement_id: '30011234567890123',
  };
  assert.equal(scanForCardData(bytes(ordinary)), null);
});

test('refuseCardData says what was found and that nothing was stored', () => {
  const smuggled = bytes({ card_number: '4111111111111111' });
  assert.throws(
    () => refuseCardData(smuggled, 'This delivery'),
    (error: unknown) => {
      assert.ok(error instanceof CardDataRefused);
      assert.match(error.message, /nothing was stored/);
      return true;
    },
  );
});

// ── The keep-list ───────────────────────────────────────────────────────────

test('redaction keeps what the matcher reads and drops the person', () => {
  const { bytes: redacted, dropped } = redact(bytes(CHARGE_SUCCESS));
  const result = JSON.parse(redacted.toString('utf8')) as Record<string, unknown>;
  const data = result['data'] as Record<string, unknown>;

  assert.equal(result['event'], 'charge.success');
  assert.equal(data['reference'], 'PSK_9f3a2c');
  assert.equal(data['amount'], 1_000_000);
  assert.equal(data['currency'], 'NGN');
  assert.equal(data['status'], 'success');
  assert.equal(data['channel'], 'card');
  assert.equal(data['paid_at'], '2026-08-13T09:14:22.000Z');
  assert.equal(data['fees'], 25_000);
  assert.ok(dropped > 0);

  // The containers disappear without being named: nothing inside them is on the keep-list,
  // so nothing inside them survived, so they did not.
  assert.equal(data['customer'], undefined);
  assert.equal(data['authorization'], undefined);
  assert.equal(data['ip_address'], undefined);

  // And the same claim made the way it will actually be checked — over the bytes.
  const text = redacted.toString('utf8');
  for (const leaked of ['Amaka', 'Okafor', 'amaka@example.com', '102.89.34.11', '506099', '4412', 'exp_month']) {
    assert.ok(!text.includes(leaked), `redacted payload still contains ${leaked}`);
  }
});

test('a field a provider adds tomorrow is dropped, because the list is a keep-list', () => {
  const extended = {
    ...CHARGE_SUCCESS,
    data: { ...CHARGE_SUCCESS.data, payer_bvn: '22123456789', device_fingerprint: 'fp_x91' },
  };

  const text = redact(bytes(extended)).bytes.toString('utf8');
  assert.ok(!text.includes('22123456789'));
  assert.ok(!text.includes('fp_x91'));
});

test('the redacted copy says it is redacted', () => {
  const result = JSON.parse(redact(bytes(CHARGE_SUCCESS)).bytes.toString('utf8')) as {
    _redaction: { redacted: string; dropped: number };
  };
  assert.equal(result._redaction.redacted, 'keep-list-1');
  assert.ok(result._redaction.dropped > 0);
});

test('bytes that cannot be parsed are replaced whole, not kept because they are opaque', () => {
  const garbage = Buffer.from('not json at all, possibly with amaka@example.com in it', 'utf8');
  const text = redact(garbage).bytes.toString('utf8');
  assert.ok(!text.includes('amaka@example.com'));
  assert.match(text, /not JSON/);
});

// ── The envelope ────────────────────────────────────────────────────────────

const KEY_A = parseLocalKey(`k1:${Buffer.alloc(32, 7).toString('base64')}`);
const KEY_B = parseLocalKey(`k2:${Buffer.alloc(32, 9).toString('base64')}`);

test('sealed bytes come back, and the ciphertext is not the plaintext', async () => {
  const ring = localKeyRing([KEY_A], 'k1');
  const plaintext = bytes(CHARGE_SUCCESS);

  const sealed = await seal(ring, plaintext, { evidence_id: 'ev-1' });
  assert.ok(!sealed.ciphertext.includes(Buffer.from('amaka@example.com', 'utf8')));
  assert.equal(sealed.keyId, 'k1');

  const opened = await unseal(ring, sealed, { evidence_id: 'ev-1' });
  assert.deepEqual(opened, plaintext);
});

test('a ciphertext cannot be moved between records', async () => {
  // The property the encryption context buys, and the reason it is the evidence id: a
  // database write anybody can make must not be able to serve one document's bytes as
  // another document's evidence.
  const ring = localKeyRing([KEY_A], 'k1');
  const sealed = await seal(ring, Buffer.from('the settlement export', 'utf8'), {
    evidence_id: 'ev-1',
  });

  await assert.rejects(
    () => unseal(ring, sealed, { evidence_id: 'ev-2' }),
    (error: unknown) => error instanceof DecryptionFailed,
  );
});

test('an altered ciphertext fails to decrypt rather than decrypting to something else', async () => {
  const ring = localKeyRing([KEY_A], 'k1');
  const sealed = await seal(ring, Buffer.from('₦10,000 settled', 'utf8'), { evidence_id: 'ev-1' });

  const tampered = Buffer.from(sealed.ciphertext);
  tampered[0] = (tampered[0] ?? 0) ^ 0xff;

  await assert.rejects(
    () => unseal(ring, { ...sealed, ciphertext: tampered }, { evidence_id: 'ev-1' }),
    (error: unknown) => error instanceof DecryptionFailed,
  );
});

test('rotation re-wraps: a blob sealed under a retired key still opens', async () => {
  const before = localKeyRing([KEY_A], 'k1');
  const sealed = await seal(before, Buffer.from('old evidence', 'utf8'), { evidence_id: 'ev-1' });

  // The root key rotated. New records use k2; the old ones are readable because k1 stays
  // configured for as long as anything sealed under it is still within retention.
  const after = localKeyRing([KEY_A, KEY_B], 'k2');
  assert.deepEqual(
    await unseal(after, sealed, { evidence_id: 'ev-1' }),
    Buffer.from('old evidence', 'utf8'),
  );

  const fresh = await seal(after, Buffer.from('new evidence', 'utf8'), { evidence_id: 'ev-2' });
  assert.equal(fresh.keyId, 'k2');
});

test('a retired key that was dropped from configuration is a named failure', async () => {
  const before = localKeyRing([KEY_A], 'k1');
  const sealed = await seal(before, Buffer.from('old evidence', 'utf8'), { evidence_id: 'ev-1' });

  const after = localKeyRing([KEY_B], 'k2');
  await assert.rejects(
    () => unseal(after, sealed, { evidence_id: 'ev-1' }),
    (error: unknown) => {
      assert.ok(error instanceof DecryptionFailed);
      assert.match(error.message, /must stay configured/);
      return true;
    },
  );
});

test('a short root key is a configuration error, not a shorter key', () => {
  assert.throws(
    () => parseLocalKey(`k1:${Buffer.alloc(16, 1).toString('base64')}`),
    /needs exactly 32/,
  );
});
