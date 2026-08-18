import type { ExceptionState, Money, ReasonCode, ReasonKind } from '@recon/canon';
import { money, reasonKind } from '@recon/canon';
import type { Executor } from '@recon/ledger-core';

/**
 * What reconciliation did over a period, in the three numbers the business asks for.
 *
 * The doctrine's phrasing is "matched / explained / exceptions per period", and the
 * grouping is not this file's to invent: `reasonKind` in `canon` is the single authority on
 * which bucket a reason code falls into, and a second copy of that mapping in a SQL `CASE`
 * would be a copy that could disagree (D-036).
 *
 * Two of the four sections are deliberately *not* windowed, and the distinction matters.
 * Conclusions and cash are things that happened between two dates. The queue and the money
 * still awaiting a bank credit are things that are true **now** — a payout reported three
 * weeks ago and still unbanked belongs in this month's summary, and a period filter would
 * quietly drop the oldest and most alarming items from the report meant to surface them.
 */
export interface ReconciliationSummary {
  readonly from: Date;
  readonly to: Date;

  /** Every conclusion the matcher reached in the window, by reason. */
  readonly conclusions: readonly ConclusionTally[];
  /** The same, collapsed to the three buckets. The whole engine shrinks the third one. */
  readonly totals: Readonly<Record<ReasonKind, number>>;

  /** The queue as it stands, by reason and state. Not windowed — see above. */
  readonly queue: readonly QueueTally[];

  /**
   * Reported by a PSP and not yet seen by the bank.
   *
   * The most useful single number the three-way model produces, and one a two-way system
   * cannot express at all: money that is neither matched nor missing.
   */
  readonly awaitingBankCredit: { readonly count: number; readonly expectedNet: Money };

  /** What actually reached the bank account in the window, on bank evidence alone. */
  readonly banked: { readonly transactions: number; readonly credited: Money };
}

export interface ConclusionTally {
  readonly reason: ReasonCode;
  readonly kind: ReasonKind;
  readonly count: number;
}

export interface QueueTally {
  readonly reason: ReasonCode;
  readonly state: ExceptionState;
  readonly count: number;
  /** What the entries in this bucket are worth, where they state a value. */
  readonly amount: Money;
}

export interface SummaryWindow {
  readonly from: Date;
  /** Exclusive, so consecutive periods neither overlap nor leave a gap. */
  readonly to: Date;
}

export async function summarize(
  db: Executor,
  window: SummaryWindow,
): Promise<ReconciliationSummary> {
  const conclusions = await db.query<{ reason: ReasonCode; count: string }>(
    `SELECT reason, COUNT(*)::text AS count
       FROM matches WHERE at >= $1 AND at < $2
      GROUP BY reason ORDER BY reason`,
    [window.from, window.to],
  );

  const queue = await db.query<{
    reason: ReasonCode;
    state: ExceptionState;
    count: string;
    amount: string;
  }>(
    `SELECT reason, state, COUNT(*)::text AS count,
            COALESCE(SUM(amount_kobo), 0)::text AS amount
       FROM exceptions WHERE state <> 'resolved'
      GROUP BY reason, state ORDER BY reason, state`,
  );

  const awaiting = await db.query<{ count: string; expected: string }>(
    `SELECT COUNT(*)::text AS count, COALESCE(SUM(expected_net_kobo), 0)::text AS expected
       FROM expected_inflows WHERE confirmed_by IS NULL`,
  );

  // Cash, counted from the ledger rather than from the matcher's own report of itself. A
  // summary that asked the matcher how much it had banked would agree with the matcher by
  // construction; asking the entries makes the number checkable against Law 1.
  const banked = await db.query<{ transactions: string; credited: string }>(
    `SELECT COUNT(DISTINCT e.transaction_id)::text AS transactions,
            COALESCE(SUM(e.amount_kobo), 0)::text AS credited
       FROM entries e
       JOIN ledger_transactions t ON t.transaction_id = e.transaction_id
      WHERE e.account_id = 'bank_account'
        AND t.recorded_at >= $1 AND t.recorded_at < $2`,
    [window.from, window.to],
  );

  const totals: Record<ReasonKind, number> = { match: 0, explanation: 0, exception: 0 };
  const tallies = conclusions.rows.map((row): ConclusionTally => {
    const kind = reasonKind(row.reason);
    totals[kind] += Number(row.count);
    return { reason: row.reason, kind, count: Number(row.count) };
  });

  return {
    from: window.from,
    to: window.to,
    conclusions: tallies,
    totals,
    queue: queue.rows.map((row) => ({
      reason: row.reason,
      state: row.state,
      count: Number(row.count),
      amount: money(BigInt(row.amount)),
    })),
    awaitingBankCredit: {
      count: Number(awaiting.rows[0]?.count ?? '0'),
      expectedNet: money(BigInt(awaiting.rows[0]?.expected ?? '0')),
    },
    banked: {
      transactions: Number(banked.rows[0]?.transactions ?? '0'),
      credited: money(BigInt(banked.rows[0]?.credited ?? '0')),
    },
  };
}
