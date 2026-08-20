/**
 * What a source is expected to charge — as a contract with dates on it, not a constant.
 *
 * A single hardcoded fee function is a useful estimate and a bad record. Real Nigerian
 * PSP pricing is negotiated per merchant, renegotiated as volume grows, quoted per channel,
 * and stated with VAT sometimes inside the headline number and sometimes on top. Four
 * consequences follow, and all four are why this file exists rather than a `const`:
 *
 *   **Reconciling last quarter must use last quarter's rates.** If today's renegotiated
 *   card is applied to March, every March payment develops a fee variance that never
 *   happened. History does not change because a contract did.
 *
 *   **A rate is scoped, not global.** Card is not transfer, and NGN is not USD. A single
 *   rate per merchant means every non-card payment develops a permanent variance against a
 *   price that was never quoted for it — the exact false-alert machine a fee model exists
 *   to prevent.
 *
 *   **VAT is its own deduction.** It goes to the tax authority, not to the PSP, and it
 *   books to `taxes_withheld` rather than `fees_expense`. A model that returns one number
 *   cannot tell the two apart, so this one returns both.
 *
 *   **A rate is an assertion somebody approved.** Contracts carry who approved them and
 *   when, because "why did we expect 1.4%?" is a question with an answer — and the answer
 *   travels back out with every quote, so a decision can record which contract explained it.
 */

import type { MerchantId, SourceId } from './identifiers.js';
import type { Currency, Money } from './money.js';
import { add, money, ZERO } from './money.js';
import type { PaymentChannel } from './payment.js';

/**
 * A contract covering every channel.
 *
 * Not the same thing as a missing scope. A merchant on one blended rate genuinely has one
 * contract for everything, and saying so explicitly means the lookup below never has to
 * treat `null` as "matches anything" — a rule that reads as a bug the first time somebody
 * adds a channel-specific contract beside it.
 */
export const ANY_CHANNEL = '*';

/** The channel a contract is priced for, or `'*'` for a blended rate covering all of them. */
export type ChannelScope = PaymentChannel | typeof ANY_CHANNEL;

export interface RateCard {
  /** 150 = 1.50%. Basis points keep the arithmetic in integers. */
  readonly percentBasisPoints: number;
  /** Flat component added on top of the percentage. */
  readonly flatKobo: bigint;
  /** Gross below which the flat component is waived. `null` means never waived. */
  readonly flatWaivedBelowKobo: bigint | null;
  /** Maximum fee, before VAT. `null` means uncapped. */
  readonly capKobo: bigint | null;
  /**
   * VAT charged on the fee itself, in basis points — 750 is Nigeria's 7.5%.
   *
   * Applied to the capped fee, because the cap is a cap on the PSP's charge and the tax
   * authority's share is not the PSP's to cap.
   */
  readonly vatBasisPoints: number;
}

/**
 * A rate card that was in force for a particular merchant, on a particular source, for a
 * particular channel and currency, between particular dates.
 *
 * `effectiveTo` is `null` while the contract is still the current one. Half-open ranges
 * throughout: `[effectiveFrom, effectiveTo)`, so the instant a contract ends is the
 * instant its successor begins and no payment can fall in a gap or a double-count.
 *
 * The scope is `(source, merchantId, channel, currency)`, and the database's exclusion
 * constraint forbids two contracts overlapping *within one scope*. Between scopes there is
 * a deliberate, single, documented overlap — a channel-specific contract and a blended
 * `'*'` one — resolved by `contractAt` in favour of the more specific. That is the only
 * precedence rule in the pricing model, and it is stated once, here.
 */
export interface FeeContract {
  readonly contractId: string;
  readonly source: SourceId;
  readonly merchantId: MerchantId;
  readonly channel: ChannelScope;
  readonly currency: Currency;
  readonly effectiveFrom: Date;
  readonly effectiveTo: Date | null;
  readonly rateCard: RateCard;
  /** Who signed off on this being what we are charged. */
  readonly approvedBy: string;
  readonly approvedAt: Date;
}

/**
 * The fee split the way the books need it: the PSP's share, and the tax authority's.
 *
 * The contract's identity travels with the answer, so an unexpected number can be traced
 * to the document that predicted it rather than to "the code said so". `contractId` names
 * the version; `channel` and `effectiveFrom` say which scope and which period it was, which
 * is what somebody reading an exception six months later actually wants to know.
 */
export interface FeeBreakdown {
  readonly fee: Money;
  readonly vat: Money;
  readonly total: Money;
  readonly contractId: string;
  readonly channel: ChannelScope;
  readonly effectiveFrom: Date;
}

/**
 * `null` when no contract covers that moment, channel and currency — an honest "we cannot
 * predict this", which the matcher turns into matching on amounts alone rather than into a
 * false variance against a rate nobody agreed to (ADR-0026).
 */
export type FeeModel = (
  gross: Money,
  at: Date,
  channel?: PaymentChannel,
) => FeeBreakdown | null;

/** Round half-up, in integer arithmetic. A float here would manufacture kobo-sized lies. */
function applyBasisPoints(amount: bigint, basisPoints: number): bigint {
  return (amount * BigInt(basisPoints) + 5_000n) / 10_000n;
}

export function feeFor(
  card: RateCard,
  gross: Money,
  contract: Pick<FeeContract, 'contractId' | 'channel' | 'effectiveFrom'>,
): FeeBreakdown {
  const basis = gross.kobo < 0n ? -gross.kobo : gross.kobo;

  const percentage = applyBasisPoints(basis, card.percentBasisPoints);
  const flatApplies = card.flatWaivedBelowKobo === null || basis >= card.flatWaivedBelowKobo;
  const uncapped = percentage + (flatApplies ? card.flatKobo : 0n);
  const fee = card.capKobo !== null && uncapped > card.capKobo ? card.capKobo : uncapped;

  const vat = applyBasisPoints(fee, card.vatBasisPoints);

  return {
    fee: money(fee, gross.currency),
    vat: money(vat, gross.currency),
    total: money(fee + vat, gross.currency),
    contractId: contract.contractId,
    channel: contract.channel,
    effectiveFrom: contract.effectiveFrom,
  };
}

/**
 * The contract in force at `at`, for that channel and currency, or `null`.
 *
 * Overlapping contracts *within one scope* are a data error, not a case to resolve here —
 * the database rejects them with an exclusion constraint, so by the time they reach this
 * function at most one can match per scope. What this function does resolve is the one
 * overlap the model allows on purpose: a channel-specific contract beats a blended one,
 * because a rate quoted for transfers is a better answer about a transfer than a rate
 * quoted for everything.
 */
export function contractAt(
  contracts: readonly FeeContract[],
  at: Date,
  channel: PaymentChannel,
  currency: Currency,
): FeeContract | null {
  const instant = at.getTime();
  const inForce = contracts.filter(
    (contract) =>
      contract.currency === currency &&
      contract.effectiveFrom.getTime() <= instant &&
      (contract.effectiveTo === null || instant < contract.effectiveTo.getTime()),
  );

  return (
    inForce.find((contract) => contract.channel === channel) ??
    inForce.find((contract) => contract.channel === ANY_CHANNEL) ??
    null
  );
}

/**
 * Build a time-, channel- and currency-aware model from every contract we hold for one
 * merchant and source.
 *
 * The channel defaults to `'unknown'` because that is what a caller who cannot say has: a
 * payout report names a movement, not a rail, and pretending otherwise would price a batch
 * at the card rate on no evidence. An unknown channel finds the blended contract or
 * nothing, which is the honest pair of outcomes.
 */
export function feeModel(contracts: readonly FeeContract[]): FeeModel {
  return (gross, at, channel = 'unknown') => {
    const contract = contractAt(contracts, at, channel, gross.currency);
    return contract ? feeFor(contract.rateCard, gross, contract) : null;
  };
}

/** Total of a list of breakdowns — a batch's expected fee, and its expected VAT. */
export function totalFees(breakdowns: readonly FeeBreakdown[]): {
  fee: Money;
  vat: Money;
} {
  return breakdowns.reduce<{ fee: Money; vat: Money }>(
    (running, breakdown) => ({
      fee: add(running.fee, breakdown.fee),
      vat: add(running.vat, breakdown.vat),
    }),
    { fee: ZERO, vat: ZERO },
  );
}
