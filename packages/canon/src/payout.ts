/**
 * The payout — the PSP's own statement of what it is about to send us.
 *
 * This is the second of three independent records, and the one the original design was
 * missing. A settlement report is **not** money. It is a claim, and the claim is
 * structured: *these* payments, less *these* named deductions, equals *this* payout, due
 * on *this* date. Until a bank statement agrees, none of it has happened.
 *
 * Treating the payout as a first-class thing rather than a bag of settlement lines buys
 * three things that matter:
 *
 *   **Batching becomes a fact rather than an inference.** The PSP told us which payments
 *   the payout covers. Subset-sum stops being the primary tool and becomes the fallback
 *   for sources that do not say.
 *
 *   **Deductions become named.** A reserve, a penalty and a tax are not "the amount is
 *   short by ₦4,200" — they are three different things that book to three different
 *   accounts and mean three different things to whoever reads the queue.
 *
 *   **The gap gets a home.** "The PSP says it paid, the bank has not seen it" is the
 *   single most common real incident in Nigerian settlement, and it needs somewhere to
 *   sit that is neither "matched" nor "missing".
 */

import type { AccountId } from './accounts.js';
import type { RowLineage } from './evidence.js';
import type { IdempotencyKey, PayoutReference, SourceId } from './identifiers.js';
import type { Money } from './money.js';
import { add, subtract, sum, ZERO } from './money.js';

/**
 * The named reasons a payout is smaller than the payments it covers.
 *
 * Every one of these is a deduction we would otherwise have discovered as an unexplained
 * shortfall. Naming them is the difference between "₦4,200 is missing" and "₦4,200 is a
 * rolling reserve you will get back in 90 days".
 */
export const ADJUSTMENT_KINDS = [
  /** The PSP's own charge for processing. */
  'fee',
  /** VAT, stamp duty, or withholding tax deducted at source. */
  'tax',
  /** Rolling reserve or dispute hold: still ours, withheld for now. */
  'reserve',
  /** A previously withheld reserve being paid out. Negative: money coming back. */
  'reserve_release',
  /** A fine — late settlement of a dispute, a compliance breach, an SLA penalty. */
  'penalty',
  /** A refund to a customer, netted off this payout. */
  'refund',
  /** A clawback following a dispute, netted off this payout. */
  'chargeback',
] as const;

export type AdjustmentKind = (typeof ADJUSTMENT_KINDS)[number];

/**
 * Where each deduction lands in the books.
 *
 * A reserve is an **asset**, not an expense — the PSP is holding our money, not keeping
 * it, and booking it as a cost would understate what we are owed by exactly the amount
 * we are owed. Tax is an expense but not the PSP's, so it gets its own account rather
 * than inflating what looks like PSP pricing. Refunds and chargebacks reach the same
 * contra-income accounts a standalone reversal would, because they are the same events
 * arriving folded into a payout.
 */
export const ADJUSTMENT_ACCOUNT: Readonly<Record<AdjustmentKind, AccountId>> = {
  fee: 'fees_expense',
  tax: 'taxes_withheld',
  reserve: 'psp_reserve',
  reserve_release: 'psp_reserve',
  penalty: 'penalties',
  refund: 'reversals',
  chargeback: 'chargebacks',
};

export interface SettlementAdjustment {
  readonly kind: AdjustmentKind;
  /**
   * Positive reduces the payout; `reserve_release` is the one kind that arrives negative,
   * because it increases it. Signed rather than kind-dependent, so the arithmetic below
   * never has to ask what kind it is looking at.
   */
  readonly amount: Money;
  /** The source's own words for it, kept as evidence. Never parsed to decide anything. */
  readonly narration: string | null;
}

export type PayoutStatus =
  /** The PSP says it is coming. No bank evidence yet. */
  | 'reported'
  /** A bank credit confirmed it. This is the only status that means cash. */
  | 'confirmed'
  /** The bank sent it back, or the PSP withdrew it. */
  | 'returned';

/**
 * One money movement a PSP says it is making, and everything it says about it.
 *
 * `expectedNet` is the PSP's own number, not one we computed. Recomputing it from the
 * lines and adjustments and then trusting our own answer would hide precisely the
 * disagreements this record exists to surface — `payoutArithmetic` below reports the two
 * side by side instead.
 */
export interface Payout {
  readonly payoutReference: PayoutReference;
  readonly source: SourceId;
  readonly status: PayoutStatus;

  /** The sum of the payments the PSP says this payout covers, before deductions. */
  readonly gross: Money;
  /** What the PSP says will land in the bank. */
  readonly expectedNet: Money;
  readonly adjustments: readonly SettlementAdjustment[];

  /** When the PSP produced the report. */
  readonly reportedAt: Date;
  /** When the PSP says the money moves. `null` when it does not disclose one (D-019). */
  readonly valueDate: Date | null;

  /** The file this came out of — see `Evidence`. Every payout is traceable to bytes. */
  readonly evidenceId: string;
  /** …and to the row of that file, which is what "traceable" means in a file of five thousand. */
  readonly lineage: RowLineage;
  readonly idempotencyKey: IdempotencyKey;
}

export function totalAdjustments(adjustments: readonly SettlementAdjustment[]): Money {
  return sum(adjustments.map((adjustment) => adjustment.amount));
}

export function adjustmentsOfKind(
  adjustments: readonly SettlementAdjustment[],
  kind: AdjustmentKind,
): Money {
  return sum(
    adjustments.filter((adjustment) => adjustment.kind === kind).map((a) => a.amount),
  );
}

export interface PayoutArithmetic {
  /** `gross − deductions`: what the payout should be, by the PSP's own numbers. */
  readonly derivedNet: Money;
  /** What the PSP said it would be. */
  readonly declaredNet: Money;
  /** `declared − derived`. Zero when the report is internally consistent. */
  readonly unexplained: Money;
  readonly consistent: boolean;
}

/**
 * Does the PSP's own report add up?
 *
 * A payout whose declared net does not equal its gross less its own itemised deductions
 * is a report with something in it nobody has told us about. That is worth knowing before
 * any matching happens, because every downstream discrepancy will otherwise be blamed on
 * the payments rather than on the file.
 */
export function payoutArithmetic(payout: Payout): PayoutArithmetic {
  const derivedNet = subtract(payout.gross, totalAdjustments(payout.adjustments));
  const unexplained = subtract(payout.expectedNet, derivedNet);
  return {
    derivedNet,
    declaredNet: payout.expectedNet,
    unexplained,
    consistent: unexplained.kobo === 0n,
  };
}

/**
 * The ledger entries a payout's deductions produce, one per account.
 *
 * Kinds that share an account are combined, because two entries against `fees_expense` in
 * one transaction say nothing that one does not. Zero-valued totals are dropped: a
 * deduction that nets to nothing is not a fact about the books.
 */
export function adjustmentEntries(
  adjustments: readonly SettlementAdjustment[],
): { accountId: AccountId; amount: Money }[] {
  const byAccount = new Map<AccountId, Money>();

  for (const adjustment of adjustments) {
    const account = ADJUSTMENT_ACCOUNT[adjustment.kind];
    byAccount.set(account, add(byAccount.get(account) ?? ZERO, adjustment.amount));
  }

  return [...byAccount]
    .filter(([, amount]) => amount.kobo !== 0n)
    .map(([accountId, amount]) => ({ accountId, amount }));
}

