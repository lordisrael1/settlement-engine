/**
 * The identifiers the whole system passes around.
 *
 * `SourceId` is deliberately an open `string`, not a union of known PSPs. A closed union
 * would mean adding a payment source requires editing the canonical language, and would
 * invite exhaustive `switch` statements downstream — exactly the branching Law 7 forbids.
 * A new source is one adapter in `packages/ingest` and nothing else.
 */

/** e.g. `'paystack'`, `'flutterwave'`, `'nibss'`. Lower-case, stable, adapter-declared. */
export type SourceId = string;

/** The source's own reference for an event. Unique within that source, not globally. */
export type Reference = string;

export type TransactionId = string;

export type EntryId = string;

/**
 * Law 4. The natural key of a real-world event: `source` + the source's reference.
 * The same event arriving twice produces the same key, and the second arrival is dropped.
 */
export type IdempotencyKey = string;

/**
 * Promise and money for the same reference are distinct events and must not collide,
 * so the key is namespaced by which rail the event arrived on.
 */
export type EventRail = 'payment' | 'settlement';

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
