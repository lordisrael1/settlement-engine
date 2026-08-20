-- The event log: everything that happened, in the order it happened, never edited.
--
-- The tables built so far record the current answers. Each is append-only, so each holds
-- its own history — but none of them holds the history of the *system* as one ordered
-- narrative, which is exactly what "show me everything that happened to this money, in
-- order" needs. Today that question means joining six tables and hoping.
--
-- On what this is and is not. A log-first design would make this the true system of record
-- and the ledger a projection folded from it. Instead this log is written in the **same
-- database transaction** as the state change that causes it, and `replay` folds it and
-- asserts the projections match. It is not the only writer, and deliberately so: inverting
-- the write path would move balance-zero out of the database, where a constraint trigger
-- currently refuses an unbalanced transaction at COMMIT and no rogue script can walk past
-- it, and into application code that merely promises to be right. Two records written
-- together and checked against each other is a stronger position than either alone — a bug
-- in the ledger writer and a bug in the event writer would have to agree exactly to escape
-- notice.

CREATE TABLE events (
  -- The order everything happened in. A sequence, not a timestamp: two events in the same
  -- millisecond still have an order, and clocks move backwards.
  sequence     BIGSERIAL PRIMARY KEY,

  -- Derived from the type and the subject, never generated. A random id would make the same
  -- event replay to a different log (determinism) and would let a retried request append the same
  -- happening twice.
  event_id     TEXT NOT NULL UNIQUE,
  type         TEXT NOT NULL,
  -- What the event is about: a transaction id, a payout reference, an exception key.
  subject      TEXT NOT NULL,
  source       TEXT,

  -- Two dates, because they answer different questions. A payout that moved on Tuesday and
  -- was ingested on Thursday is one event with two dates, and a report that conflates them
  -- attributes Tuesday's money to Thursday.
  occurred_at  TIMESTAMPTZ NOT NULL,
  recorded_at  TIMESTAMPTZ NOT NULL,

  -- What it did to the books: [{account_id, kobo}]. Empty for the events that moved no
  -- value, which is most of them. Kobo as text inside the document, never a JSON number —
  -- a JSON number is a double, and a double is not a ledger amount.
  entries      JSONB NOT NULL DEFAULT '[]',
  -- Everything else worth keeping, in the event's own shape.
  detail       JSONB NOT NULL DEFAULT '{}',
  -- The event this one answers: a booking caused by a match, a resolution caused by an
  -- exception. The audit trail's own edges.
  caused_by    TEXT
);

CREATE INDEX events_subject_idx  ON events (subject, sequence);
CREATE INDEX events_type_idx     ON events (type, sequence);
CREATE INDEX events_occurred_idx ON events (occurred_at);

-- Append-only, at the scale of the whole system. This is the one table where an UPDATE would not
-- merely rewrite a fact but rewrite the record that proves every other fact.
CREATE TRIGGER events_append_only
  BEFORE UPDATE OR DELETE ON events
  FOR EACH STATEMENT EXECUTE FUNCTION reject_mutation();

-- ---------------------------------------------------------------------------
-- Genesis.
--
-- A log that begins today cannot explain a ledger that began last year. Every transaction
-- written before this migration exists in `entries` and nowhere in `events`, so a replay
-- would fold to zero and report every account as drifted — correctly, and uselessly.
--
-- So the log opens with one event carrying the position as it stood at adoption. That is
-- the honest statement: *this* is where the narrative starts, and here is what was already
-- true. It is exactly what an opening balance is in any other set of books.
--
-- On a fresh database there is nothing to carry and no event is written, which is why the
-- WHERE EXISTS is there rather than an empty genesis row that would need explaining later.
INSERT INTO events (event_id, type, subject, occurred_at, recorded_at, entries, detail)
SELECT
  'LedgerOpened' || chr(31) || 'genesis',
  'LedgerOpened',
  'genesis',
  now(),
  now(),
  (SELECT COALESCE(
            jsonb_agg(jsonb_build_object('account_id', account_id, 'kobo', total::text)),
            '[]'::jsonb)
     FROM (SELECT account_id, SUM(amount_kobo) AS total
             FROM entries GROUP BY account_id HAVING SUM(amount_kobo) <> 0) AS opening),
  jsonb_build_object(
    'why', 'balances carried forward from before the event log existed',
    'transactions', (SELECT COUNT(*) FROM ledger_transactions))
WHERE EXISTS (SELECT 1 FROM entries);

-- The same problem, one table over: an exception open at adoption has no raise in the log,
-- so the replay's queue check would call it resolved. Guarded on the reconciler's tables
-- existing at all, because the ledger is usable without that package and a migration that
-- fails on an optional dependency is a migration that blocks a deployment for no reason.
DO $$
BEGIN
  IF to_regclass('exceptions') IS NOT NULL THEN
    INSERT INTO events (event_id, type, subject, occurred_at, recorded_at, detail)
    SELECT 'ExceptionRaised' || chr(31) || exception_key || chr(31) || 'genesis',
           'ExceptionRaised',
           exception_key,
           raised_at,
           raised_at,
           jsonb_build_object('reason', reason, 'why', 'open at adoption of the event log')
      FROM exceptions
     WHERE state <> 'resolved'
    ON CONFLICT (event_id) DO NOTHING;
  END IF;
END
$$;
