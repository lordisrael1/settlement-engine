/**
 * What a source is expected to charge — as a contract with dates on it, not a constant.
 *
 * A single hardcoded fee function is a useful estimate and a bad record. Real Nigerian
 * PSP pricing is negotiated per merchant, renegotiated as volume grows, and quoted with
 * VAT sometimes inside the headline number and sometimes on top. Three consequences
 * follow, and all three are why this file exists rather than a `const`:
 *
 *   **Reconciling last quarter must use last quarter's rates.** If today's renegotiated
 *   card is applied to March, every March payment develops a fee variance that never
 *   happened. History does not change because a contract did.
 *
 *   **VAT is its own deduction.** It goes to the tax authority, not to the PSP, and it
 *   books to `taxes_withheld` rather than `fees_expense`. A model that returns one number
 *   cannot tell the two apart, so this one returns both.
 *
 *   **A rate is an assertion somebody approved.** Contracts carry who approved them and
 *   when, because "why did we expect 1.4%?" is a question with an answer.
 */

import type { MerchantId, SourceId } from './identifiers.js';
import type { Money } from './money.js';
import { add, money, ZERO } from './money.js';

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
 * A rate card that was in force for a particular merchant, on a particular source,
 * between particular dates.
 *
 * `effectiveTo` is `null` while the contract is still the current one. Half-open ranges
 * throughout: `[effectiveFrom, effectiveTo)`, so the instant a contract ends is the
 * instant its successor begins and no payment can fall in a gap or a double-count.
 */
export interface FeeContract {
  readonly contractId: string;
  readonly source: SourceId;
  readonly merchantId: MerchantId;
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
 * `contractId` travels with the answer so an unexpected number can be traced to the
 * document that predicted it, rather than to "the code said so".
 */
export interface FeeBreakdown {
  readonly fee: Money;
  readonly vat: Money;
  readonly total: Money;
  readonly contractId: string;
}

/**
 * `null` when no contract covers that moment — an honest "we cannot predict this",
 * which the matcher turns into matching on amounts alone rather than into a false
 * variance against a rate nobody agreed to (D-026).
 */
export type FeeModel = (gross: Money, at: Date) => FeeBreakdown | null;

/** Round half-up, in integer arithmetic. A float here would manufacture kobo-sized lies. */
function applyBasisPoints(amount: bigint, basisPoints: number): bigint {
  return (amount * BigInt(basisPoints) + 5_000n) / 10_000n;
}

export function feeFor(card: RateCard, gross: Money, contractId: string): FeeBreakdown {
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
    contractId,
  };
}

/**
 * The contract in force at `at`, or `null`.
 *
 * Overlapping contracts for one merchant and source are a data error, not a case to
 * resolve here — the database rejects them with an exclusion constraint, so by the time
 * they reach this function at most one can match.
 */
export function contractAt(
  contracts: readonly FeeContract[],
  at: Date,
): FeeContract | null {
  const instant = at.getTime();
  return (
    contracts.find(
      (contract) =>
        contract.effectiveFrom.getTime() <= instant &&
        (contract.effectiveTo === null || instant < contract.effectiveTo.getTime()),
    ) ?? null
  );
}

/** Build a time-aware model from every contract we hold for one merchant and source. */
export function feeModel(contracts: readonly FeeContract[]): FeeModel {
  return (gross, at) => {
    const contract = contractAt(contracts, at);
    return contract ? feeFor(contract.rateCard, gross, contract.contractId) : null;
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
