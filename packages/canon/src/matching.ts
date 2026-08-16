/**
 * The vocabulary of reconciliation: what the matcher concluded, and why.
 *
 * Every difference between the promise and the money must end up carrying one of these
 * reason codes. A difference with no reason code is not allowed to exist — that is what
 * "no silent discrepancies" means.
 */

import type { IdempotencyKey, PayoutReference, TransactionId } from './identifiers.js';

export const REASON_CODES = [
  // Matches — the difference is fully accounted for.
  /** Same reference, amounts agree. */
  'EXACT_MATCH',
  /** Agrees once the source's fee model is applied: ourGross - expectedFee == theirNet. */
  'FEE_ADJUSTED_MATCH',
  /** One settlement line batches several ledger transactions. */
  'BATCH_MATCH',

  /** The PSP named this payout's payments itself; the arithmetic only confirmed it. */
  'PAYOUT_MATCH',
  /** A bank credit confirmed a reported payout. The only conclusion that books cash. */
  'BANK_CONFIRMED',

  // Explanations — the difference is real but understood.
  /** Matched, but the fee charged differs from the fee model's expectation. */
  'FEE_VARIANCE',
  /**
   * The PSP reported a payout; the bank has not seen it yet. Not an error, and not cash —
   * the single most common real state in Nigerian settlement.
   */
  'AWAITING_BANK_CREDIT',
  /** The payment is settled in part. The rest is still outstanding, not missing. */
  'PARTIAL_SETTLEMENT',
  /** Short by a rolling reserve or dispute hold the PSP declared. Still ours. */
  'RESERVE_WITHHELD',
  /** Short by tax deducted at source. */
  'TAX_WITHHELD',
  /** Short by a penalty the PSP declared. */
  'PENALTY',
  /** The bank credit is short of the payout by a charge the bank levied. */
  'BANK_CHARGE',
  /** The promise was undone before settlement. */
  'REVERSAL',
  /** Money clawed back after settlement. */
  'CHARGEBACK',
  /** Not settled yet, but still inside the source's settlement window. Not an error. */
  'PENDING_T_PLUS_N',
  /** Sub-unit difference from currency conversion. */
  'FX_ROUNDING',

  // Exceptions — the difference is real and unexplained. A human sees these.
  /** Money with no promise: a dropped webhook, or fraud. */
  'PHANTOM_CREDIT',
  /** A promise whose money never arrived, past its settlement window. */
  'MISSING_SETTLEMENT',
  /**
   * Both sides name the same reference and disagree about the amount, with no fee model
   * able to explain the gap. The most alarming finding the matcher can produce: the two
   * records are certainly about the same event and certainly do not agree.
   */
  'AMOUNT_MISMATCH',
  /** The same payout appears to have been credited twice. Money we may have to send back. */
  'DUPLICATE_BANK_CREDIT',
  /** The bank reversed a credit: the PSP's payout bounced after we were told it had left. */
  'RETURNED_PAYOUT',
  /** A bank credit whose narration identifies nothing and whose amount matches nothing. */
  'UNIDENTIFIED_CREDIT',
  /** The PSP's own report does not add up: declared net is not gross less its deductions. */
  'PAYOUT_UNBALANCED',
] as const;

export type ReasonCode = (typeof REASON_CODES)[number];

/**
 * The three buckets every difference must land in: fully accounted for, understood, or
 * genuinely unexplained. The whole engine is a machine for shrinking the third one.
 *
 * The grouping lives here rather than in the matcher because it is a statement about what
 * a reason code *means*, not about how one was reached — and a second copy of it
 * elsewhere could disagree with this one.
 */
export type ReasonKind = 'match' | 'explanation' | 'exception';

export const REASON_KIND: Readonly<Record<ReasonCode, ReasonKind>> = {
  EXACT_MATCH: 'match',
  FEE_ADJUSTED_MATCH: 'match',
  BATCH_MATCH: 'match',
  PAYOUT_MATCH: 'match',
  BANK_CONFIRMED: 'match',

  FEE_VARIANCE: 'explanation',
  AWAITING_BANK_CREDIT: 'explanation',
  PARTIAL_SETTLEMENT: 'explanation',
  RESERVE_WITHHELD: 'explanation',
  TAX_WITHHELD: 'explanation',
  PENALTY: 'explanation',
  BANK_CHARGE: 'explanation',
  REVERSAL: 'explanation',
  CHARGEBACK: 'explanation',
  PENDING_T_PLUS_N: 'explanation',
  FX_ROUNDING: 'explanation',

  PHANTOM_CREDIT: 'exception',
  MISSING_SETTLEMENT: 'exception',
  AMOUNT_MISMATCH: 'exception',
  DUPLICATE_BANK_CREDIT: 'exception',
  RETURNED_PAYOUT: 'exception',
  UNIDENTIFIED_CREDIT: 'exception',
  PAYOUT_UNBALANCED: 'exception',
};

export function reasonKind(reason: ReasonCode): ReasonKind {
  return REASON_KIND[reason];
}

/** How sure the matcher is, from `0` to `1`. Tier 1 matches are `1`. */
export type Confidence = number;

/**
 * One conclusion of the matching pipeline: these ledger transactions correspond to
 * these settlement lines, for this reason.
 *
 * Both sides are lists because matching is not one-to-one — a batched payout links
 * many transactions to one line. Either side may be empty: a `PHANTOM_CREDIT` has no
 * transactions, a `MISSING_SETTLEMENT` has no settlement lines.
 */
export interface MatchResult {
  readonly transactionIds: readonly TransactionId[];
  readonly settlementKeys: readonly IdempotencyKey[];
  /** The PSP payout this concerns, where one is involved. */
  readonly payoutReferences: readonly PayoutReference[];
  /** The bank credits that confirmed it. Empty until the bank has spoken. */
  readonly bankCreditKeys: readonly IdempotencyKey[];
  readonly reason: ReasonCode;
  readonly confidence: Confidence;
}

/** An empty result to spread over — four link lists is three too many to retype. */
export const NO_LINKS = {
  transactionIds: [] as readonly TransactionId[],
  settlementKeys: [] as readonly IdempotencyKey[],
  payoutReferences: [] as readonly PayoutReference[],
  bankCreditKeys: [] as readonly IdempotencyKey[],
} as const;
