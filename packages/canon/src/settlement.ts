/**
 * The settlement line — one payment, as it appears inside a PSP's payout report.
 *
 * This is the *second* record of a payment we already hold a promise for, and it belongs
 * to a `Payout`: the PSP grouped it with others into one money movement. The line says
 * what the PSP thinks that payment was worth and what it deducted; the payout says what
 * will actually be sent. Neither is cash until a bank statement agrees.
 */

import type { RowLineage } from './evidence.js';
import type {
  IdempotencyKey,
  MerchantId,
  PayoutReference,
  Reference,
  SourceId,
} from './identifiers.js';
import type { Money } from './money.js';
import { equals, subtract } from './money.js';
import type { PaymentChannel } from './payment.js';

export type SettlementStatus = 'settled' | 'reversed' | 'chargeback';

export interface SettlementLine {
  readonly reference: Reference;
  readonly source: SourceId;
  /**
   * The payout this line belongs to.
   *
   * `null` for sources that report transactions without ever naming the movement that
   * carries them. Those lines have to be grouped by arithmetic instead, which is strictly
   * worse — it is the difference between being told and having to work it out.
   */
  readonly payoutReference: PayoutReference | null;
  /** Whose payment this was. Drives which fee contract applies. */
  readonly merchantId: MerchantId;
  /**
   * Which rail carried it. Also drives which fee contract applies — card and transfer are
   * rarely the same rate — which is why it is a typed field rather than a `reasonHint`
   * somebody downstream would have to parse (ADR-0010).
   */
  readonly channel: PaymentChannel;

  /** What the source says the payment was worth before its deductions. */
  readonly gross: Money;
  /** What the source charged. Always non-negative. */
  readonly fee: Money;
  /** What this line contributes to the payout: `gross - fee`. */
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
   * which would smuggle source-specific logic downstream (the canonical boundary).
   */
  readonly reasonHints: readonly string[];

  readonly evidenceId: string;
  /** Which row of that file. Without it, "reproduce this" means reading five thousand. */
  readonly lineage: RowLineage;
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
 * How much of one payment one settlement line accounts for.
 *
 * Allocation exists because neither side is whole. A PSP can settle one payment across two
 * payouts — half today, half when a dispute hold lifts — and one payout line can cover
 * several payments. Modelling the link as an amount rather than a flag is what lets both
 * be true at once, and what lets a payment be *partly* settled: a state the original
 * one-to-one design could not express, so it would have called it a mismatch and escalated
 * something that was going perfectly well.
 *
 * The invariant that keeps this honest: for any payment, the sum of its allocations may
 * never exceed the receivable it opened. The database enforces it.
 */
export interface Allocation {
  readonly transactionId: string;
  readonly settlementKey: IdempotencyKey;
  readonly amount: Money;
}
