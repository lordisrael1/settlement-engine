import type { TransactionId } from '@recon/canon';
import { negate } from '@recon/canon';

import { UnknownTransactionError } from './errors.js';
import { inTransaction, type Executor } from './pool.js';
import { postTransaction, type PostTransactionResult } from './post.js';
import { getTransaction } from './read.js';
import { transition } from './state.js';

/**
 * Undo a transaction by writing its mirror image — never by touching it.
 *
 * This is Law 2 made operational. The original entries stay exactly as they were
 * written, and a second transaction with every amount negated cancels their effect on
 * every balance. An auditor replaying the history sees both the mistake and the
 * correction, which is the only honest account of what happened.
 *
 * The reversal's id is derived from the original's, so reversing twice collides on the
 * primary key and the second attempt is a no-op (Law 4) rather than a second refund.
 *
 * This is the *mechanical* primitive: an exact negation. Booking a refund as
 * contra-income against the `reversals` account is a different, domain-level decision
 * that belongs to the reconciler, which composes it from `postTransaction` directly.
 */
export async function reverse(
  db: Executor,
  transactionId: TransactionId,
  at: Date,
): Promise<PostTransactionResult> {
  return inTransaction(db, async (client) => {
    const original = await getTransaction(client, transactionId);
    if (!original) throw new UnknownTransactionError(transactionId);

    const reversalId = reversalTransactionId(transactionId);

    const result = await postTransaction(client, {
      transactionId: reversalId,
      source: original.source,
      reference: original.reference,
      occurredAt: at,
      recordedAt: at,
      // A compensating transaction has no promise-to-money gap of its own — there is no
      // later settlement to wait for — so it is born in a terminal state.
      initialState: 'settled',
      // The primitive, not the domain event: this says a transaction was cancelled, and
      // says nothing about why. `bookReversal` is the one that means "a payment was
      // refunded", and the log keeps them apart.
      event: { type: 'TransactionReversed', causedBy: transactionId },
      entries: original.entries.map((entry) => ({
        accountId: entry.accountId,
        amount: negate(entry.amount),
      })),
    });

    if (result.outcome === 'posted') {
      await transition(client, {
        transactionId,
        to: 'reversed',
        at,
        causedBy: reversalId,
      });
    }

    return result;
  });
}

export function reversalTransactionId(transactionId: TransactionId): TransactionId {
  return `${transactionId}#reversal`;
}
