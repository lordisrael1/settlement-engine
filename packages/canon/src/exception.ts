/**
 * The exception — a difference nobody has explained yet, with a life of its own.
 *
 * Matching produces conclusions: every run partitions the world into matched, explained and
 * unexplained, and wrote down what it decided. What it could not do is remember. Each run
 * rediscovered the same unexplained difference, reported it again, and had no way to say
 * whether a human had already looked at it, whether it had been there for a week, or whether
 * it had quietly gone away.
 *
 * So an exception is promoted from a *finding* to an *entity*. Three consequences follow,
 * and they are the whole of this file:
 *
 *   **It has an identity.** `(subject, reason)` — the same difference found twice is one
 *   exception seen twice, not two exceptions. Without this, a queue grows by the number of
 *   runs rather than by the number of problems, and nobody reads it by Thursday.
 *
 *   **It has a lifecycle, and the lifecycle is appended.** `open → acknowledged → resolved`,
 *   recorded as events exactly as the ledger records its own transitions. A mutable `state`
 *   column would be an `UPDATE`, and `UPDATE`s are how history gets quietly rewritten
 *   (append-only).
 *
 *   **It carries what the matcher rejected.** An exception that says "unidentified" without
 *   saying what was considered is a question passed to a human with the working thrown away.
 *   The near-misses, and why each lost, are the difference between a minute's work and an
 *   escalation to whoever wrote the matcher.
 */

import type { IdempotencyKey, PayoutReference, TransactionId } from './identifiers.js';
import type { ReasonCode, RejectedCandidate } from './matching.js';
import type { Money } from './money.js';

/**
 * What the exception is *about*.
 *
 * Deliberately the same four kinds a `Resolution` can address, because the two are answers
 * to each other: an exception is a question about one of these, and a resolution is a
 * person's answer to it. Two vocabularies for one set of things is what `canon` exists to
 * prevent.
 */
export type ExceptionSubject = 'payout' | 'bank_credit' | 'transaction' | 'settlement_line';

export type ExceptionState =
  /** The matcher raised it and nobody has picked it up. */
  | 'open'
  /** A named human has it. Still unexplained, but no longer unowned. */
  | 'acknowledged'
  /**
   * Answered — by a person appending a resolution, or by the evidence finally arriving.
   *
   * Not terminal in the way a settled transaction is terminal: the same difference can
   * recur, and when it does it is a new observation of a problem that came back, which is
   * worth knowing. Reopening appends; it does not revive the old row.
   */
  | 'resolved';

const ALLOWED: Readonly<Record<ExceptionState, readonly ExceptionState[]>> = {
  open: ['acknowledged', 'resolved'],
  acknowledged: ['resolved', 'open'],
  resolved: ['open'],
};

export function canTransition(from: ExceptionState, to: ExceptionState): boolean {
  return ALLOWED[from].includes(to);
}

/**
 * Why an exception stopped being one.
 *
 * The distinction that matters operationally is machine versus human. `evidence_arrived` is
 * the settlement file that turned up two days late and made the question moot — the single
 * most common outcome, and the one that must never require a person. `resolved_by_human` is
 * somebody deciding. Conflating them would hide how much of the queue is self-clearing,
 * which is the number that tells you whether the calendar is tuned correctly.
 */
export type ResolutionCause =
  /** The matcher no longer reaches this conclusion: the missing record arrived. */
  | 'evidence_arrived'
  /** A person appended a resolution. Its key travels with the event. */
  | 'resolved_by_human'
  /** Superseded: the same subject now has a different, more specific problem. */
  | 'superseded';

/**
 * A difference the machine could not explain, as it stands right now.
 *
 * `key` is derived from the subject and the reason rather than generated, so that the same
 * difference found on Monday and again on Tuesday is one exception with one history — and
 * so that a replay reaches the same keys (determinism).
 */
export interface ReconciliationException {
  readonly key: string;
  readonly subject: ExceptionSubject;
  readonly subjectId: string;
  readonly reason: ReasonCode;
  readonly state: ExceptionState;

  /** What the difference is worth, where it has a value. */
  readonly amount: Money | null;
  /** When the money was expected, for the ones that are about lateness. */
  readonly dueAt: Date | null;
  /** The file this traces back to, so the queue entry can show the evidence. */
  readonly evidenceId: string | null;

  readonly transactionIds: readonly TransactionId[];
  readonly payoutReferences: readonly PayoutReference[];
  readonly bankCreditKeys: readonly IdempotencyKey[];
  readonly settlementKeys: readonly IdempotencyKey[];

  /** The working: what was considered and why it was not taken. */
  readonly considered: readonly RejectedCandidate[];

  readonly raisedAt: Date;
  /** When it reached its current state. */
  readonly since: Date;
  /** Who owns it, once somebody does. */
  readonly acknowledgedBy: string | null;
  readonly resolvedCause: ResolutionCause | null;
  /** The `Resolution` that answered it, where a human did. */
  readonly resolutionKey: string | null;
}

/** ASCII unit separator: a control character that cannot occur in an id or a reason code. */
const SEPARATOR = String.fromCharCode(31);

/**
 * The natural key of a difference.
 *
 * Derived, never generated. A `randomUUID` here would make the same problem found twice
 * into two problems, and would make a replay disagree with the run it replays (determinism).
 */
export function exceptionKey(
  subject: ExceptionSubject,
  subjectId: string,
  reason: ReasonCode,
): string {
  return [subject, subjectId, reason].join(SEPARATOR);
}

/**
 * How urgently a human should look, from the reason alone.
 *
 * Not every unexplained difference is equally alarming, and a queue sorted by arrival time
 * buries the alarming ones under the routine ones. Money that arrived and belongs to nobody
 * outranks money that has not arrived yet, because the first may have to be sent back and
 * the second is usually just late.
 */
export const EXCEPTION_SEVERITY: Readonly<Partial<Record<ReasonCode, number>>> = {
  /** Cash we hold, attached to nothing. It may be somebody else's, and it may be fraud. */
  PHANTOM_CREDIT: 3,
  UNIDENTIFIED_CREDIT: 3,
  DUPLICATE_BANK_CREDIT: 3,
  /** Cash we booked and then lost again. The books said we had it. */
  RETURNED_PAYOUT: 3,
  /**
   * Two statement rows wearing one identity. Ranked with the cash-in-hand findings because
   * that is what it is: a credit that was about to be discarded as a redelivery, which
   * means real money in the account that the books would never have seen (ADR-0068).
   */
  BANK_LINE_COLLISION: 3,
  /** Two records about one event that certainly disagree. */
  AMOUNT_MISMATCH: 2,
  /** The PSP's own file does not add up. */
  PAYOUT_UNBALANCED: 2,
  /**
   * A payout too large for the bounded search. Ranked above lateness because nothing else
   * will ever resolve it: unlike a straggler, no later evidence makes this clear itself —
   * either the batch shrinks, the bound is raised, or a human matches it by hand.
   */
  BATCH_TOO_LARGE: 2,
  /** Our money, held past the date it was due back. Late, and nobody is chasing it. */
  RESERVE_UNRELEASED: 2,
  /** Money we are owed and have not received. Usually late; occasionally gone. */
  MISSING_SETTLEMENT: 1,
};

export function severityOf(reason: ReasonCode): number {
  return EXCEPTION_SEVERITY[reason] ?? 1;
}
