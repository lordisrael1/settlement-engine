import assert from 'node:assert/strict';
import { test } from 'node:test';

import { contractAt, feeFor, feeModel, money } from '@recon/canon';

import { PAYSTACK_PUBLISHED_NGN, publishedContract } from './fees.js';
import { publishedContracts } from './sources.js';

const MERCHANT = 'merchant-under-test';

const paystackFee = (kobo: bigint) =>
  feeFor(PAYSTACK_PUBLISHED_NGN, money(kobo), 'test');

/**
 * The strongest available evidence that the rate card is right: Paystack states the fee
 * it charged in its own webhook payload, so the model can be checked against the
 * provider's own arithmetic rather than against our reading of their pricing page.
 *
 * The three amounts are not arbitrary — each lands on a different branch of the card.
 * Paystack quotes these VAT-inclusive in the webhook, so `fee` is compared, not `total`.
 */
test('paystack rate card reproduces the fee Paystack itself reports', () => {
  // ₦100: 1.5% = ₦1.50, and the ₦100 flat is waived below ₦2,500.
  assert.equal(paystackFee(10_000n).fee.kobo, 150n);

  // ₦2,500: exactly at the waiver threshold, so the flat applies. 1.5% = ₦37.50, + ₦100.
  assert.equal(paystackFee(250_000n).fee.kobo, 13_750n);

  // ₦10,000: 1.5% = ₦150, + ₦100 flat.
  assert.equal(paystackFee(1_000_000n).fee.kobo, 25_000n);
});

test('the fee cap binds on large amounts', () => {
  // ₦1,000,000 would be ₦15,100 uncapped; the card caps it at ₦2,000.
  assert.equal(paystackFee(100_000_000n).fee.kobo, 200_000n);
});

/**
 * VAT is its own number, not a bigger fee. It goes to the tax authority rather than the
 * PSP, and it books to `taxes_withheld` — folding it into the fee would make the PSP look
 * 7.5% more expensive than it is while hiding a line the accountants need.
 */
test('VAT is separated from the fee rather than folded into it', () => {
  const breakdown = paystackFee(1_000_000n);

  assert.equal(breakdown.fee.kobo, 25_000n);
  assert.equal(breakdown.vat.kobo, 1_875n); // 7.5% of ₦250.00
  assert.equal(breakdown.total.kobo, 26_875n);
});

/**
 * The cap limits what the PSP may charge. It does not limit the tax authority's share of
 * what the PSP charged, so VAT is applied after the cap binds.
 */
test('VAT applies to the capped fee, not the uncapped one', () => {
  const breakdown = paystackFee(100_000_000n);
  assert.equal(breakdown.fee.kobo, 200_000n);
  assert.equal(breakdown.vat.kobo, 15_000n);
});

test('percentages round half-up at the kobo, in integer arithmetic', () => {
  const card = {
    percentBasisPoints: 150,
    flatKobo: 0n,
    flatWaivedBelowKobo: null,
    capKobo: null,
    vatBasisPoints: 0,
  };

  // 1.5% of 333 kobo is 4.995 kobo → 5. A float would make this 4.99499999...
  assert.equal(feeFor(card, money(333n), 'test').fee.kobo, 5n);
  // 1.5% of 100 kobo is exactly 1.5 → half-up gives 2.
  assert.equal(feeFor(card, money(100n), 'test').fee.kobo, 2n);
  assert.equal(feeFor(card, money(0n), 'test').fee.kobo, 0n);
});

/**
 * The reason contracts carry dates. Reconciling March with April's renegotiated rate would
 * invent a fee variance on every March payment — history does not change because a
 * contract did.
 */
test('a payment is priced by the contract in force when it happened', () => {
  const march = publishedContract('paystack', MERCHANT, PAYSTACK_PUBLISHED_NGN);
  const negotiated = {
    ...march,
    contractId: 'negotiated-2026-04',
    effectiveFrom: new Date('2026-04-01T00:00:00Z'),
    effectiveTo: null,
    rateCard: { ...PAYSTACK_PUBLISHED_NGN, percentBasisPoints: 100, flatKobo: 0n },
    approvedBy: 'cfo@example.com',
  };
  const contracts = [
    { ...march, effectiveTo: new Date('2026-04-01T00:00:00Z') },
    negotiated,
  ];

  const model = feeModel(contracts);

  const inMarch = model(money(1_000_000n), new Date('2026-03-15T10:00:00Z'));
  const inApril = model(money(1_000_000n), new Date('2026-04-15T10:00:00Z'));

  assert.equal(inMarch?.fee.kobo, 25_000n, 'March must still price at March rates');
  assert.equal(inApril?.fee.kobo, 10_000n);
  // The answer names the document that produced it, so an unexpected number is traceable.
  assert.equal(inApril?.contractId, 'negotiated-2026-04');
});

/**
 * Half-open ranges throughout: the instant one contract ends is the instant its successor
 * begins, so no payment can fall in a gap or be priced twice.
 */
test('contract windows meet exactly, with no gap and no overlap', () => {
  const boundary = new Date('2026-04-01T00:00:00Z');
  const contracts = [
    {
      ...publishedContract('paystack', MERCHANT, PAYSTACK_PUBLISHED_NGN),
      contractId: 'first',
      effectiveTo: boundary,
    },
    {
      ...publishedContract('paystack', MERCHANT, PAYSTACK_PUBLISHED_NGN),
      contractId: 'second',
      effectiveFrom: boundary,
      effectiveTo: null,
    },
  ];

  assert.equal(contractAt(contracts, new Date(boundary.getTime() - 1))?.contractId, 'first');
  assert.equal(contractAt(contracts, boundary)?.contractId, 'second');
});

/**
 * D-026, still standing. Nomba prices per merchant with no public card, so there is
 * nothing honest to seed — and `null` makes the matcher fall back to matching on amount
 * and reporting the fee it observed, rather than generating a permanent stream of
 * variances against a rate nobody ever quoted.
 */
test('a source with no published rate card gets no contract rather than a guess', () => {
  const seeded = publishedContracts(MERCHANT).map((contract) => contract.source);
  assert.ok(!seeded.includes('nomba'));

  const model = feeModel(publishedContracts(MERCHANT).filter((c) => c.source === 'nomba'));
  assert.equal(model(money(1_000_000n), new Date('2026-08-15T10:00:00Z')), null);
});
