import type { SettlementLine, SourceId } from '@recon/canon';

/**
 * A row that will not become a `SettlementLine`, and why.
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

export interface SettlementIngestResult {
  readonly source: SourceId;
  /** Which fixture-tested foreign shape was recognised, e.g. `flutterwave-settlements-api-v4`. */
  readonly format: string;
  readonly lines: readonly SettlementLine[];
  readonly rejected: readonly RejectedRow[];
}

/**
 * One adapter per settlement source. The whole variety of the outside world — JSON
 * envelopes, row arrays, and whatever the next source speaks — is contained behind this
 * one method, so that everything downstream sees `SettlementLine[]` and cannot tell the
 * difference (Law 7).
 *
 * Deliberately synchronous and pure: bytes in, canonical events out. No network, no
 * clock, no database. Fetching the bytes is the caller's business, and deduplicating the
 * result is a separate step, because dedupe needs state and an adapter must not have any.
 */
export interface SettlementSource {
  readonly source: SourceId;
  readonly format: string;
  ingest(payload: Buffer): SettlementIngestResult;
}
