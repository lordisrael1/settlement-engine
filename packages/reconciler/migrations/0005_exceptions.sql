-- The exception queue: differences nobody has explained, with lives of their own.
--
-- Phase 3 produced conclusions and wrote them to `matches`. What it could not do is
-- remember. Every run rediscovered the same unexplained difference, reported it again, and
-- had no way to say whether a human had already looked at it, whether it had been open for
-- a week, or whether it had quietly gone away.
--
-- Note the shape, because it is deliberately the shape the ledger already uses for its own
-- lifecycle: an append-only table of *events*, and a view that derives the current state
-- from the newest one. A `state` column would be an UPDATE, and UPDATEs are how history gets
-- quietly rewritten (Law 2). The ledger refuses that for transactions; there is no argument
-- for allowing it for the judgements made about them.

-- ---------------------------------------------------------------------------
-- Every observation about an exception, in order.
--
-- The first event for a key is its raise (`from_state IS NULL`), exactly as
-- `transaction_state_changes` records an initial state as a change from NULL.
--
-- `exception_key` is derived, not generated: subject + subject id + reason code, joined by
-- a control character. The same difference found on Monday and again on Tuesday is one
-- exception seen twice — without that, the queue grows by the number of runs rather than by
-- the number of problems, and nobody reads it by Thursday. Derivation is also what lets a
-- replay reach the same keys as the run it replays (Law 5).
-- ---------------------------------------------------------------------------
CREATE TABLE exception_events (
  event_id      BIGSERIAL PRIMARY KEY,
  exception_key TEXT NOT NULL,

  subject       TEXT NOT NULL
                CHECK (subject IN ('payout', 'bank_credit', 'transaction', 'settlement_line')),
  subject_id    TEXT NOT NULL,
  reason        TEXT NOT NULL,

  -- NULL on the raise. Thereafter the state this event moved the exception out of.
  from_state    TEXT CHECK (from_state IN ('open', 'acknowledged', 'resolved')),
  to_state      TEXT NOT NULL CHECK (to_state IN ('open', 'acknowledged', 'resolved')),
  at            TIMESTAMPTZ NOT NULL,

  -- What the difference is worth, and when the money was due. Both nullable: not every
  -- exception is about an amount, and not every one is about lateness.
  amount_kobo   BIGINT,
  currency      TEXT,
  due_at        TIMESTAMPTZ,
  evidence_id   TEXT REFERENCES evidence (evidence_id),

  -- The records this concerns, so a queue entry can show the whole picture without the
  -- reader running four more queries.
  links         JSONB NOT NULL DEFAULT '{}',
  -- The working, kept: [{candidate_id, kind, difference_kobo, rejected_because}]. An
  -- exception that says "unidentified" without saying what was considered is a question
  -- handed to a human with the reasoning thrown away.
  considered    JSONB NOT NULL DEFAULT '[]',

  -- Who moved it, where a person did. NULL for the matcher's own observations, which is how
  -- "the machine cleared this" and "somebody cleared this" stay distinguishable.
  actor         TEXT,
  -- Why it stopped being an exception: evidence_arrived | resolved_by_human | superseded.
  cause         TEXT CHECK (cause IN ('evidence_arrived', 'resolved_by_human', 'superseded')),
  -- The human decision that answered it, where one did.
  resolution_key TEXT,

  CONSTRAINT exception_events_amount_complete
    CHECK ((amount_kobo IS NULL) = (currency IS NULL)),
  -- A resolution is caused by something. Recording that an exception closed without saying
  -- why is the one field whose absence makes the whole table useless for the question it
  -- exists to answer: how much of this queue clears itself?
  CONSTRAINT exception_events_resolved_has_cause
    CHECK (to_state <> 'resolved' OR cause IS NOT NULL)
);

CREATE INDEX exception_events_key_idx     ON exception_events (exception_key, event_id);
CREATE INDEX exception_events_subject_idx ON exception_events (subject, subject_id);
CREATE INDEX exception_events_at_idx      ON exception_events (at);

CREATE TRIGGER exception_events_append_only
  BEFORE UPDATE OR DELETE ON exception_events
  FOR EACH STATEMENT EXECUTE FUNCTION reject_mutation();

-- ---------------------------------------------------------------------------
-- The queue itself, derived.
--
-- DISTINCT ON takes the newest event per key; `event_id` is a sequence, so "newest" is
-- unambiguous without consulting a clock — the same reasoning as `transaction_states`.
--
-- `raised_at` comes from the first event rather than the latest, because "how long has this
-- been open?" is the question an operator actually asks, and the answer must not reset every
-- time somebody acknowledges it.
-- ---------------------------------------------------------------------------
CREATE VIEW exceptions AS
WITH latest AS (
  SELECT DISTINCT ON (exception_key) *
    FROM exception_events
   ORDER BY exception_key, event_id DESC
),
first_seen AS (
  SELECT exception_key, MIN(at) AS raised_at
    FROM exception_events
   WHERE from_state IS NULL
   GROUP BY exception_key
)
SELECT l.exception_key,
       l.subject,
       l.subject_id,
       l.reason,
       l.to_state AS state,
       l.amount_kobo,
       l.currency,
       l.due_at,
       l.evidence_id,
       l.links,
       l.considered,
       l.actor,
       l.cause,
       l.resolution_key,
       COALESCE(f.raised_at, l.at) AS raised_at,
       l.at   AS since,
       l.event_id
  FROM latest l
  LEFT JOIN first_seen f ON f.exception_key = l.exception_key;
