import assert from 'node:assert/strict';
import { test } from 'node:test';

import { money } from '@recon/canon';

import { feeModel } from './fees.js';
import { sourceProfile } from './sources.js';

const paystack = () => {
  const model = sourceProfile('paystack').expectedFee;
  assert.ok(model, 'paystack must have a rate card');
  return model;
};

/**
 * The strongest available evidence that the rate card is right: Paystack states the fee
 * it charged in its own webhook payload, so the model can be checked against the
 * provider's own arithmetic rather than against our reading of their pricing page.
 *
 * The three amounts are not arbitrary — each lands on a different branch of the card.
 */
test('paystack rate card reproduces the fee Paystack itself reports', () => {
  const expectedFee = paystack();

  // ₦100: 1.5% = ₦1.50, and the ₦100 flat is waived below ₦2,500.
  assert.equal(expectedFee(money(10_000n)).kobo, 150n);

  // ₦2,500: exactly at the waiver threshold, so the flat applies. 1.5% = ₦37.50, + ₦100.
  assert.equal(expectedFee(money(250_000n)).kobo, 13_750n);

  // ₦10,000: 1.5% = ₦150, + ₦100 flat.
  assert.equal(expectedFee(money(1_000_000n)).kobo, 25_000n);
});

test('the fee cap binds on large amounts', () => {
  const expectedFee = paystack();
  // ₦1,000,000 would be ₦15,100 uncapped; the card caps it at ₦2,000.
  assert.equal(expectedFee(money(100_000_000n)).kobo, 200_000n);
});

test('percentages round half-up at the kobo, in integer arithmetic', () => {
  const model = feeModel({
    percentBasisPoints: 150,
    flatKobo: 0n,
    flatWaivedBelowKobo: null,
    capKobo: null,
  });

  // 1.5% of 333 kobo is 4.995 kobo → 5. A float would make this 4.99499999...
  assert.equal(model(money(333n)).kobo, 5n);
  // 1.5% of 100 kobo is exactly 1.5 → half-up gives 2.
  assert.equal(model(money(100n)).kobo, 2n);
  assert.equal(model(money(0n)).kobo, 0n);
});

test('a source with no published rate card declares null rather than guessing', () => {
  assert.equal(sourceProfile('nomba').expectedFee, null);
});
