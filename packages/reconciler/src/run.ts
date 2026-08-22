import type {
  LedgerTransaction,
  MatchResult,
  Money,
  TransactionId,
} from '@recon/canon';
import { sum, ZERO } from '@recon/canon';
import type { Executor } from '@recon/ledger-core';
import {
  bookBankConfirmedSettlement,
  bookChargeback,
  bookReserveRelease,
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
  type ClearScope,
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
import { recordReserveMovement, unreleasedReserves } from './reserves.js';
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
  /** The clock, as an argument. Nothing in here ever calls `new Date()` (determinism). */
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
  /** What this run did to the queue: raised, left alone, reopened, cleared, withheld. */
  readonly queue: {
    readonly raised: number;
    readonly unchanged: number;
    readonly reopened: number;
    readonly cleared: number;
    /**
     * Not found this run, and deliberately left open anyway: outside the run's window, or
     * acknowledged by a human. See `clearVanished`.
     *
     * The number to watch. Zero is the healthy state; a figure that persists across runs
     * says the queue's subjects no longer fit inside `limit`, and the auto-clearing this
     * whole phase exists for has quietly stopped working.
     */
    readonly withheld: number;
  };
  /**
   * How much of each record this run actually read, and whether it reached the end.
   *
   * Reported because every bound in here is invisible from the outside: a run that looked
   * at the first thousand payouts of four thousand produces a report that looks exactly
   * like a run that looked at all of them. `truncated` anywhere means the conclusions
   * below are about a sample.
   */
  readonly window: {
    readonly transactions: WindowReport;
    readonly payouts: WindowReport;
    readonly settlementLines: WindowReport;
    readonly bankLines: WindowReport;
  };
}

/** How many records of one kind a run loaded, and whether that was all of them. */
export interface WindowReport {
  readonly loaded: number;
  readonly truncated: boolean;
}

export async function reconcile(
  db: Executor,
  input: ReconcileInput,
): Promise<ReconciliationRun> {
  const limit = input.limit ?? 1000;
  const booked: Booked[] = [];
  const failures: BookingFailure[] = [];

  // ── Stage two ─────────────────────────────────────────────────────────────
  //
  // Every loader below is bounded, and every one of them is held rather than inlined,
  // because what the run *saw* is as much a part of its output as what it concluded. The
  // queue's auto-clearing depends on the difference between "no longer a problem" and
  // "beyond the thousandth row", and that difference is only knowable here.
  const allocated = await allocatedByTransaction(db);
  const loaded = await loadCandidates(db, limit);
  const transactions = loaded.transactions;
  const payouts = await unallocatedPayouts(db, limit);
  const lines = await unallocatedSettlementLines(db, limit);

  const allocation = allocate({
    transactions,
    allocated,
    payouts,
    lines,
    policyFor: input.policyFor,
    asOf: input.asOf,
    ...(input.limits ? { limits: input.limits } : {}),
  });

  const receivables = new Map<TransactionId, Money>(
    transactions.map((transaction) => [transaction.transactionId, receivableOf(transaction)]),
  );

  for (const prepared of allocation.prepared) {
    // A reversal or a clawback is not an expected inflow: no money is coming, so there is
    // nothing for a bank statement to confirm and nothing to gain by waiting. Partial ones
    // included — a ₦3,000 refund against a ₦10,000 charge books ₦3,000 back and leaves the
    // rest waiting for its payout (ADR-0069).
    if (BOOKS_IMMEDIATELY.has(prepared.result.reason)) {
      await bookImmediately(db, prepared, receivables, input.asOf, booked, failures);
      continue;
    }

    await saveInflow(db, prepared.inflow, prepared.allocations, input.asOf);
    await recordMatch(db, `allocate:${prepared.inflow.key}`, prepared.result, null, input.asOf);
  }

  // ── Stage three ───────────────────────────────────────────────────────────
  const open = await openInflows(db, limit);
  // Already banked. Not candidates — the evidence that lets a second credit for the same
  // payout, and a debit taking one back, be recognised as what they are.
  const banked = await confirmedInflows(db, limit);
  const bankLines = await unmatchedBankLines(db, limit);

  const confirmation = confirm({
    inflows: open,
    confirmedInflows: banked,
    bankLines,
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
        const confirmation = {
          creditKey: settled.credit.idempotencyKey,
          source: settled.inflow.source,
          reference: settled.inflow.key,
          valueDate: settled.credit.valueDate,
          recordedAt: input.asOf,
          credited: settled.credit.amount,
        };

        // A movement discharging no receivable is a reserve coming back, not a settlement,
        // and it books differently: an asset we already held changes which account it sits
        // in. `bookBankConfirmedSettlement` refuses an empty discharge list — correctly,
        // because money with nothing to discharge is otherwise a phantom credit (ADR-0071).
        const posted =
          discharged.length === 0
            ? await bookReserveRelease(client, confirmation, settled.deductions)
            : await bookBankConfirmedSettlement(
                client,
                confirmation,
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

          // The reserve position, in the same transaction as the booking that moved it.
          // Separately would allow a `psp_reserve` entry with no hold behind it — a balance
          // that grows with nothing recording when any of it is due back, which is the exact
          // state this tracking exists to make impossible (ADR-0071).
          //
          // The clock starts at the credit's value date, not the run's `asOf`: a reserve's
          // ninety days run from when the money was actually held back, and dating it to the
          // run would restart every reserve's clock whenever somebody re-imported a file.
          const reserve = settled.deductions
            .filter((deduction) => deduction.accountId === 'psp_reserve')
            .reduce<Money>((total, deduction) => sum([total, deduction.amount]), ZERO);

          await recordReserveMovement(client, {
            inflowKey: settled.inflow.key,
            source: settled.inflow.source,
            net: reserve,
            at: settled.credit.valueDate,
            confirmedBy: settled.credit.idempotencyKey,
            evidenceId: settled.inflow.evidenceId,
            policyFor: input.policyFor,
          });
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

  // Reserves past the date the source undertook to return them.
  //
  // The only finding in a run that comes from the *books* rather than from comparing two
  // records — because that is what it is about: money nobody disputes we are owed, that
  // nobody has sent back, and that no third record will ever mention. It joins the matcher's
  // drafts here so it raises, deduplicates and clears through exactly the same machinery,
  // including clearing itself the moment a `reserve_release` finally arrives (ADR-0071).
  const overdueReserves = await unreleasedReserves(db, input.asOf, limit);
  drafts.push(...overdueReserves);

  const raised = await raiseExceptions(db, drafts, input.asOf);
  const cleared = await clearVanished(
    db,
    drafts,
    scopeOf(loaded, payouts, lines, open, banked, bankLines, overdueReserves, limit),
    input.asOf,
  );

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
    queue: { ...raised, ...cleared },
    window: {
      transactions: { loaded: transactions.length, truncated: loaded.truncated },
      payouts: { loaded: payouts.length, truncated: payouts.length >= limit },
      settlementLines: { loaded: lines.length, truncated: lines.length >= limit },
      bankLines: { loaded: bankLines.length, truncated: bankLines.length >= limit },
    },
  };
}

/**
 * What this run was in a position to judge, per subject kind.
 *
 * Every run reads all three records, so every run can speak to all four subjects — but
 * *speaking to a subject kind* and *having seen a particular subject* are different claims,
 * and the queue's auto-clearing needs the second one. So each kind carries the ids the run
 * actually loaded, and whether the loaders reached the end.
 *
 * Note where the ids for `payout` come from: three loaders, not one. A payout-subject
 * exception can be about a payout waiting to be allocated, an inflow waiting on the bank,
 * or one already banked and since returned — and an exception whose subject was only ever
 * visible through the loader we forgot would never clear itself.
 *
 * A future partial run — one source only, say, or bank statements alone — narrows this by
 * omitting the kinds it did not read. Treating its silence as "resolved" would close
 * problems that are still entirely real.
 */
function scopeOf(
  loaded: LoadedCandidates,
  payouts: readonly { payoutReference: string }[],
  lines: readonly { idempotencyKey: string }[],
  open: readonly { key: string }[],
  banked: readonly { key: string }[],
  bankLines: readonly { idempotencyKey: string }[],
  reserves: readonly ExceptionDraft[],
  limit: number,
): ClearScope {
  return {
    transaction: {
      witnessed: new Set(loaded.transactions.map((t) => t.transactionId)),
      truncated: loaded.truncated,
    },
    payout: {
      witnessed: new Set([
        ...payouts.map((p) => p.payoutReference),
        ...open.map((i) => i.key),
        ...banked.map((i) => i.key),
        // Reserve findings are keyed by the inflow they were withheld from, and that inflow
        // is long since confirmed — so without this a `RESERVE_UNRELEASED` could be raised
        // and then never cleared when the release finally arrived.
        ...reserves.map((draft) => draft.subjectId),
      ]),
      truncated:
        payouts.length >= limit ||
        open.length >= limit ||
        banked.length >= limit ||
        reserves.length >= limit,
    },
    settlement_line: {
      witnessed: new Set(lines.map((l) => l.idempotencyKey)),
      truncated: lines.length >= limit,
    },
    bank_credit: {
      witnessed: new Set(bankLines.map((l) => l.idempotencyKey)),
      truncated: bankLines.length >= limit,
    },
  };
}

/**
 * The conclusions that book on the spot rather than waiting for a bank credit.
 *
 * Refunds and clawbacks, whole and partial. A partial refund left out of this set would be
 * recorded as an expected inflow and would wait forever for a credit that is never coming,
 * then escalate as a `MISSING_SETTLEMENT` for money nobody is sending.
 */
const BOOKS_IMMEDIATELY: ReadonlySet<MatchResult['reason']> = new Set([
  'REVERSAL',
  'PARTIAL_REVERSAL',
  'CHARGEBACK',
  'PARTIAL_CHARGEBACK',
]);

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
 * event rather than by unwinding the original (append-only). Every account it touched moves back,
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
      const refund =
        prepared.result.reason === 'REVERSAL' || prepared.result.reason === 'PARTIAL_REVERSAL';

      const posted = refund
        ? await bookReversal(client, event, {
            transactionId: allocation.transactionId,
            // The receivable the promise opened at, not the amount coming back. The two
            // differ for a partial refund, and the booking uses the difference to decide
            // whether the promise's story has ended.
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
 * a late settlement file can still answer, which is why it is not a terminal state (ADR-0016).
 * `settled` transactions come too, because a chargeback can only apply to money that
 * already landed, and it needs to find the payment it is clawing back.
 */
interface LoadedCandidates {
  readonly transactions: LedgerTransaction[];
  /**
   * Whether any of the three state queries came back full.
   *
   * Reported rather than inferred from the total, because the filtering below drops
   * non-promises: a run can hold four hundred promises out of a thousand rows read and
   * still have seen only the first thousand transactions in that state.
   */
  readonly truncated: boolean;
}

async function loadCandidates(db: Executor, limit: number): Promise<LoadedCandidates> {
  const byId = new Map<string, LedgerTransaction>();
  let truncated = false;

  for (const state of ['authorized', 'exception', 'settled'] as const) {
    const batch = await listByState(db, state, limit);
    if (batch.length >= limit) truncated = true;
    for (const transaction of batch) {
      // Only promises: settlement bookings and reversals credit the receivable rather than
      // debiting it, so `receivableOf` excludes them without anybody having to remember.
      if (receivableOf(transaction).kobo <= 0n) continue;
      byId.set(transaction.transactionId, transaction);
    }
  }

  return { transactions: [...byId.values()], truncated };
}

