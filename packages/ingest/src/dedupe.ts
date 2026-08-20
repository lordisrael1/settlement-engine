import type { IdempotencyKey } from '@recon/canon';

export interface Deduped<T> {
  readonly fresh: readonly T[];
  readonly duplicates: readonly T[];
}

/**
 * Deduplication, as a pure function.
 *
 * Two kinds of duplicate are removed: events already seen in an earlier run, and events
 * repeated *within* this batch — a re-exported file that overlaps the previous one, or a
 * provider listing the same record twice on one page. The second kind is easy to forget
 * and produces exactly the same damage.
 *
 * The set of already-seen keys is passed in rather than looked up, which is what keeps
 * this package free of a database. Ingest's job is to say what the events are; where the
 * record of having seen them lives is a decision for a layer that owns storage.
 *
 * Order is preserved, and the first occurrence wins, so the result does not depend on
 * anything but the input (determinism).
 */
export function dedupe<T extends { readonly idempotencyKey: IdempotencyKey }>(
  items: readonly T[],
  alreadySeen: ReadonlySet<IdempotencyKey> = new Set(),
): Deduped<T> {
  const fresh: T[] = [];
  const duplicates: T[] = [];
  const seenInBatch = new Set<IdempotencyKey>();

  for (const item of items) {
    if (alreadySeen.has(item.idempotencyKey) || seenInBatch.has(item.idempotencyKey)) {
      duplicates.push(item);
      continue;
    }
    seenInBatch.add(item.idempotencyKey);
    fresh.push(item);
  }

  return { fresh, duplicates };
}
