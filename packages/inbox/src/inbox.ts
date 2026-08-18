import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import type { Pool } from 'pg';

import type { SourceId, TransactionId } from '@recon/canon';
import type { Executor } from '@recon/ledger-core';
import { inTransaction } from '@recon/ledger-core';

/** This package's migrations. Passed to `runMigrations` alongside the others. */
export const INBOX_MIGRATIONS_DIR = fileURLToPath(new URL('../migrations/', import.meta.url));

/**
 * A delivery as it arrived: a source, some headers, and bytes nobody has interpreted.
 *
 * Note what is absent — an amount, a reference, a status. At the moment of acceptance we
 * know the signature verified and nothing else, deliberately: parsing before answering
 * would make the promise we give the provider depend on a parser succeeding, and the
 * promise is only ever "we safely received this event".
 */
export interface InboundDelivery {
  readonly source: SourceId;
  readonly headers: Record<string, string | string[] | undefined>;
  /**
   * The **raw bytes**, before any JSON middleware touched them. Signatures are computed
   * over bytes, and a parse-then-reserialise produces different ones.
   */
  readonly rawBody: Buffer;
  readonly receivedAt: Date;
}

export interface Accepted {
  readonly deliveryId: string;
  /** These exact bytes from this source have been accepted before. Nothing was written. */
  readonly duplicate: boolean;
}

/**
 * The identity of a delivery: SHA-256 over the source and the bytes.
 *
 * Derived, never generated (D-014). Two consequences, both load-bearing. A provider
 * redelivering — which every provider does, and does on a timer — collides on the primary
 * key instead of on somebody remembering to check. And the id is computable by anyone
 * holding the same bytes, so "is this the delivery you got?" is answerable without us,
 * exactly as an evidence id is (D-033).
 *
 * The source is in the digest because two providers can legitimately send byte-identical
 * bodies, and they are not the same event.
 */
export function deliveryId(source: SourceId, rawBody: Buffer): string {
  return createHash('sha256')
    .update(source)
    .update(String.fromCharCode(31))
    .update(rawBody)
    .digest('hex');
}

/**
 * Write the delivery down, and nothing else.
 *
 * This is the whole of the T+0 hot path after signature verification: one insert, then
 * answer. It does not normalise, does not book, does not reconcile, and must never learn
 * to — every one of those is work whose failure would turn a delivery we are holding into
 * a delivery the provider thinks it still has to send.
 */
export async function accept(db: Executor, delivery: InboundDelivery): Promise<Accepted> {
  const id = deliveryId(delivery.source, delivery.rawBody);

  const result = await db.query(
    `INSERT INTO webhook_inbox (delivery_id, source, headers, raw, received_at)
          VALUES ($1, $2, $3::jsonb, $4, $5)
     ON CONFLICT (delivery_id) DO NOTHING`,
    [id, delivery.source, JSON.stringify(delivery.headers), delivery.rawBody, delivery.receivedAt],
  );

  return { deliveryId: id, duplicate: (result.rowCount ?? 0) === 0 };
}

/** A delivery handed to a worker, with what earlier attempts already cost. */
export interface ClaimedDelivery extends InboundDelivery {
  readonly deliveryId: string;
  /** How many times this has been tried and thrown. Zero on the first attempt. */
  readonly attempts: number;
}

/**
 * What the delivery turned out to mean.
 *
 * The three terminal answers are deliberately distinct. `processed` is a delivery that
 * became a ledger transaction. `ignored` is one that was authentic, well-formed, and not
 * about money we keep books for — a provider event type we have no use for, a debit, a
 * currency we do not hold. `rejected` is one that was authentic and unusable, which is a
 * bug somewhere and must never be retried, because retrying a payload our parser cannot
 * read produces the same failure every hour for three days.
 *
 * A handler that *throws* is saying something different again: not "this delivery is
 * wrong" but "I could not do my job just now". That is the retryable case, and the only
 * one, which is why it is signalled by an exception rather than by a fourth variant.
 */
export type DeliveryOutcome =
  | { readonly state: 'processed'; readonly transactionId: TransactionId; readonly detail: string }
  | { readonly state: 'ignored'; readonly detail: string }
  | { readonly state: 'rejected'; readonly detail: string };

/**
 * Turn one delivery into whatever it means.
 *
 * The executor handed in is the *same transaction* the delivery's state change is written
 * in, so a booking and the record that it was booked either both land or neither does. A
 * handler that opened its own connection would create the one state this design exists to
 * prevent: a ledger transaction posted from a delivery still marked pending, which the next
 * drain would post again.
 */
export type DeliveryHandler = (
  delivery: ClaimedDelivery,
  db: Executor,
) => Promise<DeliveryOutcome>;

export interface DrainOptions {
  /** How many deliveries to work in this pass. The queue is drained by repeated passes. */
  readonly limit?: number;
  /**
   * How many failed attempts before a delivery stops being retried and becomes a human's
   * problem. A poison payload retried forever is an infinite loop with a log file.
   */
  readonly maxAttempts?: number;
  /** The clock, as an argument (Law 5). */
  readonly at: Date;
}

export interface DrainReport {
  readonly claimed: number;
  readonly processed: number;
  readonly ignored: number;
  readonly rejected: number;
  /** Threw, and will be tried again. */
  readonly retrying: number;
  /** Threw once too often. Nobody will try again without a person. */
  readonly failed: number;
}

const DEFAULTS = { limit: 100, maxAttempts: 8 };

/**
 * Work the inbox: claim a delivery, give it meaning, record what it meant.
 *
 * One database transaction **per delivery**, not per batch. A batch-wide transaction would
 * mean the ninth delivery's failure rolling back the eight bookings before it, which is a
 * design where a single malformed payload can stop the queue.
 *
 * Claiming is `FOR UPDATE SKIP LOCKED`, so scaling the workers is starting more of them.
 * Two workers never fight over a row and never wait on each other; a worker that dies
 * mid-delivery releases its lock on disconnect and the delivery is simply claimed again.
 * Nothing is lost, and nothing is double-booked either — the ledger transaction id is the
 * payment's idempotency key, so the second attempt collides on the primary key (D-014).
 */
export async function drain(
  db: Pool,
  handle: DeliveryHandler,
  options: DrainOptions,
): Promise<DrainReport> {
  const limit = options.limit ?? DEFAULTS.limit;
  const maxAttempts = options.maxAttempts ?? DEFAULTS.maxAttempts;

  let claimed = 0;
  let processed = 0;
  let ignored = 0;
  let rejected = 0;
  let retrying = 0;
  let failed = 0;

  for (let worked = 0; worked < limit; worked += 1) {
    let attempted: ClaimedDelivery | null = null;

    try {
      const outcome = await inTransaction(db, async (client) => {
        const delivery = await claim(client, maxAttempts);
        if (!delivery) return null;
        attempted = delivery;

        const result = await handle(delivery, client);
        await client.query(
          `UPDATE webhook_inbox
              SET state = $2, detail = $3, transaction_id = $4, processed_at = $5,
                  attempts = attempts + 1, last_error = NULL
            WHERE delivery_id = $1`,
          [
            delivery.deliveryId,
            result.state,
            result.detail,
            result.state === 'processed' ? result.transactionId : null,
            options.at,
          ],
        );
        return result;
      });

      if (!outcome) break;
      claimed += 1;
      if (outcome.state === 'processed') processed += 1;
      else if (outcome.state === 'ignored') ignored += 1;
      else rejected += 1;
    } catch (error) {
      // The transaction above is gone, and with it the attempt counter it would have
      // incremented — so the failure is recorded on its own, afterwards. Without this a
      // delivery that always throws would be claimed forever with `attempts` stuck at zero,
      // and the cap that makes it somebody's problem would never be reached.
      if (!attempted) throw error;
      claimed += 1;
      const gaveUp = await recordFailure(db, attempted, error, maxAttempts);
      if (gaveUp) failed += 1;
      else retrying += 1;
    }
  }

  return { claimed, processed, ignored, rejected, retrying, failed };
}

async function claim(db: Executor, maxAttempts: number): Promise<ClaimedDelivery | null> {
  const result = await db.query<{
    delivery_id: string;
    source: string;
    headers: Record<string, string | string[] | undefined>;
    raw: Buffer;
    received_at: Date;
    attempts: number;
  }>(
    `SELECT delivery_id, source, headers, raw, received_at, attempts
       FROM webhook_inbox
      WHERE state = 'pending' AND attempts < $1
      ORDER BY received_at, delivery_id
      LIMIT 1
        FOR UPDATE SKIP LOCKED`,
    [maxAttempts],
  );

  const row = result.rows[0];
  return row
    ? {
        deliveryId: row.delivery_id,
        source: row.source,
        headers: row.headers,
        rawBody: row.raw,
        receivedAt: row.received_at,
        attempts: row.attempts,
      }
    : null;
}

/** Returns `true` when this was the attempt that used the last one. */
async function recordFailure(
  db: Executor,
  delivery: ClaimedDelivery,
  error: unknown,
  maxAttempts: number,
): Promise<boolean> {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);

  const result = await db.query<{ state: string }>(
    `UPDATE webhook_inbox
        SET attempts = attempts + 1,
            last_error = $2,
            state = CASE WHEN attempts + 1 >= $3 THEN 'failed' ELSE 'pending' END
      WHERE delivery_id = $1
        RETURNING state`,
    [delivery.deliveryId, message.slice(0, 2000), maxAttempts],
  );

  return result.rows[0]?.state === 'failed';
}

/** One delivery's fate, for the operator asking "what happened to the webhook I sent?". */
export interface DeliveryRecord {
  readonly deliveryId: string;
  readonly source: SourceId;
  readonly state: 'pending' | 'processed' | 'ignored' | 'rejected' | 'failed';
  readonly attempts: number;
  readonly detail: string | null;
  readonly lastError: string | null;
  readonly transactionId: TransactionId | null;
  readonly receivedAt: Date;
  readonly processedAt: Date | null;
}

export async function deliveryAt(db: Executor, id: string): Promise<DeliveryRecord | null> {
  const result = await db.query<{
    delivery_id: string;
    source: string;
    state: DeliveryRecord['state'];
    attempts: number;
    detail: string | null;
    last_error: string | null;
    transaction_id: string | null;
    received_at: Date;
    processed_at: Date | null;
  }>(
    `SELECT delivery_id, source, state, attempts, detail, last_error, transaction_id,
            received_at, processed_at
       FROM webhook_inbox WHERE delivery_id = $1`,
    [id],
  );

  const row = result.rows[0];
  return row
    ? {
        deliveryId: row.delivery_id,
        source: row.source,
        state: row.state,
        attempts: row.attempts,
        detail: row.detail,
        lastError: row.last_error,
        transactionId: row.transaction_id,
        receivedAt: row.received_at,
        processedAt: row.processed_at,
      }
    : null;
}

/**
 * How far behind the workers are, and how much has given up.
 *
 * The two numbers a service's health check should carry. A pending count that grows
 * monotonically is the only symptom of a stalled drain that shows up before the provider
 * starts complaining, and `failed` is a count of deliveries nobody will ever look at again
 * unless this reports them.
 */
export async function inboxDepth(db: Executor): Promise<{ pending: number; failed: number }> {
  const result = await db.query<{ state: string; count: string }>(
    `SELECT state, COUNT(*)::text AS count
       FROM webhook_inbox WHERE state IN ('pending', 'failed') GROUP BY state`,
  );

  const depth = { pending: 0, failed: 0 };
  for (const row of result.rows) {
    if (row.state === 'pending') depth.pending = Number(row.count);
    if (row.state === 'failed') depth.failed = Number(row.count);
  }
  return depth;
}
