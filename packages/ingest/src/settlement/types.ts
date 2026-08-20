import type { Evidence, Payout, SettlementLine, SourceId } from '@recon/canon';

import type { EvidenceContext } from '../evidence.js';

/**
 * A row that will not become a canonical record, and why.
 *
 * Rejection is row-isolated on purpose: one mangled row in a five-thousand-row export
 * must not cost us the other four thousand nine hundred and ninety-nine. All-or-nothing
 * parsing punishes us for the provider's data quality.
 */
export interface RejectedRow {
  /**
   * `malformed` — the row is structurally unusable or its own numbers disagree.
   * `not-a-settlement` — the row is perfectly valid but is not money arriving:
   *   a pending or failed row, a debit, a currency we do not keep books in.
   *
   * The distinction matters operationally: a rising `malformed` count means the
   * provider changed their format and an adapter needs updating; a rising
   * `not-a-settlement` count is usually just business as usual.
   */
  readonly kind: 'malformed' | 'not-a-settlement';
  readonly reason: string;
  readonly raw: unknown;
}

/**
 * What a settlement export yields — and note that it is two different things.
 *
 * Sources fall into two camps, and flattening them would lose the distinction that makes
 * matching tractable. Some report **payouts**: one money movement, with its own reference
 * and its own itemised deductions, covering a number of charges it does not enumerate.
 * Others report **transactions**: individual settled payments, with no statement of which
 * movement carries them.
 *
 * A payout is strictly better information — the PSP has told us the grouping, so the
 * arithmetic only has to confirm it rather than discover it. Where we only get lines, the
 * grouping has to be inferred, and inference is what subset-sum is for.
 */
export interface SettlementIngestResult {
  readonly source: SourceId;
  /** Which fixture-tested foreign shape was recognised, e.g. `flutterwave-settlements-api-v4`. */
  readonly format: string;
  /** The bytes this came from, hashed and attributed. */
  readonly evidence: Evidence;
  readonly payouts: readonly Payout[];
  readonly lines: readonly SettlementLine[];
  readonly rejected: readonly RejectedRow[];
}

/**
 * One adapter per settlement source. The whole variety of the outside world — JSON
 * envelopes, row arrays, and whatever the next source speaks — is contained behind this
 * one method, so that everything downstream sees canonical records and cannot tell the
 * difference (the canonical boundary).
 *
 * Deliberately synchronous and pure: bytes in, canonical events out. No network, no clock,
 * no database. Fetching the bytes is the caller's business, and deduplicating the result
 * is a separate step, because dedupe needs state and an adapter must not have any.
 */
export interface SettlementSource {
  readonly source: SourceId;
  readonly format: string;
  /** Bumped whenever the parsing changes. Recorded with every record it produces. */
  readonly parserVersion: string;
  ingest(payload: Buffer, context: SettlementContext): SettlementIngestResult;
}

/**
 * What the adapter cannot know from the bytes alone: whose money this is, and who handed
 * us the file. Both are needed before a single record can be attributed or a fee contract
 * chosen, and neither is ever inside a PSP's export.
 */
export interface SettlementContext extends Omit<EvidenceContext, 'kind' | 'source'> {
  readonly merchantId: string;
}
