import type { Money } from '@recon/canon';
import { money } from '@recon/canon';

/**
 * What a source is expected to charge on a given gross amount.
 *
 * This is the function that turns a raw-number "mismatch" into a match: the reconciler
 * matches on `ourGross − expectedFee(ourGross) == theirNet`, not on the amounts
 * themselves. Modelling each rate card correctly is a large share of the real value of
 * the whole system.
 *
 * It is an *expectation*, never an authority. When the fee actually charged differs, the
 * settlement line's fee is the truth and the difference is booked as `FEE_VARIANCE` —
 * the model exists to explain differences, not to overrule the money.
 */
export type FeeModel = (gross: Money) => Money;

export interface RateCard {
  /** 150 = 1.50%. Basis points keep the arithmetic in integers. */
  readonly percentBasisPoints: number;
  /** Flat component added on top of the percentage. */
  readonly flatKobo: bigint;
  /** Gross below which the flat component is waived. `null` means never waived. */
  readonly flatWaivedBelowKobo: bigint | null;
  /** Maximum total fee. `null` means uncapped. */
  readonly capKobo: bigint | null;
}

/**
 * Build a fee model from a rate card.
 *
 * All arithmetic is `bigint`, and the percentage rounds half-up at the kobo — the same
 * discipline as the ledger itself. A fee model that rounded through a float would
 * manufacture the very one-kobo discrepancies the reconciler exists to eliminate.
 */
export function feeModel(card: RateCard): FeeModel {
  return (gross: Money): Money => {
    const basis = gross.kobo < 0n ? -gross.kobo : gross.kobo;

    // Round half-up: (x * bp + 5000) / 10000, in integer arithmetic.
    const percentage =
      (basis * BigInt(card.percentBasisPoints) + 5_000n) / 10_000n;

    const flatApplies =
      card.flatWaivedBelowKobo === null || basis >= card.flatWaivedBelowKobo;
    const uncapped = percentage + (flatApplies ? card.flatKobo : 0n);

    const total =
      card.capKobo !== null && uncapped > card.capKobo ? card.capKobo : uncapped;

    return money(total, gross.currency);
  };
}
