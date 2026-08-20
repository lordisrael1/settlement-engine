/**
 * The identifiers the whole system passes around.
 *
 * `SourceId` is deliberately an open `string`, not a union of known PSPs. A closed union
 * would mean adding a payment source requires editing the canonical language, and would
 * invite exhaustive `switch` statements downstream — exactly the branching the canonical
 * boundary forbids.
 * A new source is one adapter in `packages/ingest` and nothing else.
 */

/** e.g. `'paystack'`, `'flutterwave'`, `'nibss'`. Lower-case, stable, adapter-declared. */
export type SourceId = string;

/** The source's own reference for an event. Unique within that source, not globally. */
export type Reference = string;

/**
 * The PSP's own identifier for one payout — one money movement, covering many payments.
 *
 * This is the join that makes batched settlement tractable. Without it, a payout is an
 * amount and a date, and attaching payments to it is guesswork; with it, the PSP has told
 * us which payments it covers and the arithmetic only has to confirm what we were told.
 */
export type PayoutReference = string;

/**
 * Whose money this is.
 *
 * Fee contracts are negotiated per merchant, so a rate card without a merchant attached is
 * a rate card for nobody in particular. Single-merchant deployments still carry it, because
 * the day a second merchant appears must not be the day every historical fee becomes wrong.
 */
export type MerchantId = string;

export type TransactionId = string;

export type EntryId = string;

/**
 * The natural key of a real-world event: `source` + the source's reference.
 * The same event arriving twice produces the same key, and the second arrival is dropped.
 */
export type IdempotencyKey = string;

/**
 * The four rails a record can arrive on, and why the namespace matters.
 *
 * A payment, the settlement line that reports it, the payout that carries it and the bank
 * credit that proves it can all quote the same provider reference. They are four different
 * events about one payment, and collapsing any two of them onto one key would silently
 * drop one as a duplicate — losing exactly the independent second opinion the
 * whole system is built to compare.
 */
export type EventRail = 'payment' | 'settlement' | 'payout' | 'bank';

/**
 * `dedupeKey` is the source-namespaced reference produced by
 * `composeDedupeKey(provider, reference)` in `@pay-normalize/core` — already
 * `${provider}:${reference}`. We take it whole rather than recomposing from parts,
 * because a connector may legitimately override it when a provider's reference is not
 * one-to-one with a transaction, and recomposing would silently discard that knowledge.
 */
export function idempotencyKey(rail: EventRail, dedupeKey: string): IdempotencyKey {
  return `${rail}:${dedupeKey}`;
}
