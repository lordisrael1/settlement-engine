import { toRawBody } from '@pay-normalize/core';

import type { CanonicalPayment, SourceId } from '@recon/canon';
import { idempotencyKey } from '@recon/canon';

import { toMoney } from './kobo.js';
import { sourceProfile } from './sources.js';

export interface WebhookIngestInput {
  readonly source: SourceId;
  readonly headers: Record<string, string | string[] | undefined>;
  /**
   * The **raw bytes** of the request, before any JSON middleware touched them.
   * Signatures are computed over bytes, and `JSON.parse` followed by re-serialising
   * produces different bytes — reordered keys, different whitespace, different unicode
   * escaping — which fails verification for entirely valid payloads.
   */
  readonly rawBody: Buffer;
  /** The webhook secret. An argument, never an environment read at this layer. */
  readonly secret: string;
}

export type WebhookIngestResult =
  /** Authentic and meaningful. The caller decides what the ledger does about it. */
  | { readonly kind: 'payment'; readonly payment: CanonicalPayment }
  /** Signature check failed. Respond 401 and process nothing. */
  | { readonly kind: 'unverified' }
  /** Authentic, well-formed, and not a payment we keep books for. Acknowledge it. */
  | { readonly kind: 'ignored'; readonly reason: string }
  /** Authentic but unusable. Acknowledge, park the payload, alert — never retry. */
  | { readonly kind: 'rejected'; readonly reason: string };

/**
 * Turn one inbound webhook delivery into a canonical promise.
 *
 * The order of operations is a security property, not a preference: verify first, parse
 * second. Parsing before verifying means running a parser over bytes that any stranger
 * on the internet can choose.
 *
 * Nothing here decides what the ledger should do. Ingest's job ends at "this is what the
 * event means"; whether that becomes an `authorized` transaction, a reversal, or nothing
 * at all is a decision for a layer that is allowed to know about ledgers.
 */
export function ingestWebhook(input: WebhookIngestInput): WebhookIngestResult {
  const { connector } = sourceProfile(input.source);

  const verified = connector.verifyWebhookSignature({
    headers: input.headers,
    rawBody: toRawBody(input.rawBody),
    secret: input.secret,
  });
  if (!verified) return { kind: 'unverified' };

  const parsed = connector.parseWebhook(toRawBody(input.rawBody));

  if (parsed.kind === 'unknown_event') {
    // Providers add event types without telling anyone. An unknown event is news we
    // have no use for, not an error — refusing it would make the provider retry it
    // every hour for three days.
    return { kind: 'ignored', reason: `unhandled event type: ${parsed.eventType}` };
  }
  if (parsed.kind === 'parse_error') {
    return { kind: 'rejected', reason: parsed.error.message };
  }

  const txn = parsed.transaction;

  if (txn.currency !== 'NGN') {
    return { kind: 'ignored', reason: `currency ${txn.currency} — this ledger keeps books in NGN only` };
  }
  if (txn.direction !== 'credit') {
    return { kind: 'ignored', reason: 'debit event — money leaving, not a promise of money arriving' };
  }

  return {
    kind: 'payment',
    payment: {
      reference: txn.providerReference,
      source: txn.provider,
      // The promise is the gross: what the customer paid. The fee is not yet knowable
      // and is booked when the settlement reveals it.
      gross: toMoney(txn.amountInKobo),
      status: txn.status,
      occurredAt: txn.occurredAt,
      idempotencyKey: idempotencyKey('payment', txn.dedupeKey),
    },
  };
}
