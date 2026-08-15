/**
 * The vocabulary of reconciliation: what the matcher concluded, and why.
 *
 * Every difference between the promise and the money must end up carrying one of these
 * reason codes. A difference with no reason code is not allowed to exist — that is what
 * "no silent discrepancies" means.
 */

import type { IdempotencyKey, TransactionId } from './identifiers.js';

export const REASON_CODES = [
  // Matches — the difference is fully accounted for.
  /** Same reference, amounts agree. */
  'EXACT_MATCH',
  /** Agrees once the source's fee model is applied: ourGross - expectedFee == theirNet. */
  'FEE_ADJUSTED_MATCH',
  /** One settlement line batches several ledger transactions. */
  'BATCH_MATCH',

  // Explanations — the difference is real but understood.
  /** Matched, but the fee charged differs from the fee model's expectation. */
  'FEE_VARIANCE',
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
] as const;

export type ReasonCode = (typeof REASON_CODES)[number];

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
  readonly reason: ReasonCode;
  readonly confidence: Confidence;
}
