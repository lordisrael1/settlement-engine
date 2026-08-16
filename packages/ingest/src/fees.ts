import type { FeeContract, MerchantId, RateCard, SourceId } from '@recon/canon';

/**
 * Published NGN rate cards, expressed as *contracts with dates on them*.
 *
 * These are the public list prices, and they are seeds — the honest starting point for a
 * deployment that has not yet loaded its own signed agreements. Any merchant above modest
 * volume is on a negotiated rate, and the whole reason contracts carry `effectiveFrom` and
 * `approvedBy` is so that the negotiated one can replace the published one without
 * rewriting history: March reconciles at March's rate, forever.
 *
 * A stale card degrades gracefully. The fee actually charged always wins; a wrong
 * expectation shows up as a rising `FEE_VARIANCE` count, never as a wrong balance.
 *
 * VAT is 7.5% on the fee, and it is modelled separately because it books to
 * `taxes_withheld` rather than `fees_expense`. It goes to the tax authority, not the PSP,
 * and folding it into "what Paystack costs" makes the PSP look 7.5% more expensive than it
 * is while hiding a tax line the accountants need.
 */
const VAT_NGN = 750;

export const PAYSTACK_PUBLISHED_NGN: RateCard = {
  percentBasisPoints: 150,
  flatKobo: 10_000n, // ₦100
  flatWaivedBelowKobo: 250_000n, // waived under ₦2,500
  capKobo: 200_000n, // capped at ₦2,000
  vatBasisPoints: VAT_NGN,
};

export const FLUTTERWAVE_PUBLISHED_NGN: RateCard = {
  percentBasisPoints: 140,
  flatKobo: 0n,
  flatWaivedBelowKobo: null,
  capKobo: 200_000n,
  vatBasisPoints: VAT_NGN,
};

export const MONNIFY_PUBLISHED_NGN: RateCard = {
  percentBasisPoints: 150,
  flatKobo: 0n,
  flatWaivedBelowKobo: null,
  capKobo: 200_000n,
  vatBasisPoints: VAT_NGN,
};

/**
 * The published card, as a contract effective from the beginning of time and never
 * approved by anybody.
 *
 * `approvedBy` says `published-rate-card` rather than a person's name, deliberately: it is
 * a list price we read, not an agreement anyone signed, and the exception queue should be
 * able to tell the difference when a variance shows up.
 */
export function publishedContract(
  source: SourceId,
  merchantId: MerchantId,
  rateCard: RateCard,
): FeeContract {
  return {
    contractId: `published:${source}:${merchantId}`,
    source,
    merchantId,
    effectiveFrom: new Date(0),
    effectiveTo: null,
    rateCard,
    approvedBy: 'published-rate-card',
    approvedAt: new Date(0),
  };
}
