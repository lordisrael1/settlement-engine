-- Ingest anomalies: the foreign formats moving under us, with lives of their own.
--
-- Every parser in this system already refuses what it cannot read, and refuses it correctly:
-- a row it cannot parse is rejected rather than guessed at, a source with no verified export
-- format has no parser at all. What none of that produced was a *memory*. The counts were
-- computed per file, returned in an HTTP response, and dropped — so nothing could say that a
-- field first appeared three weeks ago, that somebody had already looked at it, or that it
-- had stopped appearing.
--
-- Note the shape, because it is deliberately the shape `exception_events` already uses,
-- which is in turn the shape the ledger uses for `transaction_state_changes`: an append-only
-- table of observations, and a view deriving the current state from the newest one. A reader
-- who knows one knows all three. A mutable `state` column would be an UPDATE, and UPDATEs are
-- how history gets quietly rewritten.
--
-- What this is NOT is an exception. `exception_events.subject` is deliberately the four
-- things a `Resolution` can answer — payout, bank credit, transaction, settlement line — and
-- no human decision about a payout answers "Monnify added a field". An anomaly has no amount,
-- no due date, and no rejected candidates, and putting it there would have widened a
-- vocabulary two other decisions depend on in order to hold something nobody could resolve.

-- ---------------------------------------------------------------------------
-- Every observation about one drift, in order.
--
-- `anomaly_key` is derived, not generated: source + kind + detail, joined by a control
-- character, exactly as `exception_key` is. The same unknown field seen in Monday's file and
-- again in Tuesday's is one anomaly seen twice. Without that the table grows by the number of
-- files ingested rather than by the number of things wrong, which for a source that uploads
-- hourly is the difference between a queue and a firehose.
--
-- `detail` is therefore never allowed to carry a row number, a timestamp or a count — those
-- would make every observation its own anomaly. They live in the columns below, where they
-- can vary without splitting the history.
-- ---------------------------------------------------------------------------
CREATE TABLE ingest_anomaly_events (
  event_id      BIGSERIAL PRIMARY KEY,
  anomaly_key   TEXT NOT NULL,

  source        TEXT NOT NULL,
  kind          TEXT NOT NULL
                CHECK (kind IN ('unknown_field', 'unknown_value', 'unknown_shape', 'malformed_rows')),
  detail        TEXT NOT NULL,

  -- NULL on the raise, exactly as `exception_events` and `transaction_state_changes` record
  -- an initial state as a change from NULL.
  from_state    TEXT CHECK (from_state IN ('open', 'acknowledged', 'resolved')),
  to_state      TEXT NOT NULL CHECK (to_state IN ('open', 'acknowledged', 'resolved')),
  at            TIMESTAMPTZ NOT NULL,

  -- The file this observation came from, and the parser that failed to recognise it. The
  -- parser version is the single most useful column here: it names the thing that will be
  -- edited to fix this, and it makes every conclusion drawn by the old one findable
  -- afterwards.
  evidence_id   TEXT REFERENCES evidence (evidence_id),
  evidence_kind TEXT,
  parser_version TEXT,
  format        TEXT,

  -- How much of the file showed it. The ratio, not the count, is what separates a provider's
  -- data-entry slip from a format change that happened this morning — one malformed row in
  -- five thousand and four thousand in five thousand are the same `kind`.
  occurrences   INT NOT NULL DEFAULT 0 CHECK (occurrences >= 0),
  rows_in_file  INT NOT NULL DEFAULT 0 CHECK (rows_in_file >= 0),
  -- Where it first appeared, so somebody can open the file and look at it.
  first_row     INT,
  first_path    TEXT,
  -- A short, redacted example. Never the raw row: this table is read casually and the raw
  -- bytes are already retained as evidence behind an access check (ADR-0066).
  sample        TEXT,

  -- Who moved it, where a person did. NULL for the parser's own observations, which is how
  -- "this cleared itself" and "somebody cleared this" stay distinguishable — and that
  -- proportion is the number that says whether these thresholds are tuned or merely loud.
  actor         TEXT,
  cause         TEXT CHECK (cause IN ('format_conformed', 'acknowledged_by_human', 'parser_updated')),
  note          TEXT
);

CREATE INDEX ingest_anomaly_events_key_idx ON ingest_anomaly_events (anomaly_key, event_id DESC);
CREATE INDEX ingest_anomaly_events_source_idx ON ingest_anomaly_events (source, at DESC);
CREATE INDEX ingest_anomaly_events_evidence_idx ON ingest_anomaly_events (evidence_id);

-- ---------------------------------------------------------------------------
-- The queue: one row per drift, as it currently stands.
--
-- `DISTINCT ON` over the newest event per key, the same construction the exception queue's
-- view uses. `first_seen` and `last_seen` come from the whole history rather than the newest
-- event, because "when did this start" is the question that turns an anomaly into a diagnosis
-- — a field that first appeared the day the fee variances began is an explanation, and the
-- newest event alone could never say so.
-- ---------------------------------------------------------------------------
CREATE VIEW ingest_anomalies AS
WITH latest AS (
  SELECT DISTINCT ON (anomaly_key) *
  FROM ingest_anomaly_events
  ORDER BY anomaly_key, event_id DESC
),
history AS (
  SELECT
    anomaly_key,
    min(at)                                   AS first_seen,
    max(at)                                   AS last_seen,
    count(*) FILTER (WHERE from_state IS NULL) AS times_raised,
    sum(occurrences)                          AS total_occurrences,
    count(DISTINCT evidence_id)               AS files_affected
  FROM ingest_anomaly_events
  GROUP BY anomaly_key
)
SELECT
  latest.anomaly_key,
  latest.source,
  latest.kind,
  latest.detail,
  latest.to_state       AS state,
  latest.at             AS since,
  latest.evidence_id,
  latest.evidence_kind,
  latest.parser_version,
  latest.format,
  latest.occurrences,
  latest.rows_in_file,
  latest.first_row,
  latest.first_path,
  latest.sample,
  latest.actor,
  latest.cause,
  latest.note,
  history.first_seen,
  history.last_seen,
  history.times_raised,
  history.total_occurrences,
  history.files_affected,
  -- The share of the most recent file that showed it, which is what severity turns on.
  CASE WHEN latest.rows_in_file = 0 THEN 0::numeric
       ELSE round(latest.occurrences::numeric / latest.rows_in_file, 4)
  END AS share
FROM latest
JOIN history USING (anomaly_key);
