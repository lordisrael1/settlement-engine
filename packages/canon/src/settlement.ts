/**
 * The money — the slow settled cash, as reported by a settlement source.
 *
 * Produced by the settlement half of the ingest layer. This is the second, independent
 * record of the same reality that the ledger already holds a promise for; reconciliation
 * is the act of proving the two agree.
 */

import type { IdempotencyKey, Reference, SourceId } from './identifiers.js';
import type { Money } from './money.js';
import { equals, subtract } from './money.js';

export type SettlementStatus = 'settled' | 'reversed' | 'chargeback';

export interface SettlementLine {
  readonly reference: Reference;
  readonly source: SourceId;

  /** What the source says the payment was worth before its fee. */
  readonly gross: Money;
  /** What the source charged. Always non-negative. */
  readonly fee: Money;
  /** What actually landed: `gross - fee`. */
  readonly net: Money;

  readonly status: SettlementStatus;
  /**
   * When the money moved, per the source — `null` when the source does not disclose it.
   *
   * Nullable rather than defaulted, because the honest alternatives are worse: falling
   * back to the transaction's own timestamp would fabricate a settlement date that reads
   * as authoritative, and rejecting the line would discard real money over a missing
   * field. A null here means "this source told us money moved but not when", and the
   * matcher must reason with the promise's timestamp instead.
   */
  readonly settledAt: Date | null;

  /**
   * Free-text notes the source attached (narration, reason strings). Retained verbatim
   * for exception context and as evidence for a match — never parsed to make a decision,
   * which would smuggle source-specific logic downstream (Law 7).
   */
  readonly reasonHints: readonly string[];

  readonly idempotencyKey: IdempotencyKey;
}

/**
 * A settlement line's own internal consistency: `gross - fee == net`.
 * Checked at the ingest boundary, so a line that lies about its own arithmetic is
 * rejected before it can reach the matcher.
 */
export function isSelfConsistent(line: SettlementLine): boolean {
  return equals(subtract(line.gross, line.fee), line.net);
}

/**
 * How long after a payment its money is expected to arrive, declared by each source's
 * adapter. Card and PSP-aggregated channels are T+1..T+2; NIP transfers and
 * virtual-account credits are near-instant.
 *
 * This is what makes "not yet settled" distinguishable from "missing", and it travels
 * as *data* attached to the source — never as a branch on which source it is.
 */
export interface SettlementWindow {
  /**
   * Minutes after the payment occurred, past which an unmatched promise is overdue
   * and escalates. T+1..T+2 is `2880`; near-instant channels are minutes.
   *
   * Only the deadline is modelled. A lower bound would be unused: money arriving
   * earlier than expected is still money, and matching it is never an error.
   */
  readonly deadlineMinutes: number;
}

/**
 * `asOf` is passed in rather than read from the clock, so that the same inputs always
 * produce the same answer and a reconciliation run can be replayed (Law 5).
 */
export function isWithinWindow(
  window: SettlementWindow,
  occurredAt: Date,
  asOf: Date,
): boolean {
  const elapsedMinutes = (asOf.getTime() - occurredAt.getTime()) / 60_000;
  return elapsedMinutes <= window.deadlineMinutes;
}
