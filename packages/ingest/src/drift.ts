import type {
  AnomalyKind,
  Evidence,
  IngestAnomaly,
  RowLineage,
  SourceId,
} from '@recon/canon';
import { NO_LINEAGE, anomalyKey } from '@recon/canon';

/**
 * Noticing that a foreign format has moved.
 *
 * The parsers in this package are already careful in the right way: a row they cannot read
 * is rejected rather than guessed at, a fee type they do not recognise keeps its label
 * rather than being dropped, a source with no verified export format has no parser at all
 * (ADR-0025). None of that is changed here. What is added is *memory of having noticed*.
 *
 * The distinction is worth being precise about, because it is the whole point. Every drift
 * this file detects was already being handled correctly — and thrown away. An unrecognised
 * status has always been refused; it was simply refused into a counter that the ingest layer
 * documents as meaning "business as usual", so a wholesale vocabulary change and an ordinary
 * pending row were indistinguishable in the only number anybody could see.
 *
 * Three things are watched, and they fire at different times:
 *
 *   **Unknown fields**, which fire *first* and while everything still works. Providers
 *   extend a format long before they break it, so a key nobody read is the earliest notice
 *   available and the only one that arrives with time to act on it.
 *
 *   **Unknown values** in fields we do read — the dangerous middle, invisible by
 *   construction until now.
 *
 *   **Malformed rows**, which fire last and were already being counted.
 *
 * Nothing here rejects anything. Detection is separate from admission on purpose: this
 * layer's job is to say what it saw, and whether a file is still worth parsing is a policy
 * question that belongs to the caller.
 */

/**
 * A drift a pure row function noticed, handed back rather than recorded.
 *
 * The row normalisers are deliberately pure — bytes in, canonical records out, no clock and
 * no state — and passing them a mutable collector would quietly end that. So they *return*
 * what they noticed and the fold records it, which keeps the mutation in one place and keeps
 * a row function something you can call in a test without constructing anything.
 */
export interface DriftNote {
  readonly field: string;
  readonly value: unknown;
}

/**
 * A drift seen at one row, before the file is finished.
 *
 * Accumulated rather than emitted, because a per-row alert is not an alert. The file is the
 * unit a person can act on: "three rows out of five thousand" and "four thousand out of five
 * thousand" are the same observation repeated, and only the ratio says which one is an
 * incident.
 */
interface Observation {
  readonly kind: AnomalyKind;
  readonly detail: string;
  readonly sample: string | null;
  readonly lineage: RowLineage;
}

/**
 * Collects drift across one file and folds it into anomalies at the end.
 *
 * Deliberately mutable and deliberately short-lived — one instance per parse, discarded
 * when the file is done. That is the one place mutation is honest here: the alternative is
 * threading an accumulator through every row function, which would put bookkeeping in the
 * signature of code whose job is money.
 */
export class DriftWatch {
  private readonly seen = new Map<string, Observation & { occurrences: number }>();
  private rows = 0;

  constructor(
    private readonly source: SourceId,
    private readonly format: string,
  ) {}

  /**
   * How many rows this file had, whether they parsed or not.
   *
   * The denominator, and it must count rejected rows too. Measuring the share of *surviving*
   * rows that drifted would report a file where everything failed as perfectly healthy,
   * which is the exact failure this whole file exists to prevent.
   */
  countRow(): void {
    this.rows += 1;
  }

  countRows(n: number): void {
    this.rows += n;
  }

  /** A field in the payload that no parser read. */
  unknownField(path: string, lineage: RowLineage = NO_LINEAGE): void {
    this.observe({ kind: 'unknown_field', detail: path, sample: null, lineage });
  }

  /**
   * A field we do read, carrying a value no adapter recognises.
   *
   * `field` and `value` are joined rather than passed as prose because `detail` is half of
   * the anomaly's derived key: `status=SUCCESS` seen in Monday's file and again in Tuesday's
   * has to produce a byte-identical key, or the queue grows by the number of files.
   */
  unknownValue(field: string, value: unknown, lineage: RowLineage = NO_LINEAGE): void {
    const rendered = renderValue(value);
    this.observe({
      kind: 'unknown_value',
      detail: `${field}=${rendered}`,
      sample: rendered,
      lineage,
    });
  }

  /** The file is not the shape the adapter expects at all. */
  unknownShape(detail: string, sample: string | null = null): void {
    this.observe({ kind: 'unknown_shape', detail, sample, lineage: NO_LINEAGE });
  }

  /**
   * A row the parser could not read.
   *
   * The reason is *not* part of the key. Parser messages carry row-specific text — an
   * offending value, a JSON position — and keying on them would make every malformed row its
   * own anomaly with its own history, which is a log rather than a queue. One
   * `malformed_rows` anomaly per file-format, counted.
   */
  malformedRow(reason: string, lineage: RowLineage = NO_LINEAGE): void {
    this.observe({
      kind: 'malformed_rows',
      detail: this.format,
      sample: reason.slice(0, 200),
      lineage,
    });
  }

  private observe(observation: Observation): void {
    const key = anomalyKey(this.source, observation.kind, observation.detail);
    const existing = this.seen.get(key);
    if (existing) {
      existing.occurrences += 1;
      return;
    }
    // The first row wins the sample and the lineage. A later row would overwrite the example
    // somebody is most likely to be able to reproduce, and "the first place this appeared" is
    // the more useful fact when reading a file top to bottom.
    this.seen.set(key, { ...observation, occurrences: 1 });
  }

  /**
   * Everything this file drifted, as records.
   *
   * Sorted by how much of the file each affected, so that a reader who looks at one entry
   * looks at the one that says the most about whether this format still is what we think.
   */
  anomalies(evidence: Evidence, observedAt: Date): IngestAnomaly[] {
    return [...this.seen.entries()]
      .map(([key, observation]) => ({
        key,
        source: this.source,
        kind: observation.kind,
        detail: observation.detail,
        evidenceId: evidence.evidenceId,
        evidenceKind: evidence.kind,
        parserVersion: evidence.parserVersion,
        format: this.format,
        occurrences: observation.occurrences,
        rowsInFile: this.rows,
        firstSeenAt: observation.lineage,
        sample: observation.sample,
        observedAt,
      }))
      .sort((a, b) => b.occurrences - a.occurrences);
  }
}

/**
 * The fields one adapter reads at one level of a record.
 *
 * Two levels are needed because the sources genuinely have two. Nomba hands over a bare
 * transaction record; Monnify wraps each one in its own `{ requestSuccessful, responseBody }`
 * envelope, and checking only the outer object there would watch the wrapper forever while
 * the fields that carry the money changed underneath it.
 */
export interface FieldSet {
  /** `''` for the record itself, or the key of a nested object to descend into. */
  readonly at: string;
  readonly fields: readonly string[];
}

/**
 * Every key in a record that the parser did not read.
 *
 * The comparison is against a declared list rather than against the type, because a
 * TypeScript interface is erased by the time these bytes exist and cannot be asked what it
 * knows. That makes the list a maintenance obligation: adding a field to a parser means
 * adding it here, and forgetting produces a false alarm rather than a silent miss. That is
 * the right way round — a spurious anomaly is noticed and deleted in a minute, while a
 * missed one is the failure mode this exists to close.
 *
 * There is a sharper reason this cannot be left to the connectors. Their schemas end in
 * `.passthrough()`, which is the correct choice for a normalisation library — refusing a row
 * because it grew a field would be brittle and would break every host on the provider's
 * schedule. But `passthrough` is exactly "accept what you do not understand and say nothing",
 * so the connectors are structurally incapable of raising this. It has to happen here.
 */
export function unreadFields(
  record: unknown,
  known: readonly FieldSet[],
  root: string,
): string[] {
  const self = asRecord(record);
  if (!self) return [];

  const paths: string[] = [];

  for (const level of known) {
    const target = level.at === '' ? self : asRecord(self[level.at]);
    if (!target) continue;
    const prefix = level.at === '' ? root : `${root}.${level.at}`;
    const knownSet = new Set(level.fields);
    for (const key of Object.keys(target)) {
      if (!knownSet.has(key)) paths.push(`${prefix}.${key}`);
    }
  }

  return paths;
}

/** A JSON object, or nothing. Arrays are excluded: an array is not a record of fields. */

export function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * A value, rendered short and safe for a queue entry.
 *
 * Truncated because a queue is read casually and an unbounded string from a provider's file
 * is not something to paste into one. Nothing sensitive should reach here — these are status
 * codes and fee labels — but the bound is kept anyway, because "should" is not a guarantee
 * about somebody else's file.
 */
function renderValue(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  const text = typeof value === 'string' ? value : JSON.stringify(value) ?? String(value);
  return text.length > 64 ? `${text.slice(0, 64)}…` : text;
}
