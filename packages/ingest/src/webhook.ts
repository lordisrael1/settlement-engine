import { toRawBody } from '@pay-normalize/core';

import type { CanonicalPayment, SourceId } from '@recon/canon';
import { idempotencyKey } from '@recon/canon';
import { scanForCardData } from '@recon/protect';

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
 * Is this delivery authentic?
 *
 * The whole of the question the transport layer is allowed to ask, separated out because
 * the answer is worth having *before* anything is interpreted. A service that accepts
 * deliveries durably and interprets them afterwards (see `@recon/inbox`) needs exactly
 * this in the request path and nothing else: verification is a keyed hash over bytes we
 * already hold, while interpretation is work that can wait and, on a bad day, fail.
 *
 * Signature schemes differ per provider — HMAC-SHA512 in hex here, HMAC-SHA256 in base64
 * there — and that knowledge stays inside the connector, which is why this takes a source
 * and not a scheme.
 */
export function verifyWebhook(input: WebhookIngestInput): boolean {
  return sourceProfile(input.source).connector.verifyWebhookSignature({
    headers: input.headers,
    rawBody: toRawBody(input.rawBody),
    secret: input.secret,
  });
}

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
  if (!verifyWebhook(input)) return { kind: 'unverified' };

  // Authentic, and still refused if it carries a card number or sensitive authentication
  // data. Checked after verification, because scanning bytes any stranger can choose is
  // work done on a stranger's behalf — and before parsing, because a payload we must not
  // hold is not made acceptable by being well-formed.
  //
  // `rejected` rather than `ignored`: this is a bug in a provider adapter or a payload
  // shape that changed, it must never be retried, and it must reach a person. The service
  // refuses the same delivery at the door, before it is stored at all (ADR-0066) — this
  // is the second layer, for the paths that reach a parser without passing the door.
  const cardData = scanForCardData(input.rawBody);
  if (cardData) {
    return {
      kind: 'rejected',
      reason:
        `refused: ${cardData.detail}. This system holds tokens and approved truncations ` +
        `only, and nothing downstream has been given these bytes.`,
    };
  }

  const { connector } = sourceProfile(input.source);
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
      // Carried from the moment we first hear of the payment, because the fee it will
      // attract is priced per rail and reconstructing the rail later means guessing.
      channel: txn.channel as CanonicalPayment['channel'],
      occurredAt: txn.occurredAt,
      idempotencyKey: idempotencyKey('payment', txn.dedupeKey),
    },
  };
}
