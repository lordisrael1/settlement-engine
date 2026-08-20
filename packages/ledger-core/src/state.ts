import type { TransactionId, TransactionState } from '@recon/canon';

import { InvalidStateTransitionError, UnknownTransactionError } from './errors.js';
import { inTransaction, type Executor } from './pool.js';

/**
 * The lifecycle, as a closed graph.
 *
 * `settled` and `reversed` are terminal: once the money has landed or the promise has
 * been undone, the story of that transaction is over. Anything further is a *new*
 * economic event with its own transaction — a chargeback is not "un-settling", it is a
 * later clawback.
 *
 * `exception` is not terminal, because an exception is a question, and questions get
 * answered: a late settlement file can still clear an item that had been escalated.
 */
const ALLOWED_TRANSITIONS: Readonly<Record<TransactionState, readonly TransactionState[]>> = {
  authorized: ['settled', 'reversed', 'exception'],
  exception: ['settled', 'reversed'],
  settled: [],
  reversed: [],
};

export interface TransitionInput {
  readonly transactionId: TransactionId;
  readonly to: TransactionState;
  readonly at: Date;
  /** The transaction that caused this — a settlement booking, a reversal. */
  readonly causedBy: TransactionId | null;
}

export interface TransitionResult {
  readonly outcome: 'transitioned' | 'unchanged';
  readonly from: TransactionState;
  readonly to: TransactionState;
}

export async function currentState(
  db: Executor,
  transactionId: TransactionId,
): Promise<TransactionState | null> {
  const result = await db.query<{ state: TransactionState }>(
    'SELECT state FROM transaction_states WHERE transaction_id = $1',
    [transactionId],
  );
  return result.rows[0]?.state ?? null;
}

/**
 * Move a transaction to a new lifecycle state by *appending* the change.
 *
 * The row is locked for the duration, because two workers reacting to the same settlement
 * file would otherwise both read `authorized` and both append a transition — recording
 * one event twice. Re-applying a transition that already happened is a no-op rather than
 * an error, so a retried reconciliation run is safe (idempotency).
 */
export async function transition(
  db: Executor,
  input: TransitionInput,
): Promise<TransitionResult> {
  return inTransaction(db, async (client) => {
    const locked = await client.query(
      'SELECT transaction_id FROM ledger_transactions WHERE transaction_id = $1 FOR UPDATE',
      [input.transactionId],
    );
    if (locked.rowCount === 0) throw new UnknownTransactionError(input.transactionId);

    const from = await currentState(client, input.transactionId);
    if (from === null) throw new UnknownTransactionError(input.transactionId);

    if (from === input.to) {
      return { outcome: 'unchanged', from, to: input.to };
    }
    if (!ALLOWED_TRANSITIONS[from].includes(input.to)) {
      throw new InvalidStateTransitionError(input.transactionId, from, input.to);
    }

    await client.query(
      `INSERT INTO transaction_state_changes (transaction_id, from_state, to_state, at, caused_by)
            VALUES ($1, $2, $3, $4, $5)`,
      [input.transactionId, from, input.to, input.at, input.causedBy],
    );

    return { outcome: 'transitioned', from, to: input.to };
  });
}
