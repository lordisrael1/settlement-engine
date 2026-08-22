import type { Evidence, IngestAnomaly, Payout, SettlementLine, SourceId } from '@recon/canon';

import type { FieldSet } from '../drift.js';
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
   * `colliding-identity` — the row is fine, and an earlier row in this same file already
   *   claimed its id. Kept apart from `malformed` because nothing about it is malformed:
   *   the row parses, the money is real, and the *converter's* id scheme is what is broken.
   *   Filing it as malformed would put "the bank sent us a bad row" in a place where the
   *   truth is "we cannot tell these two credits apart" (ADR-0068).
   *
   * The distinction matters operationally: a rising `malformed` count means the
   * provider changed their format and an adapter needs updating; a rising
   * `not-a-settlement` count is usually just business as usual.
   *
   * Both halves of that were true and neither was ever *watched*, which is what `anomalies`
   * below is for. Two things go wrong with counters alone. They are computed per file and
   * discarded with the response, so nothing accumulates and nothing can say "this began on
   * Tuesday". And `not-a-settlement` really does hold one case that is not business as usual
   * — a record type the connector has never seen — filed beside the ordinary pending rows
   * that arrive in their thousands. A count cannot separate those; a keyed record can.
   */
  readonly kind: 'malformed' | 'not-a-settlement' | 'colliding-identity';
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
  /**
   * Ways this file was not the file we expected.
   *
   * Separate from `rejected`, and the separation is the point. A rejected row is a statement
   * about *that row*; an anomaly is a statement about the **format**, aggregated across the
   * whole file and keyed so that the same drift seen next week is the same record. The
   * counters above could say "thirty-eight rows were malformed" but never "this file grew a
   * `settlement_fee` column three weeks ago and has been growing it since", which is the
   * sentence somebody can act on.
   */
  readonly anomalies: readonly IngestAnomaly[];
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
  /**
   * Every key this adapter and its connector read, declared so that the ones they do not
   * can be noticed.
   *
   * Part of the contract rather than a private detail of each adapter, because it is the
   * thing that has to be updated in the same commit as a parsing change. A field added to
   * `ingest` and not added here reports itself as drift on the next file, which is a loud
   * and cheap way to be reminded.
   */
  readonly knownFields: readonly FieldSet[];
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
