import type { LedgerTransaction, MatchResult, Money, TransactionId } from '@recon/canon';
import type { Executor } from '@recon/ledger-core';
import {
  bookBankConfirmedSettlement,
  bookChargeback,
  bookReversal,
  getTransaction,
  inTransaction,
  listByState,
} from '@recon/ledger-core';

import {
  allocate,
  confirm,
  receivableOf,
  type AllocateResult,
  type ConfirmResult,
  type PreparedInflow,
} from './match.js';
import type { PolicyLookup } from './policy.js';
import {
  allocatedByTransaction,
  allocationsOf,
  confirmInflow,
  openInflows,
  recordMatch,
  saveInflow,
  unallocatedPayouts,
  unallocatedSettlementLines,
  unmatchedBankLines,
} from './store.js';
import type { SubsetLimits } from './subset.js';

/**
 * One reconciliation run: both stages, in the order the money moves.
 *
 *   stage two    the PSP's report meets the ledger. Promises are allocated to the
 *                movements that will carry them, deductions are named, and an expected
 *                inflow is recorded. **Not one ledger entry is written.**
 *   stage three  the bank statement meets the report. A credit that confirms an inflow
 *                books the cash, the fees, the taxes and the reserves in a single
 *                transaction, and closes the receivable.
 *
 * Running it twice is safe and boring. The second run finds no unallocated payouts and no
 * unmatched credits; and even if it somehow did, the booking's primary key is the bank
 * credit's idempotency key, and a partial unique index already forbids one credit
 * confirming two inflows. Two independent refusals, neither of which we have to remember.
 */
export interface ReconcileInput {
  /** The clock, as an argument. Nothing in here ever calls `new Date()` (Law 5). */
  readonly asOf: Date;
  readonly policyFor: PolicyLookup;
  readonly limit?: number;
  readonly limits?: SubsetLimits;
}

export interface Booked {
  readonly matchId: string;
  readonly reason: MatchResult['reason'];
  readonly transactionId: string;
  readonly outcome: 'posted' | 'duplicate';
}

/** A conclusion the ledger refused to book, kept rather than thrown. */
export interface BookingFailure {
  readonly matchId: string;
  readonly reason: MatchResult['reason'];
  readonly error: string;
}

export interface ReconciliationRun {
  readonly asOf: Date;
  /** Stage two: what is now expected, and from whom. Books nothing. */
  readonly allocation: AllocateResult;
  /** Stage three: what the bank confirmed. */
  readonly confirmation: ConfirmResult;
  readonly booked: readonly Booked[];
  readonly failures: readonly BookingFailure[];
  /** Every conclusion, from both stages, for reporting. */
  readonly deferred: readonly MatchResult[];
  readonly exceptions: readonly MatchResult[];
}

export async function reconcile(
  db: Executor,
  input: ReconcileInput,
): Promise<ReconciliationRun> {
  const limit = input.limit ?? 1000;
  const booked: Booked[] = [];
  const failures: BookingFailure[] = [];

  // ── Stage two ─────────────────────────────────────────────────────────────
  const allocated = await allocatedByTransaction(db);
  const transactions = await loadCandidates(db, limit);

  const allocation = allocate({
    transactions,
    allocated,
    payouts: await unallocatedPayouts(db, limit),
    lines: await unallocatedSettlementLines(db, limit),
    policyFor: input.policyFor,
    asOf: input.asOf,
    ...(input.limits ? { limits: input.limits } : {}),
  });

  const receivables = new Map<TransactionId, Money>(
    transactions.map((transaction) => [transaction.transactionId, receivableOf(transaction)]),
  );

  for (const prepared of allocation.prepared) {
    // A reversal or a clawback is not an expected inflow: no money is coming, so there is
    // nothing for a bank statement to confirm and nothing to gain by waiting.
    if (prepared.result.reason === 'REVERSAL' || prepared.result.reason === 'CHARGEBACK') {
      await bookImmediately(db, prepared, receivables, input.asOf, booked, failures);
      continue;
    }

    await saveInflow(db, prepared.inflow, prepared.allocations, input.asOf);
    await recordMatch(db, `allocate:${prepared.inflow.key}`, prepared.result, null, input.asOf);
  }

  // ── Stage three ───────────────────────────────────────────────────────────
  const confirmation = confirm({
    inflows: await openInflows(db, limit),
    bankLines: await unmatchedBankLines(db, limit),
    policyFor: input.policyFor,
    asOf: input.asOf,
  });

  for (const settled of confirmation.confirmed) {
    const allocations = await allocationsOf(db, settled.inflow.key);
    const discharged = allocations.map((allocation) => ({
      transactionId: allocation.transactionId,
      receivable: receivables.get(allocation.transactionId) ?? allocation.amount,
      amount: allocation.amount,
    }));

    try {
      const outcome = await inTransaction(db, async (client) => {
        const posted = await bookBankConfirmedSettlement(
          client,
          {
            creditKey: settled.credit.idempotencyKey,
            source: settled.inflow.source,
            reference: settled.inflow.key,
            valueDate: settled.credit.valueDate,
            recordedAt: input.asOf,
            credited: settled.credit.amount,
          },
          discharged,
          settled.deductions,
        );

        if (posted.outcome === 'posted') {
          await confirmInflow(
            client,
            settled.inflow.key,
            settled.credit.idempotencyKey,
            input.asOf,
          );
          await recordMatch(
            client,
            `confirm:${settled.credit.idempotencyKey}`,
            settled.result,
            posted.transactionId,
            input.asOf,
          );
        }
        return posted.outcome;
      });

      booked.push({
        matchId: `confirm:${settled.credit.idempotencyKey}`,
        reason: settled.result.reason,
        transactionId: settled.credit.idempotencyKey,
        outcome,
      });
    } catch (error) {
      failures.push({
        matchId: `confirm:${settled.credit.idempotencyKey}`,
        reason: settled.result.reason,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return {
    asOf: input.asOf,
    allocation,
    confirmation,
    booked,
    failures,
    deferred: [...allocation.deferred, ...confirmation.deferred],
    exceptions: [...allocation.exceptions, ...confirmation.exceptions],
  };
}

/**
 * Reversals and chargebacks book on the spot.
 *
 * They are the two conclusions that do not wait for a bank credit — a refund means no
 * money is coming, and a clawback's own bank debit is already the evidence. Waiting for a
 * confirmation that will never arrive would leave both sitting in the queue forever.
 */
async function bookImmediately(
  db: Executor,
  prepared: PreparedInflow,
  receivables: ReadonlyMap<TransactionId, Money>,
  asOf: Date,
  booked: Booked[],
  failures: BookingFailure[],
): Promise<void> {
  const allocation = prepared.allocations[0];
  const key = prepared.inflow.key;
  const matchId = `resolve:${key}`;

  if (!allocation) {
    failures.push({ matchId, reason: prepared.result.reason, error: 'no promise to act on' });
    return;
  }

  const event = {
    key,
    source: prepared.inflow.source,
    reference: allocation.transactionId,
    at: prepared.inflow.valueDate ?? asOf,
  };

  try {
    const outcome = await inTransaction(db, async (client) => {
      const posted =
        prepared.result.reason === 'REVERSAL'
          ? await bookReversal(client, event, {
              transactionId: allocation.transactionId,
              receivable: receivables.get(allocation.transactionId) ?? allocation.amount,
              amount: allocation.amount,
            })
          : await bookChargeback(client, event, allocation.amount);

      if (posted.outcome === 'posted') {
        await recordMatch(client, matchId, prepared.result, posted.transactionId, asOf);
      }
      return posted.outcome;
    });

    booked.push({ matchId, reason: prepared.result.reason, transactionId: key, outcome });
  } catch (error) {
    failures.push({
      matchId,
      reason: prepared.result.reason,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * The promises worth considering.
 *
 * `authorized` and `exception` are the ones waiting for money — an exception is a question
 * a late settlement file can still answer, which is why it is not a terminal state (D-016).
 * `settled` transactions come too, because a chargeback can only apply to money that
 * already landed, and it needs to find the payment it is clawing back.
 */
async function loadCandidates(db: Executor, limit: number): Promise<LedgerTransaction[]> {
  const byId = new Map<string, LedgerTransaction>();

  for (const state of ['authorized', 'exception', 'settled'] as const) {
    for (const transaction of await listByState(db, state, limit)) {
      // Only promises: settlement bookings and reversals credit the receivable rather than
      // debiting it, so `receivableOf` excludes them without anybody having to remember.
      if (receivableOf(transaction).kobo <= 0n) continue;
      byId.set(transaction.transactionId, transaction);
    }
  }

  return [...byId.values()];
}

