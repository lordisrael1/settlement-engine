/**
 * The ledger vocabulary — the double-entry record itself.
 *
 * A balance is never a fact; it is the sum of the entries below. Nothing in this file
 * describes a stored balance, because there is no such thing.
 */

import type { AccountId } from './accounts.js';
import type { EntryId, IdempotencyKey, Reference, SourceId, TransactionId } from './identifiers.js';
import type { Money } from './money.js';
import type { PaymentChannel } from './payment.js';

/**
 * The lifecycle of a transaction *is* the story of the gap between information and money.
 *
 *   authorized → settled     the money arrived and was matched
 *   authorized → reversed    the promise was undone
 *   authorized → exception   the money never came, past its settlement window
 *
 * The state is never edited in place on the entries; transitions are recorded (Law 2).
 */
export type TransactionState = 'authorized' | 'settled' | 'reversed' | 'exception';

/**
 * One line of a transaction. `amount` is signed: positive debits the account,
 * negative credits it.
 */
export interface Entry {
  readonly entryId: EntryId;
  readonly transactionId: TransactionId;
  readonly accountId: AccountId;
  readonly amount: Money;
}

/**
 * A single economic event. Its entries sum to exactly zero (Law 1) and are never
 * updated or deleted (Law 2).
 */
export interface LedgerTransaction {
  /**
   * **The transaction's id is the causing event's idempotency key.** A transaction is
   * the record of exactly one event, so giving it any other identity would mean
   * maintaining a second uniqueness constraint that could disagree with the first.
   * With this equality, Law 4 is enforced by the primary key itself: the same event
   * posted twice collides on insert and the duplicate is dropped, with no read-then-write
   * race for concurrent workers to lose.
   */
  readonly transactionId: TransactionId & IdempotencyKey;
  readonly state: TransactionState;
  readonly entries: readonly Entry[];

  /** The source and its reference, carried for audit and matching — never branched on. */
  readonly source: SourceId;
  readonly reference: Reference;
  /**
   * Which rail carried the payment this transaction records, where one did.
   *
   * `null` for transactions that are not about a single payment — a settlement booking
   * covering a batch, a manual adjustment. It is here rather than in a side table because
   * the fee a promise is expected to attract depends on it, and a matcher that has to go
   * looking for the channel will eventually stop looking and assume card.
   */
  readonly channel: PaymentChannel | null;

  /** When it happened in the world. Drives settlement windows. */
  readonly occurredAt: Date;
  /** When we learned of it. Never used to derive a number (Law 5). */
  readonly recordedAt: Date;
}

/** A recorded state change. Appended, never overwritten. */
export interface TransactionStateChange {
  readonly transactionId: TransactionId;
  readonly from: TransactionState;
  readonly to: TransactionState;
  readonly at: Date;
  /** The transaction that caused the change — a settlement booking, a reversal. */
  readonly causedBy: TransactionId | null;
}
