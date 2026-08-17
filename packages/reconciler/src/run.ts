import type {
  ExceptionSubject,
  LedgerTransaction,
  MatchResult,
  Money,
  TransactionId,
} from '@recon/canon';
import type { Executor } from '@recon/ledger-core';
import {
  bookBankConfirmedSettlement,
  bookChargeback,
  bookReturnedPayout,
  bookReversal,
  getTransaction,
  inTransaction,
  listByState,
  transition,
} from '@recon/ledger-core';

import {
  clearVanished,
  draftFrom,
  raiseExceptions,
  type ExceptionDraft,
} from './exceptions.js';
import {
  allocate,
  confirm,
  receivableOf,
  type AllocateResult,
  type ConfirmResult,
  type PreparedInflow,
  type ReturnedPayout,
} from './match.js';
import type { PolicyLookup } from './policy.js';
import {
  allocatedByTransaction,
  allocationsOf,
  confirmedInflows,
  confirmInflow,
  markPayoutReturned,
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
  /** What this run did to the queue: raised, left alone, reopened, cleared. */
  readonly queue: {
    readonly raised: number;
    readonly unchanged: number;
    readonly reopened: number;
    readonly cleared: number;
  };
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
    // Already banked. Not candidates — the evidence that lets a second credit for the same
    // payout, and a debit taking one back, be recognised as what they are.
    confirmedInflows: await confirmedInflows(db, limit),
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

  // ── The bank took it back ─────────────────────────────────────────────────
  for (const returned of confirmation.returned) {
    await bookReturn(db, returned, input.asOf, booked, failures);
  }

  // A returned payout books *and* escalates, which is why it is gathered from both places.
  // It is the one conclusion that moves money and still needs a human: the cash left, the
  // books are right again, and somebody has to find out why the bank sent it back.
  const exceptions = [
    ...allocation.exceptions,
    ...confirmation.exceptions,
    ...confirmation.returned.map((entry) => entry.result),
  ];

  // ── The queue ─────────────────────────────────────────────────────────────
  //
  // Findings become durable, deduplicated items with a lifecycle; items this run no longer
  // finds are closed. The second half is what stops the queue growing by the number of runs
  // rather than by the number of problems.
  const drafts = exceptions
    .map((result) => draftFrom(result, amountOf(result, allocation, confirmation)))
    .filter((draft): draft is ExceptionDraft => draft !== null);

  const raised = await raiseExceptions(db, drafts, input.asOf);
  const cleared = await clearVanished(db, drafts, SUBJECTS_THIS_RUN_JUDGED, input.asOf);

  // A promise past its window and its grace is not merely unmatched — it is a question the
  // ledger itself should be able to answer. `exception` is deliberately non-terminal: a
  // settlement file that turns up late still clears it.
  for (const result of exceptions) {
    if (result.reason !== 'MISSING_SETTLEMENT') continue;
    for (const transactionId of result.transactionIds) {
      try {
        await transition(db, {
          transactionId,
          to: 'exception',
          at: input.asOf,
          causedBy: null,
        });
      } catch (error) {
        // A promise that reached a terminal state between the match and this write is not a
        // failure of the run — it is the answer arriving while we were asking the question.
        failures.push({
          matchId: `escalate:${transactionId}`,
          reason: result.reason,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  return {
    asOf: input.asOf,
    allocation,
    confirmation,
    booked,
    failures,
    deferred: [...allocation.deferred, ...confirmation.deferred],
    exceptions,
    queue: { ...raised, cleared },
  };
}

/**
 * Which kinds of subject this run was in a position to judge.
 *
 * Every run reads all three records, so every run can speak to all four subjects — and
 * anything it does not find again really has gone away. A future partial run (one source
 * only, say) must narrow this, because treating silence as "resolved" would close problems
 * that are still entirely real.
 */
const SUBJECTS_THIS_RUN_JUDGED: readonly ExceptionSubject[] = [
  'payout',
  'bank_credit',
  'transaction',
  'settlement_line',
];

/**
 * What the difference is worth, dug out of whichever stage produced it.
 *
 * A queue entry without an amount is a queue entry nobody can triage — "PO-91 is
 * unexplained" and "PO-91 is unexplained, ₦4.2m" are different mornings.
 */
function amountOf(
  result: MatchResult,
  allocation: AllocateResult,
  confirmation: ConfirmResult,
): Money | null {
  const returned = confirmation.returned.find((entry) =>
    result.bankCreditKeys.includes(entry.debit.idempotencyKey),
  );
  if (returned) return returned.debit.amount;

  const prepared = allocation.prepared.find((entry) =>
    result.payoutReferences.includes(entry.inflow.key),
  );
  return prepared?.inflow.expectedNet ?? null;
}

/**
 * Cash that arrived and then left again.
 *
 * Booked as an exact negation of the transaction that confirmed it, written as its own
 * event rather than by unwinding the original (Law 2). Every account it touched moves back,
 * which means the receivable reopens: the PSP still owes us, and the payments the payout
 * covered go back to waiting.
 */
async function bookReturn(
  db: Executor,
  returned: ReturnedPayout,
  asOf: Date,
  booked: Booked[],
  failures: BookingFailure[],
): Promise<void> {
  const matchId = `return:${returned.debit.idempotencyKey}`;

  try {
    const original = await getTransaction(db, returned.inflow.confirmedBy);
    if (!original) {
      failures.push({
        matchId,
        reason: returned.result.reason,
        error: `no confirming transaction "${returned.inflow.confirmedBy}" to reverse`,
      });
      return;
    }

    const outcome = await inTransaction(db, async (client) => {
      const posted = await bookReturnedPayout(
        client,
        {
          key: returned.debit.idempotencyKey,
          source: returned.inflow.source,
          reference: returned.inflow.key,
          at: returned.debit.valueDate,
        },
        original.entries.map((entry) => ({
          accountId: entry.accountId,
          amount: entry.amount,
        })),
      );

      if (posted.outcome === 'posted') {
        // Recorded on the payout rather than by clearing the confirmation: the money
        // genuinely did arrive and genuinely did leave, and both halves belong in history.
        await markPayoutReturned(client, returned.inflow.key);
        await recordMatch(client, matchId, returned.result, posted.transactionId, asOf);
      }
      return posted.outcome;
    });

    booked.push({
      matchId,
      reason: returned.result.reason,
      transactionId: returned.debit.idempotencyKey,
      outcome,
    });
  } catch (error) {
    failures.push({
      matchId,
      reason: returned.result.reason,
      error: error instanceof Error ? error.message : String(error),
    });
  }
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

