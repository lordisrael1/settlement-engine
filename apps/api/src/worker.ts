import type { Pool } from 'pg';

import { drain, type DeliveryHandler, type DrainReport, type Redactor } from '@recon/inbox';
import { ingestWebhook } from '@recon/ingest';
import { bookAuthorizedPayment, UnbookablePaymentError } from '@recon/ledger-core';
import { redact } from '@recon/protect';

import type { Config } from './config.js';

/**
 * What a stored delivery turns out to mean, and what the books do about it.
 *
 * This is the join the whole library/deployable split exists to allow: `@recon/inbox` knows
 * deliveries and nothing about payments; `@recon/ingest` knows how to read a provider's
 * bytes and nothing about ledgers; `@recon/ledger-core` knows what a promise does to the
 * books and nothing about where it came from. Fifteen lines of conductor join them, and not
 * one decision is made here — every branch below is a package's answer being routed, not
 * this layer's judgement.
 *
 * The executor is the inbox's own transaction, so the ledger write and the record that the
 * delivery was worked commit together. That equality is what makes the drain safe to
 * interrupt: a delivery is never both booked and pending.
 */
export function interpretDelivery(config: Config, now: () => Date): DeliveryHandler {
  return async (delivery, db) => {
    const secret = config.webhookSecrets(delivery.source);
    if (secret.length === 0) {
      // Thrown, not rejected: this delivery is fine and our configuration is not. A
      // rejection would discard a real payment because somebody forgot an environment
      // variable, whereas a throw retries and eventually surfaces as a failed delivery
      // with the reason attached.
      throw new Error(
        `No webhook secret configured for "${delivery.source}". The delivery is authentic ` +
          `and unread; set RECON_WEBHOOK_SECRET_${delivery.source.toUpperCase()} and it will ` +
          `be worked on the next pass.`,
      );
    }

    const result = ingestWebhook({
      source: delivery.source,
      headers: delivery.headers,
      rawBody: delivery.rawBody,
      secret,
    });

    switch (result.kind) {
      case 'unverified':
        // It verified at the door and does not verify against *any* secret we now hold, so
        // the secret was rotated and the previous one was not kept. Retrying cannot help —
        // the bytes are fixed and so is the ring — and this is terminal for that reason
        // rather than as a policy: a person restores the old secret as
        // RECON_WEBHOOK_SECRET_<SOURCE>_PREVIOUS and re-queues, and the bytes are still here
        // for them either way.
        //
        // The overlap window exists so this branch is unreachable during an ordinary
        // rotation. Reaching it means the old secret was dropped while a backlog existed,
        // and the message says so, because the alternative is an operator concluding that
        // the provider sent a bad payload (ADR-0073).
        return {
          state: 'rejected',
          detail:
            `signature verified at acceptance and verifies against none of the ` +
            `${secret.length} secret(s) now configured for "${delivery.source}". This is an ` +
            `authentic delivery that a rotation stranded: set ` +
            `RECON_WEBHOOK_SECRET_${delivery.source.toUpperCase()}_PREVIOUS to the old secret ` +
            `and re-queue it.`,
        };

      case 'ignored':
        return { state: 'ignored', detail: result.reason };

      case 'rejected':
        return { state: 'rejected', detail: result.reason };

      case 'payment': {
        try {
          const posted = await bookAuthorizedPayment(db, result.payment, now());
          return {
            state: 'processed',
            transactionId: posted.transactionId,
            // 'duplicate' is a redelivery absorbed downstream: the provider sent the same
            // event with different bytes, so the inbox saw two rows and the ledger saw one
            // transaction. Both layers held, and saying which one caught it is worth a word.
            detail: `${result.payment.reference} ${result.payment.status} — ${posted.outcome}`,
          };
        } catch (error) {
          // The ledger refuses to book anything but a SUCCESSFUL payment: a pending or
          // failed notification is news about a payment, not a promise of money (ADR-0021).
          // That rule stays in the ledger — this only records the answer it gave.
          if (error instanceof UnbookablePaymentError) {
            return { state: 'ignored', detail: error.message.split('\n')[0] ?? error.message };
          }
          throw error;
        }
      }
    }
  };
}

/**
 * The delivery's original payload is replaced in the same transaction that records what it
 * meant.
 *
 * A worked delivery has no further use for a customer's name, email and IP address, and the
 * drain's own transaction is the last moment anything needs the original bytes — so it is
 * the first moment they can go, with no window in between (ADR-0064).
 *
 * Exported so the suite drains with exactly what the worker drains with. A test that built
 * its own options would be testing a redaction the service does not perform.
 */
export const REDACT_DELIVERY: Redactor = (delivery) => redact(delivery.rawBody);

export interface InboxWorker {
  /** Stop looking for new deliveries and wait for the pass in flight. */
  readonly stop: () => Promise<void>;
}

/**
 * The other half of the webhook rail: a loop that empties what the endpoint filled.
 *
 * Deliberately a poll rather than an in-process queue or a notification. A poll survives a
 * restart, a missed signal and a second replica with no coordination at all — the inbox
 * *is* the queue, and `FOR UPDATE SKIP LOCKED` is the coordination. An in-memory queue
 * would be faster and would lose deliveries on deploy, which is the one thing this design
 * exists to prevent.
 *
 * It runs beside the HTTP server here because one process is the right size for this
 * system today. Nothing about it assumes that: the drain takes a pool and a handler, so
 * moving the workers to their own deployment is starting the same loop somewhere else.
 */
export function startInboxWorker(
  pool: Pool,
  config: Config,
  now: () => Date,
  report: (report: DrainReport) => void,
  onError: (error: unknown) => void,
): InboxWorker {
  const handle = interpretDelivery(config, now);
  let timer: NodeJS.Timeout | null = null;
  let stopped = false;
  let inFlight: Promise<void> = Promise.resolve();

  const pass = async (): Promise<void> => {
    try {
      const drained = await drain(pool, handle, {
        limit: config.drain.batch,
        maxAttempts: config.drain.maxAttempts,
        at: now(),
        redact: REDACT_DELIVERY,
      });
      if (drained.claimed > 0) report(drained);
    } catch (error) {
      // The database is unreachable, or a claim raced. Neither is a reason to stop
      // draining forever — the deliveries are durable and the next pass finds them.
      onError(error);
    } finally {
      if (!stopped) {
        timer = setTimeout(schedule, config.drain.intervalMs);
        timer.unref();
      }
    }
  };

  const schedule = (): void => {
    inFlight = pass();
  };

  schedule();

  return {
    stop: async () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      await inFlight;
    },
  };
}
