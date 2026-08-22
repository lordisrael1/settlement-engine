/**
 * The vocabulary of reconciliation: what the matcher concluded, and why.
 *
 * Every difference between the promise and the money must end up carrying one of these
 * reason codes. A difference with no reason code is not allowed to exist — that is what
 * "no silent discrepancies" means.
 */

import type { ChannelScope } from './fees.js';
import type { IdempotencyKey, PayoutReference, TransactionId } from './identifiers.js';
import type { Money } from './money.js';

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
  /**
   * A reserve coming back: a movement that discharges no receivable at all.
   *
   * The one payout shape with a gross of zero. It covers no payments — there is nothing to
   * match it to — and the money is ours already, sitting in `psp_reserve`. Without this it
   * looked like a `PHANTOM_CREDIT`: a payout naming no promises, which is exactly what it is
   * and exactly the wrong thing to call it (ADR-0071).
   */
  'RESERVE_RELEASED',
  /** Short by tax deducted at source. */
  'TAX_WITHHELD',
  /** Short by a penalty the PSP declared. */
  'PENALTY',
  /** The bank credit is short of the payout by a charge the bank levied. */
  'BANK_CHARGE',
  /** The promise was undone before settlement. */
  'REVERSAL',
  /**
   * Part of the promise was undone before settlement, and the rest is still coming.
   *
   * A ₦3,000 refund against a ₦10,000 charge — one line of a basket cancelled — is the
   * ordinary shape of e-commerce, and the whole-transaction `REVERSAL` cannot express it:
   * negating the lot would erase ₦7,000 of receivable the PSP still owes us, and refusing
   * the line would escalate a refund that is going exactly to plan (ADR-0069).
   */
  'PARTIAL_REVERSAL',
  /** Money clawed back after settlement. */
  'CHARGEBACK',
  /** Part of a settled payment clawed back after settlement. The rest stands. */
  'PARTIAL_CHARGEBACK',
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
  /**
   * The payout batches more promises than the bounded search may consider, so the
   * arithmetic was never attempted.
   *
   * Deliberately not `PHANTOM_CREDIT`. "No combination of your promises adds up to this
   * payout" and "we did not look" are different sentences, and filing the second as the
   * first sends somebody hunting for a missing webhook that is not missing. See
   * `subset.ts` for the bound and ADR-0070 for why arithmetic-only matching is a
   * small-batch feature.
   */
  'BATCH_TOO_LARGE',
  /**
   * Two distinct bank statement rows resolved to one identity.
   *
   * The bank id contract (ADR-0068) requires a per-row identifier that is unique within
   * the account. Where a converter synthesises one — a hash of date, amount and narration
   * is the obvious and wrong choice — two legitimately distinct credits collide, and the
   * second is dropped as a redelivery. This is that drop, refused and named: real cash,
   * about to become invisible.
   */
  'BANK_LINE_COLLISION',
  /**
   * A reserve the PSP withheld is past the date it undertook to release it.
   *
   * `psp_reserve` is an asset: the PSP is holding our money, not keeping it. Without a
   * deadline attached, a rolling reserve that is never returned looks exactly like one
   * that has not been returned yet, forever — money quietly not chased (ADR-0071).
   */
  'RESERVE_UNRELEASED',
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
  RESERVE_RELEASED: 'explanation',
  TAX_WITHHELD: 'explanation',
  PENALTY: 'explanation',
  BANK_CHARGE: 'explanation',
  REVERSAL: 'explanation',
  PARTIAL_REVERSAL: 'explanation',
  CHARGEBACK: 'explanation',
  PARTIAL_CHARGEBACK: 'explanation',
  PENDING_T_PLUS_N: 'explanation',
  FX_ROUNDING: 'explanation',

  PHANTOM_CREDIT: 'exception',
  MISSING_SETTLEMENT: 'exception',
  AMOUNT_MISMATCH: 'exception',
  DUPLICATE_BANK_CREDIT: 'exception',
  RETURNED_PAYOUT: 'exception',
  UNIDENTIFIED_CREDIT: 'exception',
  PAYOUT_UNBALANCED: 'exception',
  BATCH_TOO_LARGE: 'exception',
  BANK_LINE_COLLISION: 'exception',
  RESERVE_UNRELEASED: 'exception',
};

export function reasonKind(reason: ReasonCode): ReasonKind {
  return REASON_KIND[reason];
}

/**
 * One candidate the matcher looked at and did not take, and why.
 *
 * This is the working, kept. A `PHANTOM_CREDIT` whose queue entry says "₦12,000 with no
 * promise" is a mystery; one that adds "the nearest promise was ₦11,950, rejected because
 * the amounts differ by ₦50, and one other was ₦12,000 but is already claimed by PO-98" is
 * a decision somebody can make in a minute.
 *
 * Bounded on purpose — see `MAX_CANDIDATES`. A list of every promise in the ledger is not
 * an explanation, it is a haystack with a note attached.
 */
export interface RejectedCandidate {
  /** What was considered: a transaction id, a payout reference, a settlement or bank key. */
  readonly candidateId: string;
  /** Which of the four record kinds it is. Spelled to match `ExceptionSubject`. */
  readonly kind: 'payout' | 'bank_credit' | 'transaction' | 'settlement_line';
  /** How far off it was, where the mismatch was an amount. `null` when it was not. */
  readonly difference: Money | null;
  /** Why it lost, in the matcher's own terms. */
  readonly rejectedBecause: RejectionReason;
}

export type RejectionReason =
  /** The amounts did not agree, and no fee contract explained the gap. */
  | 'amount_differs'
  /** Dated outside the movement's settlement window, or credited before it was sent. */
  | 'outside_window'
  /** Already spoken for by an earlier allocation or confirmation. */
  | 'already_claimed'
  /** It fitted — and so did something else, equally well. Taking either would be a guess. */
  | 'ambiguous'
  /** The reference matched but the lifecycle did not: a clawback against an unsettled promise. */
  | 'wrong_state'
  /**
   * It was never compared, because the search that would have compared it was out of
   * scope: more candidates than the bounded subset search may hold.
   *
   * The distinction from `amount_differs` is the whole reason this exists. "We compared it
   * and it did not fit" and "we never looked at it" are different facts, and a queue entry
   * that conflates them sends a human to check arithmetic nobody performed.
   */
  | 'not_attempted';

/**
 * Four is a judgement, not a truth. It is enough to show the shape of the near-miss and few
 * enough that a queue entry stays readable at a glance.
 */
export const MAX_CANDIDATES = 4;

/** How sure the matcher is, from `0` to `1`. Tier 1 matches are `1`. */
export type Confidence = number;

/**
 * Which fee contract explained one promise inside a conclusion, and what it predicted.
 *
 * A fee model is administered data that changes: rates are renegotiated, a channel-specific
 * contract is added, a typo in a rate card is corrected. Recomputing an old decision
 * against today's table can therefore reach a different answer than the one we acted on —
 * so the answer we acted on is written down at the moment we act, and "why did we accept a
 * ₦165 fee in March?" is answered by a stored contract id rather than by a re-derivation
 * that may no longer reproduce.
 *
 * Every field is nullable for the same honest reason: a payout report names a movement,
 * not a rail, and a source we hold no contract for predicts nothing. `contractId: null`
 * says "we matched this on amounts alone", which is a conclusion worth recording as
 * explicitly as any other.
 */
export interface FeeExplanation {
  readonly transactionId: TransactionId;
  /** The contract version that priced it, or `null` when none covered the payment. */
  readonly contractId: string | null;
  /** The scope that contract was quoted for — a channel, or `'*'` for a blended rate. */
  readonly channel: ChannelScope | null;
  readonly expectedFee: Money | null;
  readonly expectedVat: Money | null;
  /** What the source actually charged, where the source said. */
  readonly observedFee: Money | null;
}

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
  /**
   * The fee contracts that explained this, one per promise the conclusion priced.
   *
   * Empty where no pricing was involved at all — a pending promise, an unidentified
   * credit. Present and contract-less where pricing was attempted and no contract covered
   * it, which is a different thing and is recorded as one.
   */
  readonly explainedBy: readonly FeeExplanation[];
  /**
   * What was looked at and not taken. Populated for conclusions that failed to match,
   * empty for the ones that succeeded — a match has no near-miss worth reporting.
   */
  readonly considered: readonly RejectedCandidate[];
  readonly reason: ReasonCode;
  readonly confidence: Confidence;
}

/** An empty result to spread over — six list fields is five too many to retype. */
export const NO_LINKS = {
  transactionIds: [] as readonly TransactionId[],
  settlementKeys: [] as readonly IdempotencyKey[],
  payoutReferences: [] as readonly PayoutReference[],
  bankCreditKeys: [] as readonly IdempotencyKey[],
  explainedBy: [] as readonly FeeExplanation[],
  considered: [] as readonly RejectedCandidate[],
} as const;
