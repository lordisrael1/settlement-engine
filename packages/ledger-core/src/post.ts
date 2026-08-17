import type {
  AccountId,
  DomainEventType,
  Money,
  PaymentChannel,
  Reference,
  SourceId,
  TransactionId,
  TransactionState,
} from '@recon/canon';
import { sum, sumsToZero } from '@recon/canon';

import { UnbalancedTransactionError } from './errors.js';
import { appendEvent } from './events.js';
import { inTransaction, type Executor } from './pool.js';

export interface EntryInput {
  readonly accountId: AccountId;
  /** Signed: positive debits the account, negative credits it. */
  readonly amount: Money;
}

export interface PostTransactionInput {
  /** The causing event's idempotency key. Posting it twice is a no-op (Law 4). */
  readonly transactionId: TransactionId;
  readonly source: SourceId;
  readonly reference: Reference;
  readonly occurredAt: Date;
  readonly recordedAt: Date;
  readonly initialState: TransactionState;
  readonly entries: readonly EntryInput[];
  /**
   * The rail the causing payment arrived on, where the transaction is about one payment.
   *
   * Optional because most transactions are not: a settlement booking covers a batch and an
   * adjustment covers nothing. Recorded rather than derived, because the fee a promise is
   * expected to attract is priced per channel.
   */
  readonly channel?: PaymentChannel | null;
  /**
   * What kind of happening this transaction records, for the event log.
   *
   * Named by the caller because only the caller knows: the entries for an authorized
   * payment and a reversal are both "two rows against `psp_receivable`", and which one it
   * *is* is domain knowledge that lives in `bookings.ts`, not here.
   *
   * Optional so that a test or a migration can post without narrating. A transaction with
   * no event is invisible to `replay`, which is why every real booking supplies one and the
   * replay's entry-level check catches any that stops doing so.
   */
  readonly event?: { readonly type: DomainEventType; readonly causedBy?: string | null };
}

export interface PostTransactionResult {
  readonly outcome: 'posted' | 'duplicate';
  readonly transactionId: TransactionId;
}

/**
 * Record one economic event.
 *
 * The write is atomic in the strong sense: the transaction row, its entries, its initial
 * lifecycle state and the balance-cache updates either all land or none do, and Law 1's
 * deferred trigger gets the final say at COMMIT. There is no interleaving in which a
 * reader can observe half an event or an unbalanced one.
 *
 * Redelivery is not an error. A second post of the same event returns
 * `{ outcome: 'duplicate' }` having changed nothing, because the primary key is the
 * event's idempotency key and `ON CONFLICT DO NOTHING` resolves the race in the database
 * rather than in a check-then-insert window.
 */
export async function postTransaction(
  db: Executor,
  input: PostTransactionInput,
): Promise<PostTransactionResult> {
  if (input.entries.length === 0) {
    throw new UnbalancedTransactionError(input.transactionId, sum([]));
  }

  // Fail fast with a message that names the missing money. The database enforces the
  // same rule independently at COMMIT; this check exists so humans get a good error.
  const amounts = input.entries.map((entry) => entry.amount);
  if (!sumsToZero(amounts)) {
    throw new UnbalancedTransactionError(input.transactionId, sum(amounts));
  }

  return inTransaction(db, async (client) => {
    const inserted = await client.query<{ transaction_id: string }>(
      `INSERT INTO ledger_transactions
              (transaction_id, source, reference, occurred_at, recorded_at, channel)
            VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (transaction_id) DO NOTHING
         RETURNING transaction_id`,
      [
        input.transactionId,
        input.source,
        input.reference,
        input.occurredAt,
        input.recordedAt,
        input.channel ?? null,
      ],
    );

    if (inserted.rowCount === 0) {
      return { outcome: 'duplicate', transactionId: input.transactionId };
    }

    for (const [ordinal, entry] of input.entries.entries()) {
      await client.query(
        `INSERT INTO entries (entry_id, transaction_id, ordinal, account_id, amount_kobo, currency)
              VALUES ($1, $2, $3, $4, $5::bigint, $6)`,
        [
          entryId(input.transactionId, ordinal),
          input.transactionId,
          ordinal,
          entry.accountId,
          // Passed as text and cast: BIGINT must never round-trip through a JS number.
          entry.amount.kobo.toString(),
          entry.amount.currency,
        ],
      );
    }

    await client.query(
      `INSERT INTO transaction_state_changes (transaction_id, from_state, to_state, at, caused_by)
            VALUES ($1, NULL, $2, $3, NULL)`,
      [input.transactionId, input.initialState, input.recordedAt],
    );

    // One row per account: a transaction may touch the same account twice, and two
    // conflicting upserts of the same key in one statement is an error in Postgres.
    for (const [accountId, amount] of totalPerAccount(input.entries)) {
      await client.query(
        `INSERT INTO account_balances (account_id, balance_kobo, currency)
              VALUES ($1, $2::bigint, $3)
         ON CONFLICT (account_id) DO UPDATE
                SET balance_kobo = account_balances.balance_kobo + EXCLUDED.balance_kobo`,
        [accountId, amount.kobo.toString(), amount.currency],
      );
    }

    // The narrative and the entries, in one transaction. Not after, not by a listener: an
    // event log written asynchronously is a log that is usually right, and "usually right"
    // is not a property an audit can rest on.
    if (input.event) {
      await appendEvent(client, {
        type: input.event.type,
        subject: input.transactionId,
        source: input.source,
        occurredAt: input.occurredAt,
        recordedAt: input.recordedAt,
        entries: input.entries,
        detail: { reference: input.reference, state: input.initialState },
        causedBy: input.event.causedBy ?? null,
      });
    }

    return { outcome: 'posted', transactionId: input.transactionId };
  });
}

/**
 * Entry ids are derived, not generated. A random id would make the same event replay to a
 * different database, which is the opposite of what Law 5 asks for.
 */
export function entryId(transactionId: TransactionId, ordinal: number): string {
  return `${transactionId}#${ordinal}`;
}

function totalPerAccount(entries: readonly EntryInput[]): Map<AccountId, Money> {
  const totals = new Map<AccountId, Money>();
  for (const entry of entries) {
    const running = totals.get(entry.accountId);
    totals.set(entry.accountId, running ? sum([running, entry.amount]) : entry.amount);
  }
  return totals;
}
