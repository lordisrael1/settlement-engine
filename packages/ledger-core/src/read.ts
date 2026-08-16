import type {
  AccountId,
  LedgerTransaction,
  PaymentChannel,
  Reference,
  SourceId,
  TransactionId,
  TransactionState,
} from '@recon/canon';
import { money } from '@recon/canon';

import type { Executor } from './pool.js';

interface TransactionRow {
  transaction_id: string;
  source: string;
  reference: string;
  occurred_at: Date;
  recorded_at: Date;
  channel: PaymentChannel | null;
  state: TransactionState;
}

interface EntryRow {
  entry_id: string;
  transaction_id: string;
  account_id: AccountId;
  amount_kobo: string;
  currency: 'NGN';
  ordinal: number;
}

export async function getTransaction(
  db: Executor,
  transactionId: TransactionId,
): Promise<LedgerTransaction | null> {
  const header = await db.query<TransactionRow>(
    `SELECT t.transaction_id, t.source, t.reference, t.occurred_at, t.recorded_at,
            t.channel, s.state
       FROM ledger_transactions t
       JOIN transaction_states s ON s.transaction_id = t.transaction_id
      WHERE t.transaction_id = $1`,
    [transactionId],
  );
  const row = header.rows[0];
  if (!row) return null;

  const entries = await db.query<EntryRow>(
    `SELECT entry_id, transaction_id, account_id, amount_kobo::text, currency, ordinal
       FROM entries WHERE transaction_id = $1 ORDER BY ordinal`,
    [transactionId],
  );

  return toTransaction(row, entries.rows);
}

/**
 * Transactions currently in a given lifecycle state, oldest first.
 *
 * This is the query the reconciler will live on: "which promises are still waiting for
 * their money?" is `listByState(db, 'authorized')`.
 */
export async function listByState(
  db: Executor,
  state: TransactionState,
  limit = 1000,
): Promise<LedgerTransaction[]> {
  const headers = await db.query<TransactionRow>(
    `SELECT t.transaction_id, t.source, t.reference, t.occurred_at, t.recorded_at,
            t.channel, s.state
       FROM ledger_transactions t
       JOIN transaction_states s ON s.transaction_id = t.transaction_id
      WHERE s.state = $1
      ORDER BY t.occurred_at, t.transaction_id
      LIMIT $2`,
    [state, limit],
  );
  if (headers.rows.length === 0) return [];

  const ids = headers.rows.map((row) => row.transaction_id);
  const entries = await db.query<EntryRow>(
    `SELECT entry_id, transaction_id, account_id, amount_kobo::text, currency, ordinal
       FROM entries WHERE transaction_id = ANY($1) ORDER BY transaction_id, ordinal`,
    [ids],
  );

  const byTransaction = new Map<string, EntryRow[]>();
  for (const entry of entries.rows) {
    const bucket = byTransaction.get(entry.transaction_id);
    if (bucket) bucket.push(entry);
    else byTransaction.set(entry.transaction_id, [entry]);
  }

  return headers.rows.map((row) =>
    toTransaction(row, byTransaction.get(row.transaction_id) ?? []),
  );
}

/**
 * Transactions carrying a given source reference, in any state.
 *
 * More than one is normal and not an error: a promise, the settlement that discharged it
 * and a later clawback all describe the same reference. Deciding which of them a new
 * record belongs to is the reconciler's job, so this returns them all rather than guessing.
 */
export async function listByReference(
  db: Executor,
  source: SourceId,
  reference: Reference,
): Promise<LedgerTransaction[]> {
  const headers = await db.query<TransactionRow>(
    `SELECT t.transaction_id, t.source, t.reference, t.occurred_at, t.recorded_at,
            t.channel, s.state
       FROM ledger_transactions t
       JOIN transaction_states s ON s.transaction_id = t.transaction_id
      WHERE t.source = $1 AND t.reference = $2
      ORDER BY t.occurred_at, t.transaction_id`,
    [source, reference],
  );
  if (headers.rows.length === 0) return [];

  const entries = await db.query<EntryRow>(
    `SELECT entry_id, transaction_id, account_id, amount_kobo::text, currency, ordinal
       FROM entries WHERE transaction_id = ANY($1) ORDER BY transaction_id, ordinal`,
    [headers.rows.map((row) => row.transaction_id)],
  );

  return headers.rows.map((row) =>
    toTransaction(
      row,
      entries.rows.filter((entry) => entry.transaction_id === row.transaction_id),
    ),
  );
}

function toTransaction(row: TransactionRow, entries: readonly EntryRow[]): LedgerTransaction {
  return {
    transactionId: row.transaction_id,
    state: row.state,
    source: row.source,
    reference: row.reference,
    channel: row.channel,
    occurredAt: row.occurred_at,
    recordedAt: row.recorded_at,
    entries: entries.map((entry) => ({
      entryId: entry.entry_id,
      transactionId: entry.transaction_id,
      accountId: entry.account_id,
      amount: money(BigInt(entry.amount_kobo), entry.currency),
    })),
  };
}
