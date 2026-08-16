import type {
  AccountId,
  IdempotencyKey,
  Money,
  Payout,
  SettlementLine,
  SourceId,
  TransactionId,
} from '@recon/canon';
import { adjustmentEntries, subtract, sum, ZERO } from '@recon/canon';

/**
 * One inflow we have been told to expect, and are waiting on the bank to confirm.
 *
 * This is the abstraction that makes stage three tractable. Sources tell us about coming
 * money in two different shapes: some name the **payout** — one movement, its own
 * reference, its own itemised deductions — and some only list the **transactions**, leaving
 * the movement implicit. A bank credit has to be matched against either, and writing that
 * matcher twice would be two chances to get it subtly differently wrong.
 *
 * So both shapes are normalised into this, and stage three knows only this. What survives
 * the normalisation is exactly what the bank matcher needs: how much to expect, when, from
 * whom, which promises it discharges, and what was deducted along the way.
 *
 * The `derived` flag is not decoration. An inflow built from a payout is something the PSP
 * *told* us; one built from a group of transactions is something we *inferred*, and a
 * human reading an exception deserves to know which of those they are looking at.
 */
export interface ExpectedInflow {
  /** The payout reference, or a derived key for an inferred grouping. */
  readonly key: string;
  readonly source: SourceId;
  /** `false` when a PSP named this movement; `true` when we grouped it ourselves. */
  readonly derived: boolean;

  /** Sum of the promises this inflow discharges, before deductions. */
  readonly gross: Money;
  /** What we expect the bank to credit. */
  readonly expectedNet: Money;
  /** Named deductions, already collapsed to one entry per account. */
  readonly deductions: readonly { accountId: AccountId; amount: Money }[];

  /** When the money is expected to move. `null` when nobody said (D-019). */
  readonly valueDate: Date | null;
  readonly settlementKeys: readonly IdempotencyKey[];
  readonly evidenceId: string;
}

/** A promise, and how much of it an inflow discharges. */
export interface InflowAllocation {
  readonly transactionId: TransactionId;
  readonly receivable: Money;
  readonly amount: Money;
}

/**
 * Build an inflow from a payout the PSP named.
 *
 * The gross comes from the promises we allocated, not from the payout's own `gross` field.
 * Those two should agree, and when they do not it is the allocation that has to balance
 * against the ledger — the receivable being discharged is a fact about our books, while
 * the payout's gross is a claim about theirs.
 */
export function inflowFromPayout(
  payout: Payout,
  allocations: readonly InflowAllocation[],
): ExpectedInflow {
  return {
    key: payout.payoutReference,
    source: payout.source,
    derived: false,
    gross: sum(allocations.map((allocation) => allocation.amount)),
    expectedNet: payout.expectedNet,
    deductions: adjustmentEntries(payout.adjustments),
    valueDate: payout.valueDate,
    settlementKeys: [],
    evidenceId: payout.evidenceId,
  };
}

/**
 * Build an inflow from settlement lines a source reported without naming their movement.
 *
 * The grouping is ours, so it is keyed by the only two things that can honestly define it:
 * the source, and the day the money moved. Lines that settled on the same day from the same
 * PSP arrive in the same credit far more often than not — but "far more often than not" is
 * why this is marked `derived`, and why a bank credit that does not match it escalates
 * rather than being forced.
 *
 * The deduction is the difference between what the promises were worth and what the lines
 * say will arrive. It books as a fee because that is what a source reporting only
 * transactions has told us it is; a source that itemises tax and reserves separately
 * reports payouts, and takes the other path.
 */
export function inflowFromLines(
  source: SourceId,
  valueDate: Date | null,
  lines: readonly SettlementLine[],
  allocations: readonly InflowAllocation[],
): ExpectedInflow {
  const gross = sum(allocations.map((allocation) => allocation.amount));
  const expectedNet = sum(lines.map((line) => line.net));
  const fee = subtract(gross, expectedNet);

  return {
    key: derivedKey(source, valueDate),
    source,
    derived: true,
    gross,
    expectedNet,
    deductions: fee.kobo === 0n ? [] : [{ accountId: 'fees_expense', amount: fee }],
    valueDate,
    settlementKeys: lines.map((line) => line.idempotencyKey),
    evidenceId: lines[0]?.evidenceId ?? '',
  };
}

export function derivedKey(source: SourceId, valueDate: Date | null): string {
  return `derived:${source}:${valueDate ? valueDate.toISOString().slice(0, 10) : 'undated'}`;
}

/**
 * Does the inflow's own arithmetic close?
 *
 * `gross − deductions − expectedNet`. Zero means the promises, the deductions and the
 * expected credit tell one consistent story, and the booking will balance without a plug.
 * Anything else means somebody's numbers are missing something, and it is worth knowing
 * before a bank credit arrives rather than at the moment we try to post.
 */
export function inflowShortfall(inflow: ExpectedInflow): Money {
  const deducted = sum(inflow.deductions.map((deduction) => deduction.amount));
  return subtract(subtract(inflow.gross, deducted), inflow.expectedNet);
}

export function totalDeductions(inflow: ExpectedInflow): Money {
  return inflow.deductions.length === 0
    ? ZERO
    : sum(inflow.deductions.map((deduction) => deduction.amount));
}
