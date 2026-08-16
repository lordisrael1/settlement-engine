import type {
  ChannelScope,
  Currency,
  FeeContract,
  MerchantId,
  RateCard,
  SourceId,
} from '@recon/canon';
import { ANY_CHANNEL } from '@recon/canon';

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
 * Bank-transfer and virtual-account collections, which every Nigerian PSP prices
 * differently from cards — a small flat fee, capped, rather than a percentage.
 *
 * This is the reason contracts are scoped by channel rather than by merchant alone. Pricing
 * a ₦500,000 transfer at the card rate predicts a ₦7,500 fee against an actual ₦50, and the
 * result is not a wrong balance — the fee charged always wins — but a permanent stream of
 * `FEE_VARIANCE` against a price nobody ever quoted for that rail. An exception queue full
 * of those is an exception queue nobody reads.
 */
export const PAYSTACK_TRANSFER_NGN: RateCard = {
  percentBasisPoints: 0,
  flatKobo: 1_000n, // ₦10
  flatWaivedBelowKobo: null,
  capKobo: 1_000n,
  vatBasisPoints: VAT_NGN,
};

export const FLUTTERWAVE_TRANSFER_NGN: RateCard = {
  percentBasisPoints: 0,
  flatKobo: 1_000n,
  flatWaivedBelowKobo: null,
  capKobo: 1_000n,
  vatBasisPoints: VAT_NGN,
};

export const MONNIFY_TRANSFER_NGN: RateCard = {
  percentBasisPoints: 0,
  flatKobo: 1_000n,
  flatWaivedBelowKobo: null,
  capKobo: 1_000n,
  vatBasisPoints: VAT_NGN,
};

/**
 * The published card, as a contract effective from the beginning of time and never
 * approved by anybody.
 *
 * `approvedBy` says `published-rate-card` rather than a person's name, deliberately: it is
 * a list price we read, not an agreement anyone signed, and the exception queue should be
 * able to tell the difference when a variance shows up.
 *
 * The scope is part of the identity. A published card contract and a published transfer
 * contract are two different agreements about two different rails, and giving them the same
 * `contractId` would make the second silently replace the first.
 */
export function publishedContract(
  source: SourceId,
  merchantId: MerchantId,
  rateCard: RateCard,
  channel: ChannelScope = ANY_CHANNEL,
  currency: Currency = 'NGN',
): FeeContract {
  return {
    contractId: `published:${source}:${merchantId}:${channel}:${currency}`,
    source,
    merchantId,
    channel,
    currency,
    effectiveFrom: new Date(0),
    effectiveTo: null,
    rateCard,
    approvedBy: 'published-rate-card',
    approvedAt: new Date(0),
  };
}
