import type { AnomalyCause, AnomalyState, IngestAnomaly, SourceId } from '@recon/canon';
import { anomalySeverity, canTransitionAnomaly } from '@recon/canon';
import type { Executor } from '@recon/ledger-core';
import { inTransaction } from '@recon/ledger-core';

/**
 * The drift queue — and the machinery that keeps it honest between files.
 *
 * `@recon/ingest` can say what one file drifted. On its own that is a statistic in an HTTP
 * response: it cannot say that a field first appeared three weeks ago, that somebody already
 * looked at it, or that it has stopped appearing. This turns the statistic into a record,
 * with the same three operations the exception queue uses and for the same reasons:
 *
 *   `recordAnomalies`   write down what this file drifted, once per distinct drift
 *   `acknowledgeAnomaly`  a person takes it
 *   `clearConformed`    files from this source parse cleanly again, so it is over
 *
 * The third is the one that matters. Without it the table only grows, and a queue that only
 * grows is one people stop opening — which for an alerting mechanism is the same as not
 * having built it. A provider who fixed their own bad afternoon must cost nobody a click.
 */

/** What one file's worth of recording did, for the caller to report. */
export interface AnomalyOutcome {
  /** Drifts never seen before. These are the ones worth waking somebody for. */
  readonly raised: readonly string[];
  /** Drifts already open or acknowledged, observed again. A new event, not a new problem. */
  readonly recurring: readonly string[];
  /** Drifts that had resolved and have come back. The most informative outcome of the three. */
  readonly reopened: readonly string[];
}

/**
 * Write down everything one file drifted.
 *
 * Every observation appends, including the ones that change nothing, because "seen again in
 * today's file" is itself the fact that distinguishes a format change from a one-off. What
 * varies is the *state transition* the event carries, and that is where the three outcomes
 * above come from.
 *
 * The whole file's observations go in one transaction. A partial write here would leave a
 * queue that disagrees with the evidence record it points at, and this table exists to be
 * trusted about exactly that.
 */
export async function recordAnomalies(
  db: Executor,
  anomalies: readonly IngestAnomaly[],
): Promise<AnomalyOutcome> {
  const raised: string[] = [];
  const recurring: string[] = [];
  const reopened: string[] = [];

  if (anomalies.length === 0) return { raised, recurring, reopened };

  await inTransaction(db, async (client) => {
    for (const anomaly of anomalies) {
      const current = await currentState(client, anomaly.key);

      // `resolved -> open` is a reopening and is appended as one, never rewritten as though
      // the anomaly had been open the whole time. Which problems come back is the single most
      // useful thing this table knows, and an UPDATE would erase it (ADR-0034).
      const to: AnomalyState = 'open';
      if (current === 'resolved') reopened.push(anomaly.key);
      else if (current === null) raised.push(anomaly.key);
      else recurring.push(anomaly.key);

      // An acknowledged anomaly stays acknowledged when it is seen again. Somebody has it;
      // another file showing the same drift is not news that un-assigns them, and flipping it
      // back to open would make a person's ownership evaporate on the next upload.
      const nextState: AnomalyState =
        current === 'acknowledged' ? 'acknowledged' : current !== null && !canTransitionAnomaly(current, to) ? current : to;

      await client.query(
        `INSERT INTO ingest_anomaly_events
                (anomaly_key, source, kind, detail, from_state, to_state, at,
                 evidence_id, evidence_kind, parser_version, format,
                 occurrences, rows_in_file, first_row, first_path, sample)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)`,
        [
          anomaly.key,
          anomaly.source,
          anomaly.kind,
          anomaly.detail,
          current,
          nextState,
          anomaly.observedAt,
          anomaly.evidenceId,
          anomaly.evidenceKind,
          anomaly.parserVersion,
          anomaly.format,
          anomaly.occurrences,
          anomaly.rowsInFile,
          anomaly.firstSeenAt.rowNumber,
          anomaly.firstSeenAt.path,
          anomaly.sample,
        ],
      );
    }
  });

  return { raised, recurring, reopened };
}

/**
 * Close the anomalies a source is no longer showing.
 *
 * Called after a file from that source parses without drifting, with the keys that file *did*
 * drift — everything else open against that source is, on this evidence, over.
 *
 * Scoped to one source on purpose. A clean Flutterwave file says nothing whatsoever about a
 * Monnify field that moved last week, and clearing across sources would let a healthy,
 * chatty source silence a quiet broken one — which is precisely the failure that makes people
 * stop trusting a queue.
 */
export async function clearConformed(
  db: Executor,
  source: SourceId,
  stillDrifting: readonly string[],
  at: Date,
): Promise<string[]> {
  const cleared: string[] = [];

  await inTransaction(db, async (client) => {
    const open = await client.query<{ anomaly_key: string; state: AnomalyState }>(
      `SELECT anomaly_key, state FROM ingest_anomalies
       WHERE source = $1 AND state <> 'resolved'`,
      [source],
    );

    const drifting = new Set(stillDrifting);

    for (const row of open.rows) {
      if (drifting.has(row.anomaly_key)) continue;

      await client.query(
        `INSERT INTO ingest_anomaly_events
                (anomaly_key, source, kind, detail, from_state, to_state, at, cause,
                 occurrences, rows_in_file)
         SELECT anomaly_key, source, kind, detail, $2, 'resolved', $3, 'format_conformed', 0, 0
         FROM ingest_anomalies WHERE anomaly_key = $1`,
        [row.anomaly_key, row.state, at],
      );
      cleared.push(row.anomaly_key);
    }
  });

  return cleared;
}

/** A named person takes ownership. Still drifting, but no longer unowned. */
export async function acknowledgeAnomaly(
  db: Executor,
  key: string,
  actor: string,
  at: Date,
  note: string | null = null,
): Promise<boolean> {
  return transition(db, key, 'acknowledged', at, actor, null, note);
}

/**
 * A person says what it was, and it stops being a question.
 *
 * `parser_updated` is the honest cause when an adapter has been corrected: the drift was real,
 * somebody fixed the parser, and the anomalies the old one raised are answered by that fix
 * rather than by the provider changing back.
 */
export async function resolveAnomaly(
  db: Executor,
  key: string,
  actor: string,
  cause: Exclude<AnomalyCause, 'format_conformed'>,
  at: Date,
  note: string | null = null,
): Promise<boolean> {
  return transition(db, key, 'resolved', at, actor, cause, note);
}

async function transition(
  db: Executor,
  key: string,
  to: AnomalyState,
  at: Date,
  actor: string,
  cause: AnomalyCause | null,
  note: string | null,
): Promise<boolean> {
  return inTransaction(db, async (client) => {
    const current = await currentState(client, key);
    if (current === null || !canTransitionAnomaly(current, to)) return false;

    await client.query(
      `INSERT INTO ingest_anomaly_events
              (anomaly_key, source, kind, detail, from_state, to_state, at, actor, cause, note,
               occurrences, rows_in_file)
       SELECT anomaly_key, source, kind, detail, $2, $3, $4, $5, $6, $7, 0, 0
       FROM ingest_anomalies WHERE anomaly_key = $1`,
      [key, current, to, at, actor, cause, note],
    );
    return true;
  });
}

async function currentState(db: Executor, key: string): Promise<AnomalyState | null> {
  const result = await db.query<{ to_state: AnomalyState }>(
    `SELECT to_state FROM ingest_anomaly_events
     WHERE anomaly_key = $1 ORDER BY event_id DESC LIMIT 1`,
    [key],
  );
  return result.rows[0]?.to_state ?? null;
}

/** One row of the drift queue, as a reader sees it. */
export interface QueuedAnomaly {
  readonly key: string;
  readonly source: SourceId;
  readonly kind: IngestAnomaly['kind'];
  readonly detail: string;
  readonly state: AnomalyState;
  readonly since: Date;
  readonly firstSeen: Date;
  readonly lastSeen: Date;
  readonly filesAffected: number;
  readonly timesRaised: number;
  readonly occurrences: number;
  readonly rowsInFile: number;
  readonly share: number;
  readonly severity: number;
  readonly evidenceId: string | null;
  readonly parserVersion: string | null;
  readonly format: string | null;
  readonly firstPath: string | null;
  readonly sample: string | null;
}

/**
 * The queue, worst first.
 *
 * Sorted by severity and then by how long it has been going, rather than by arrival. A field
 * that has been drifting quietly for three weeks outranks one first seen this morning, because
 * the long-running one has had three weeks to be wrong in.
 */
export async function openAnomalies(
  db: Executor,
  limit = 100,
): Promise<QueuedAnomaly[]> {
  const result = await db.query<Record<string, string | number | Date | null>>(
    `SELECT * FROM ingest_anomalies WHERE state <> 'resolved' ORDER BY first_seen ASC LIMIT $1`,
    [limit],
  );

  return result.rows
    .map((row) => {
      const queued: QueuedAnomaly = {
        key: row['anomaly_key'] as string,
        source: row['source'] as SourceId,
        kind: row['kind'] as IngestAnomaly['kind'],
        detail: row['detail'] as string,
        state: row['state'] as AnomalyState,
        since: row['since'] as Date,
        firstSeen: row['first_seen'] as Date,
        lastSeen: row['last_seen'] as Date,
        filesAffected: Number(row['files_affected'] ?? 0),
        timesRaised: Number(row['times_raised'] ?? 0),
        occurrences: Number(row['occurrences'] ?? 0),
        rowsInFile: Number(row['rows_in_file'] ?? 0),
        share: Number(row['share'] ?? 0),
        // Recomputed from the canonical function rather than stored, so that retuning the
        // thresholds retunes the whole queue rather than only the files ingested afterwards.
        severity: 0,
        evidenceId: (row['evidence_id'] as string) ?? null,
        parserVersion: (row['parser_version'] as string) ?? null,
        format: (row['format'] as string) ?? null,
        firstPath: (row['first_path'] as string) ?? null,
        sample: (row['sample'] as string) ?? null,
      };
      return {
        ...queued,
        severity: anomalySeverity({
          kind: queued.kind,
          occurrences: queued.occurrences,
          rowsInFile: queued.rowsInFile,
        } as IngestAnomaly),
      };
    })
    .sort((a, b) => b.severity - a.severity || a.firstSeen.getTime() - b.firstSeen.getTime());
}
