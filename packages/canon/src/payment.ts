/**
 * The promise — the fast information that a payment happened.
 *
 * Produced by the webhook half of the ingest layer (`pay-normalize`) and recorded
 * immediately as an `authorized` ledger transaction. It is not money yet.
 */

import type { IdempotencyKey, Reference, SourceId } from './identifiers.js';
import type { Money } from './money.js';

/**
 * Deliberately identical — same members, same spelling — to
 * `TransactionStatus` in `@pay-normalize/core`, which is the webhook half of our
 * ingest layer. Two vocabularies for one concept is precisely what this package
 * exists to prevent, so we adopt the upstream spelling rather than translate at
 * the boundary and risk the mapping table drifting.
 */
export type PaymentStatus = 'PENDING' | 'FAILED' | 'SUCCESSFUL' | 'REVERSED';

/**
 * Webhooks arrive out of order. A status update only takes effect if it ranks strictly
 * higher than the status already recorded, which makes the outcome independent of
 * delivery order (Law 5). Equal rank is a no-op, so redelivery changes nothing (Law 4).
 *
 * These values mirror `STATUS_RANK` in `@pay-normalize/core`. That library's ordering is
 * the production-tested one and wins any disagreement; this copy exists so the ledger
 * can reason about status without importing a connector.
 *
 * `REVERSED` outranks `SUCCESSFUL` because success → reversal is legitimate forward
 * progress (refunds, chargebacks). `FAILED` → `SUCCESSFUL` is allowed because some
 * providers emit a failure and then succeed on an internal retry under the same
 * reference. `PENDING` can never overwrite anything.
 */
export const STATUS_RANK: Readonly<Record<PaymentStatus, number>> = {
  PENDING: 0,
  FAILED: 1,
  SUCCESSFUL: 2,
  REVERSED: 3,
};

/** True if `incoming` is newer news than `current` and should be applied. */
export function supersedes(incoming: PaymentStatus, current: PaymentStatus): boolean {
  return STATUS_RANK[incoming] > STATUS_RANK[current];
}

export interface CanonicalPayment {
  readonly reference: Reference;
  readonly source: SourceId;
  /** What the customer paid, before any fee. */
  readonly gross: Money;
  readonly status: PaymentStatus;
  /** When the payment happened at the source. Drives the settlement window. */
  readonly occurredAt: Date;
  readonly idempotencyKey: IdempotencyKey;
}
