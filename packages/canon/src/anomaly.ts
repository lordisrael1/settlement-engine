/**
 * The ingest anomaly — evidence that a foreign format has moved under us.
 *
 * Every other record in this package is about *money*: a promise, a report of money sent,
 * proof that cash arrived. This one is about the **parser**, and it exists because the
 * failure it describes is the only one in the system that gets quieter as it gets worse.
 *
 * A reconciliation difference announces itself: money is missing, an amount disagrees, a
 * credit belongs to nobody. A format change does the opposite. The provider adds a column
 * and nothing happens. They rename a status and every row is politely classified as "not a
 * settlement" — which the ingest layer documents as *business as usual* — so the file that
 * most needs a human produces the calmest possible counters. By the time rows are visibly
 * malformed, the format has been drifting for weeks.
 *
 * So the drift is promoted from a statistic to a record, and it borrows the exact shape the
 * exception queue already uses, because a reader who knows one should know the other:
 *
 *   **It has a derived identity.** `(source, kind, detail)` — the same unknown field seen
 *   in forty files is one anomaly seen forty times, not forty pages of queue. This is the
 *   single reason the exception queue is readable on a Thursday, and it applies here with
 *   more force: ingest anomalies repeat once per file rather than once per run.
 *
 *   **Its lifecycle is appended, and it clears itself.** `open -> acknowledged -> resolved`,
 *   and a source whose files parse cleanly again resolves its own anomalies without anybody
 *   ticking a box (ADR-0044). A format change that was really a provider's bad afternoon
 *   must not need a person.
 *
 *   **It is not an exception.** `ExceptionSubject` is deliberately the four things a
 *   `Resolution` can answer (ADR-0043), and no human decision about a *payout* answers
 *   "Flutterwave added a field". It has no amount, no due date, and no rejected candidates.
 *   Filing it there would widen a vocabulary two other decisions depend on, to hold
 *   something nobody could resolve.
 */

import type { EvidenceKind, RowLineage } from './evidence.js';
import type { SourceId } from './identifiers.js';

/**
 * What kind of drift this is — ordered, roughly, by how early it fires.
 *
 * The order matters more than the list. Providers do not usually break a format; they
 * *extend* it, and then months later they lean on the extension. Watching only for
 * breakage means finding out last.
 */
export type AnomalyKind =
  /**
   * A field in the payload that no parser read.
   *
   * The earliest warning available, and the only one that arrives while everything still
   * works. A new `settlement_fee` key on a Flutterwave payout is not an error today; it is
   * the notice that today's arithmetic is about to stop explaining itself.
   */
  | 'unknown_field'
  /**
   * A known field carrying a value no adapter recognises — a status, a fee type, an entry
   * type.
   *
   * The dangerous middle. These are already handled *correctly* row by row: an unrecognised
   * status is refused rather than booked, an unrecognised fee type keeps its label and books
   * as a fee. What was missing is that both look identical to a normal day in the counters,
   * so a wholesale vocabulary change reads as an uneventful file.
   */
  | 'unknown_value'
  /**
   * The file is not the shape the adapter expects at all: an envelope where an array was
   * promised, a container that has moved.
   */
  | 'unknown_shape'
  /**
   * Rows the parser could not read at all.
   *
   * The latest warning, and the one that was already being computed and then discarded with
   * the HTTP response. Kept last on purpose: by the time this fires, the two above it have
   * usually been true for some time.
   */
  | 'malformed_rows';

export type AnomalyState = 'open' | 'acknowledged' | 'resolved';

const ALLOWED: Readonly<Record<AnomalyState, readonly AnomalyState[]>> = {
  open: ['acknowledged', 'resolved'],
  acknowledged: ['resolved', 'open'],
  resolved: ['open'],
};

export function canTransitionAnomaly(from: AnomalyState, to: AnomalyState): boolean {
  return ALLOWED[from].includes(to);
}

/**
 * Why an anomaly stopped being one.
 *
 * The same machine-versus-human distinction the exception queue draws, for the same reason:
 * the proportion that clear themselves is the number that tells you whether your thresholds
 * are tuned or merely loud.
 */
export type AnomalyCause =
  /** Files from this source parse cleanly again, and nobody had to do anything. */
  | 'format_conformed'
  /** A person looked and said what it was. */
  | 'acknowledged_by_human'
  /** The adapter was corrected, and the parser version that produced this is retired. */
  | 'parser_updated';

/**
 * One observation of drift, as the parser saw it.
 *
 * Produced by ingest — which has no database (ADR-0020) — and handed to whoever is storing.
 * Pure data: what was seen, where, and in which file.
 */
export interface IngestAnomaly {
  readonly key: string;
  readonly source: SourceId;
  readonly kind: AnomalyKind;
  /**
   * The specific thing seen, and the half of the key that makes it actionable.
   *
   * A JSON path for an unknown field (`$.data[].settlement_fee`), the offending value for
   * an unknown one (`status=SUCCESS`). Deliberately *not* free prose: it is a key component,
   * so it must be identical when the same drift is seen again, which means it can never
   * contain a row number, a timestamp, or a count.
   */
  readonly detail: string;
  /** Which artifact this came from, so the queue entry can show the bytes. */
  readonly evidenceId: string;
  readonly evidenceKind: EvidenceKind;
  /** The parser that failed to recognise it — the thing that will be changed to fix it. */
  readonly parserVersion: string;
  /** The declared foreign shape, e.g. `flutterwave-settlements-api-v4`. */
  readonly format: string;

  /** How many rows in this file showed it, and how many rows there were. */
  readonly occurrences: number;
  readonly rowsInFile: number;
  /** The first row that showed it. One example beats a count for reproducing anything. */
  readonly firstSeenAt: RowLineage;
  /**
   * A redacted sample of what was seen, for the reader who needs to look at it.
   *
   * Never the raw row: this is written to a queue people read casually, and the raw row is
   * already retained as evidence behind an access check (ADR-0066).
   */
  readonly sample: string | null;

  readonly observedAt: Date;
}

/** ASCII unit separator: a control character that cannot occur in a source id or a path. */
const SEPARATOR = String.fromCharCode(31);

/**
 * The natural key of a drift.
 *
 * Derived, never generated, for the reason `exceptionKey` is: the same unknown field found
 * in Monday's file and again in Tuesday's is one anomaly with one history. A generated id
 * would turn a single provider change into a page of identical alerts, which is the same as
 * no alert.
 */
export function anomalyKey(source: SourceId, kind: AnomalyKind, detail: string): string {
  return [source, kind, detail].join(SEPARATOR);
}

/**
 * How loudly to say it, from the kind and how much of the file was affected.
 *
 * The proportion is doing the real work. One malformed row in five thousand is a provider's
 * data-entry slip and belongs in a weekly report. Four thousand malformed rows out of five
 * thousand is a format change that happened this morning, and it is the same `kind` — only
 * the share tells them apart.
 */
export const ANOMALY_SEVERITY: Readonly<Record<AnomalyKind, number>> = {
  /** The format is not what we thought. Nothing parsed; nothing is being booked. */
  unknown_shape: 3,
  /** Rows are failing outright. */
  malformed_rows: 2,
  /** A vocabulary moved. Rows are being refused correctly and silently. */
  unknown_value: 2,
  /** News, not yet a problem — but the earliest news available. */
  unknown_field: 1,
};

/**
 * Where "a few odd rows" becomes "this file is not what we think it is".
 *
 * A judgement, not a truth, and kept here as one number so that changing it is one edit
 * with one test — the same reasoning that puts the narration token length in the bank
 * parser rather than in the matcher.
 */
export const WHOLESALE_THRESHOLD = 0.5;

/** What share of the file showed this drift. Zero rows means zero share, never a divide. */
export function anomalyShare(anomaly: IngestAnomaly): number {
  return anomaly.rowsInFile === 0 ? 0 : anomaly.occurrences / anomaly.rowsInFile;
}

export function anomalySeverity(anomaly: IngestAnomaly): number {
  const base = ANOMALY_SEVERITY[anomaly.kind];
  // A wholesale change outranks its own kind: every row carrying an unrecognised status is
  // a more urgent thing than a handful of them, and severity is what sorts the queue.
  return anomalyShare(anomaly) >= WHOLESALE_THRESHOLD ? Math.min(3, base + 1) : base;
}

/**
 * Did this file drift enough that the response should say so out loud?
 *
 * The file is still admitted and whatever parsed is still stored — a bank that adds a column
 * must not stop today's reconciliation, and row isolation is already the rule one level
 * down. `degraded` is the marker that makes the difference visible to the caller without
 * making it fatal, so that a cron job's 201 is not the same 201 as a quiet Tuesday's.
 */
export function isDegraded(anomalies: readonly IngestAnomaly[]): boolean {
  return anomalies.some((anomaly) => anomalySeverity(anomaly) >= 3);
}
