import type { AccountId, Money, TransactionId } from '@recon/canon';
import { money, subtract, sum, ZERO } from '@recon/canon';

/**
 * Splitting one batch deduction across the payments it was charged on.
 *
 * A payout of ₦985,000 covers forty payments and carries a ₦15,000 fee. Allocating the
 * gross alone answers "which receivables did this close?" and stops there. It does not
 * answer "what did *this* payment cost?" — and that is the question behind per-payment
 * margin, per-merchant profitability, and every fee dispute anyone has ever had with a PSP.
 *
 * Splitting it requires a rule, and there is no rule that is simply *correct*: the PSP
 * charged the batch, not the payments, and any per-payment number is an allocation we chose.
 * So the choice is stated here, once, in full:
 *
 *   **Pro rata by gross allocated, resolved by largest remainder, tied by transaction id.**
 *
 * Pro rata by gross because Nigerian PSP pricing is overwhelmingly percentage-driven, so a
 * payment twice the size did in fact attract roughly twice the fee. Largest remainder
 * because integer kobo do not divide evenly and the shares must add back to the total
 * *exactly* — a rounding rule that loses a kobo would make the apportioned deductions
 * disagree with the deduction actually booked, which is the same class of error as a plug
 * entry, arriving one kobo at a time. And tied by transaction id because when two payments
 * have identical remainders somebody has to get the spare kobo, and "whichever the map
 * iterated first" is not a decision anybody can reproduce (determinism).
 *
 * What this is *not*: it is not a claim about what the PSP would have charged had each
 * payment settled alone. A flat-fee component or a cap makes that a different number, and
 * pretending otherwise would be inventing precision. This is a defensible split of a real
 * charge, recorded as such, with the rule that produced it written down beside it.
 *
 * And one deliberate limit, stated rather than discovered later: only the *PSP's* deductions
 * are apportioned. A correspondent-bank charge is discovered at stage three, is levied on
 * the credit rather than on any payment, and arrives after the allocations are written —
 * which are append-only. It books to `bank_charges` on the confirming transaction and is
 * visible there; it is simply not attributed to individual payments, because nothing in the
 * evidence says which payment attracted it.
 */

export interface Apportionable {
  readonly transactionId: TransactionId;
  /** The weight this share is computed from: the gross allocated to this promise. */
  readonly gross: Money;
}

/**
 * Split `total` across the weights, exactly.
 *
 * The postcondition is the whole point and is worth stating as an invariant rather than a
 * hope: `sum(result) === total`, always, for any weights, including negative totals and a
 * total smaller than the number of shares.
 *
 * Negative totals are real — a released reserve increases the payout — and are handled by
 * apportioning the magnitude and restoring the sign, so a release is split by the same rule
 * as the withholding that preceded it rather than by floor-toward-negative-infinity, which
 * would distribute it differently and leave the two failing to cancel.
 */
export function apportion(
  total: Money,
  shares: readonly Apportionable[],
): Map<TransactionId, Money> {
  const result = new Map<TransactionId, Money>();
  if (shares.length === 0) return result;

  const negative = total.kobo < 0n;
  const magnitude = negative ? -total.kobo : total.kobo;

  const weights = shares.map((share) => (share.gross.kobo < 0n ? -share.gross.kobo : share.gross.kobo));
  const totalWeight = weights.reduce((running, weight) => running + weight, 0n);

  // Nothing to divide by. Splitting a fee across promises that are collectively worth
  // nothing is not a rounding problem, it is a question with no answer — so every share is
  // zero and the caller's own shortfall check surfaces the total as unexplained.
  if (totalWeight === 0n) {
    for (const share of shares) result.set(share.transactionId, money(0n, total.currency));
    return result;
  }

  const floors = shares.map((share, index) => {
    const numerator = magnitude * weights[index]!;
    const floor = numerator / totalWeight;
    return {
      transactionId: share.transactionId,
      floor,
      // The part that did not divide, kept as an integer numerator so the comparison below
      // stays in exact arithmetic. A float here would decide who gets the spare kobo by
      // rounding error.
      remainder: numerator - floor * totalWeight,
    };
  });

  const spare = magnitude - floors.reduce((running, share) => running + share.floor, 0n);

  // Largest remainder first; equal remainders resolved by transaction id, so the same
  // inputs always hand the same kobo to the same payment.
  const ranked = [...floors].sort((a, b) => {
    if (a.remainder !== b.remainder) return a.remainder > b.remainder ? -1 : 1;
    return a.transactionId < b.transactionId ? -1 : a.transactionId > b.transactionId ? 1 : 0;
  });

  const extra = new Map<TransactionId, bigint>();
  for (let index = 0n; index < spare; index += 1n) {
    // More spare kobo than shares cannot happen — the spare is strictly less than the
    // number of shares by construction — but the modulo keeps it total rather than
    // throwing on an input nobody has thought of yet.
    const target = ranked[Number(index) % ranked.length]!;
    extra.set(target.transactionId, (extra.get(target.transactionId) ?? 0n) + 1n);
  }

  for (const share of floors) {
    const amount = share.floor + (extra.get(share.transactionId) ?? 0n);
    result.set(share.transactionId, money(negative ? -amount : amount, total.currency));
  }

  return result;
}

/** One promise's share of an inflow: what it was worth, what it cost, what it contributes. */
export interface AllocationBreakdown {
  readonly transactionId: TransactionId;
  readonly gross: Money;
  /** This promise's share of each named deduction, one entry per account. */
  readonly deductions: readonly { accountId: AccountId; amount: Money }[];
  /** `gross − Σ deductions`: what this payment contributes to the expected credit. */
  readonly net: Money;
}

/**
 * Apportion every deduction of an inflow across the promises it covers.
 *
 * Each account is apportioned independently, so the fee, the tax and the reserve each add
 * back to their own total exactly. Doing it the other way — apportioning the aggregate and
 * splitting it by account afterwards — would round twice and reconcile to neither.
 *
 * Zero shares are dropped: a payment whose share of the tax rounds to nothing did not pay
 * any tax, and writing `taxes_withheld 0` beside it says nothing at all.
 */
export function apportionDeductions(
  deductions: readonly { accountId: AccountId; amount: Money }[],
  allocations: readonly Apportionable[],
): AllocationBreakdown[] {
  const byTransaction = new Map<TransactionId, { accountId: AccountId; amount: Money }[]>();
  for (const allocation of allocations) byTransaction.set(allocation.transactionId, []);

  for (const deduction of deductions) {
    const shares = apportion(deduction.amount, allocations);
    for (const [transactionId, amount] of shares) {
      if (amount.kobo === 0n) continue;
      byTransaction.get(transactionId)?.push({ accountId: deduction.accountId, amount });
    }
  }

  return allocations.map((allocation) => {
    const share = byTransaction.get(allocation.transactionId) ?? [];
    const deducted = share.length === 0 ? ZERO : sum(share.map((entry) => entry.amount));
    return {
      transactionId: allocation.transactionId,
      gross: allocation.gross,
      deductions: share,
      net: subtract(allocation.gross, deducted),
    };
  });
}
