import type { CanonicalPayment } from '@recon/canon';
import { negate } from '@recon/canon';

import { LedgerError } from './errors.js';
import type { Executor } from './pool.js';
import { postTransaction, type PostTransactionResult } from './post.js';

/**
 * How our books record the events of this business.
 *
 * `postTransaction` is the mechanism — it will faithfully write any balanced set of
 * entries you hand it. This file is the *policy*: which accounts a given economic event
 * touches. Both belong to the ledger, because both are statements about our chart of
 * accounts, and neither has any idea which PSP the event came from.
 *
 * The input is a `CanonicalPayment` — canonical language from `@recon/canon`, not a
 * foreign shape. Law 7 forbids branching on the source, not knowing that payments exist.
 */

export class UnbookablePaymentError extends LedgerError {
  constructor(payment: CanonicalPayment) {
    super(
      `Refusing to book payment "${payment.reference}" with status ${payment.status}. ` +
        `Only a SUCCESSFUL payment is a promise of money; booking anything else would ` +
        `put cash in the books that no one ever agreed to send.`,
    );
  }
}

/**
 * Record the promise: a customer has paid, and the PSP now owes us.
 *
 *   psp_receivable    +gross    (they owe us)
 *   merchant_revenue  −gross    (we earned it)
 *
 * Revenue is booked at **gross** — what the customer actually paid — and no fee is
 * booked at all. This is not an omission. At this moment the fee is genuinely unknown:
 * a rate card can change, a cap can apply, an international surcharge can land. Booking
 * an estimate would put a guess in the books and require a correction later, for
 * something we never had to assert in the first place. The fee is booked when the
 * settlement reveals it, against this same receivable.
 *
 * The consequence is the most useful number in the business: at any instant,
 * `psp_receivable` is exactly the money promised but not yet paid.
 */
export async function bookAuthorizedPayment(
  db: Executor,
  payment: CanonicalPayment,
  recordedAt: Date,
): Promise<PostTransactionResult> {
  if (payment.status !== 'SUCCESSFUL') throw new UnbookablePaymentError(payment);

  return postTransaction(db, {
    transactionId: payment.idempotencyKey,
    source: payment.source,
    reference: payment.reference,
    occurredAt: payment.occurredAt,
    recordedAt,
    initialState: 'authorized',
    entries: [
      { accountId: 'psp_receivable', amount: payment.gross },
      { accountId: 'merchant_revenue', amount: negate(payment.gross) },
    ],
  });
}
