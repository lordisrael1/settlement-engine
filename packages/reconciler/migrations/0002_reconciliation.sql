-- Reconciliation: three records, and the trail that proves what we did with them.
--
-- The ledger (0001) holds the promise. This holds the other two — what the PSP said it
-- would send, and what the bank says arrived — plus the evidence both came from and the
-- record of every conclusion drawn, by a machine or by a person.
--
-- The ingest layer deliberately leaves settlement records nowhere to live: it has no database
-- (ADR-0020). This is the right place, and their arrival here is what makes idempotency
-- durable across restarts rather than only within a run.

-- btree_gist lets an exclusion constraint mix equality on text with overlap on a range,
-- which is what "one merchant, one source, no two contracts in force at once" requires.
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- ---------------------------------------------------------------------------
-- Evidence. Every canonical record traces to bytes somebody can produce.
--
-- The key is the SHA-256 of the file, so re-uploading it is a no-op by construction and
-- "is this the file you used?" is answerable by anyone holding the file. `parser_version`
-- is here because the parser is part of the reasoning: when an adapter is corrected, every
-- conclusion the old one reached is suspect, and findable.
-- ---------------------------------------------------------------------------
CREATE TABLE evidence (
  evidence_id    TEXT PRIMARY KEY,
  kind           TEXT NOT NULL CHECK (kind IN ('psp_settlement', 'bank_statement', 'webhook')),
  source         TEXT NOT NULL,
  filename       TEXT,
  byte_length    INT  NOT NULL CHECK (byte_length >= 0),
  -- Who or what put this in front of us: an operator, a cron job, an API client.
  received_from  TEXT NOT NULL,
  received_at    TIMESTAMPTZ NOT NULL,
  parser_version TEXT NOT NULL,
  -- The bytes themselves. Retaining them is what makes a reconciliation reproducible
  -- rather than merely recorded; a deployment with retention limits truncates this column
  -- on a schedule and keeps the hash forever.
  raw            BYTEA
);

CREATE INDEX evidence_received_at_idx ON evidence (received_at);

-- ---------------------------------------------------------------------------
-- Fee contracts. Versioned, per merchant, per source, with an approver.
--
-- Half-open ranges: [effective_from, effective_to). The instant one contract ends is the
-- instant its successor begins, so no payment falls in a gap or is priced twice — and the
-- exclusion constraint makes overlapping contracts impossible rather than merely
-- discouraged. Historical reconciliation stays correct after a renegotiation because
-- March is priced by March's contract, forever.
-- ---------------------------------------------------------------------------
CREATE TABLE fee_contracts (
  contract_id     TEXT PRIMARY KEY,
  source          TEXT NOT NULL,
  merchant_id     TEXT NOT NULL,
  effective_from  TIMESTAMPTZ NOT NULL,
  effective_to    TIMESTAMPTZ,

  percent_bp      INT    NOT NULL CHECK (percent_bp >= 0),
  flat_kobo       BIGINT NOT NULL CHECK (flat_kobo >= 0),
  flat_waived_below_kobo BIGINT CHECK (flat_waived_below_kobo IS NULL OR flat_waived_below_kobo >= 0),
  cap_kobo        BIGINT CHECK (cap_kobo IS NULL OR cap_kobo >= 0),
  vat_bp          INT    NOT NULL CHECK (vat_bp >= 0),

  -- A rate is an assertion somebody approved. "Why did we expect 1.4%?" has an answer.
  approved_by     TEXT NOT NULL,
  approved_at     TIMESTAMPTZ NOT NULL,

  CONSTRAINT fee_contracts_ordered CHECK (effective_to IS NULL OR effective_to > effective_from),
  CONSTRAINT fee_contracts_no_overlap EXCLUDE USING gist (
    source      WITH =,
    merchant_id WITH =,
    tstzrange(effective_from, effective_to) WITH &&
  )
);

-- ---------------------------------------------------------------------------
-- Record two, first half: what the PSP says it is sending.
--
-- `status` starts at `reported` and only a bank statement moves it on. Nothing in this
-- table is money.
-- ---------------------------------------------------------------------------
CREATE TABLE payouts (
  idempotency_key   TEXT PRIMARY KEY,
  payout_reference  TEXT NOT NULL,
  source            TEXT NOT NULL,
  status            TEXT NOT NULL CHECK (status IN ('reported', 'confirmed', 'returned')),

  gross_kobo        BIGINT NOT NULL,
  expected_net_kobo BIGINT NOT NULL,
  currency          TEXT   NOT NULL,
  -- Named deductions: [{kind, kobo, narration}]. Kobo as text inside the document, never
  -- a JSON number: a JSON number is a double, and a double is not a ledger amount.
  adjustments       JSONB  NOT NULL DEFAULT '[]',

  reported_at       TIMESTAMPTZ NOT NULL,
  value_date        TIMESTAMPTZ,
  evidence_id       TEXT NOT NULL REFERENCES evidence (evidence_id),

  UNIQUE (source, payout_reference)
);

CREATE INDEX payouts_status_idx     ON payouts (status);
CREATE INDEX payouts_value_date_idx ON payouts (value_date);

-- ---------------------------------------------------------------------------
-- Record two, second half: individual settled payments, for sources that list them
-- instead of naming the movement that carries them.
-- ---------------------------------------------------------------------------
CREATE TABLE settlement_lines (
  idempotency_key  TEXT PRIMARY KEY,
  source           TEXT NOT NULL,
  reference        TEXT NOT NULL,
  -- NULL where the source never says which movement carries this payment. That absence is
  -- why derived inflows exist, and why they are labelled as inferred.
  payout_reference TEXT,
  merchant_id      TEXT NOT NULL,

  gross_kobo       BIGINT NOT NULL,
  fee_kobo         BIGINT NOT NULL,
  net_kobo         BIGINT NOT NULL,
  currency         TEXT   NOT NULL,

  status           TEXT NOT NULL CHECK (status IN ('settled', 'reversed', 'chargeback')),
  settled_at       TIMESTAMPTZ,
  reason_hints     TEXT[] NOT NULL DEFAULT '{}',
  evidence_id      TEXT NOT NULL REFERENCES evidence (evidence_id),

  -- A line that lies about its own arithmetic is not something to reconcile against.
  CONSTRAINT settlement_lines_self_consistent CHECK (gross_kobo - fee_kobo = net_kobo),
  CONSTRAINT settlement_lines_fee_non_negative CHECK (fee_kobo >= 0)
);

CREATE INDEX settlement_lines_source_reference_idx ON settlement_lines (source, reference);
CREATE INDEX settlement_lines_payout_idx           ON settlement_lines (payout_reference);

-- ---------------------------------------------------------------------------
-- Record three: the bank. The only table in the database that proves anything.
--
-- Debits are stored, not filtered: a returned payout and a chargeback both arrive as
-- debits, and dropping them would make the two most alarming bank events invisible.
-- ---------------------------------------------------------------------------
CREATE TABLE bank_statement_lines (
  idempotency_key  TEXT PRIMARY KEY,
  bank_account_id  TEXT NOT NULL,
  reference        TEXT NOT NULL,
  direction        TEXT NOT NULL CHECK (direction IN ('credit', 'debit')),
  amount_kobo      BIGINT NOT NULL CHECK (amount_kobo >= 0),
  balance_after_kobo BIGINT,
  currency         TEXT NOT NULL,
  value_date       TIMESTAMPTZ NOT NULL,
  narration        TEXT NOT NULL,
  -- Candidates the parser saw, never a conclusion it drew. The matcher resolves these
  -- against payouts it actually holds.
  narration_tokens TEXT[] NOT NULL DEFAULT '{}',
  stated_reference TEXT,
  evidence_id      TEXT NOT NULL REFERENCES evidence (evidence_id)
);

CREATE INDEX bank_statement_lines_value_date_idx ON bank_statement_lines (value_date);
CREATE INDEX bank_statement_lines_amount_idx     ON bank_statement_lines (amount_kobo);

-- ---------------------------------------------------------------------------
-- What stage two concluded: money we have been told to expect, and are waiting on.
--
-- This is the table that did not exist in the two-way design, and its absence was the
-- whole problem: "the PSP says it paid, the bank has not seen it" had nowhere to sit that
-- was neither matched nor missing.
-- ---------------------------------------------------------------------------
CREATE TABLE expected_inflows (
  inflow_key        TEXT PRIMARY KEY,
  source            TEXT NOT NULL,
  -- FALSE when a PSP named this movement; TRUE when we grouped it ourselves. A human
  -- reading an exception deserves to know which of those they are looking at.
  derived           BOOLEAN NOT NULL,

  gross_kobo        BIGINT NOT NULL,
  expected_net_kobo BIGINT NOT NULL,
  currency          TEXT   NOT NULL,
  -- [{account_id, kobo}], already collapsed to one entry per account.
  deductions        JSONB  NOT NULL DEFAULT '[]',

  value_date        TIMESTAMPTZ,
  evidence_id       TEXT NOT NULL REFERENCES evidence (evidence_id),
  reported_at       TIMESTAMPTZ NOT NULL,

  -- Set when a bank credit confirms it. NULL means still awaiting the bank.
  confirmed_by      TEXT REFERENCES bank_statement_lines (idempotency_key),
  confirmed_at      TIMESTAMPTZ,
  CONSTRAINT expected_inflows_confirmation_complete
    CHECK ((confirmed_by IS NULL) = (confirmed_at IS NULL))
);

CREATE INDEX expected_inflows_open_idx ON expected_inflows (source) WHERE confirmed_by IS NULL;

-- One bank credit confirms at most one inflow. Without this, a duplicated statement row
-- could confirm two different payouts and book the same cash twice.
CREATE UNIQUE INDEX expected_inflows_one_credit_each
  ON expected_inflows (confirmed_by) WHERE confirmed_by IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Which receivables an inflow closes, and by how much.
--
-- An amount, not a flag. A PSP can settle one payment across two payouts, and one payout
-- covers many payments — modelling the link as a quantity is what lets both be true at
-- once, and what lets a payment be *partly* settled instead of being called a mismatch.
-- ---------------------------------------------------------------------------
CREATE TABLE inflow_allocations (
  inflow_key     TEXT   NOT NULL REFERENCES expected_inflows (inflow_key),
  transaction_id TEXT   NOT NULL REFERENCES ledger_transactions (transaction_id),
  amount_kobo    BIGINT NOT NULL CHECK (amount_kobo > 0),
  PRIMARY KEY (inflow_key, transaction_id)
);

CREATE INDEX inflow_allocations_transaction_idx ON inflow_allocations (transaction_id);

-- The invariant that keeps allocation honest: a payment may never be allocated for more
-- than it was worth. Without it, two payouts could each claim the whole of one payment and
-- the ledger would discharge the same receivable twice.
CREATE FUNCTION assert_allocation_within_receivable() RETURNS TRIGGER AS $$
DECLARE
  receivable BIGINT;
  allocated  BIGINT;
BEGIN
  SELECT COALESCE(SUM(amount_kobo), 0) INTO receivable
    FROM entries
   WHERE transaction_id = NEW.transaction_id AND account_id = 'psp_receivable';

  SELECT COALESCE(SUM(amount_kobo), 0) INTO allocated
    FROM inflow_allocations
   WHERE transaction_id = NEW.transaction_id;

  IF allocated > receivable THEN
    RAISE EXCEPTION
      'OVER_ALLOCATION: transaction % is worth % kobo but % kobo has been allocated',
      NEW.transaction_id, receivable, allocated
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER inflow_allocations_within_receivable
  AFTER INSERT ON inflow_allocations
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION assert_allocation_within_receivable();

-- ---------------------------------------------------------------------------
-- Every conclusion the matcher reached, whether or not it moved money.
--
-- `booked_transaction_id` is NULL for the great majority: a payout match, a deferral and
-- an exception are all real conclusions that book nothing. Only a bank-confirmed inflow
-- has a transaction beside it, and the foreign key says so.
-- ---------------------------------------------------------------------------
CREATE TABLE matches (
  match_id       TEXT PRIMARY KEY,
  reason         TEXT NOT NULL,
  confidence     NUMERIC NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  -- The four link lists, as they were concluded.
  links          JSONB NOT NULL,
  booked_transaction_id TEXT REFERENCES ledger_transactions (transaction_id),
  at             TIMESTAMPTZ NOT NULL
);

CREATE INDEX matches_reason_idx ON matches (reason);

-- ---------------------------------------------------------------------------
-- Human resolutions. Appended, never applied in place.
--
-- A reviewer does not edit a match, change an amount or clear an exception — they add a
-- statement of what they concluded, who they are, when, why, and what they were looking
-- at. A wrong human decision is corrected by a second resolution, not by deleting the
-- first: both stay visible, and so does the fact that somebody changed their mind.
-- ---------------------------------------------------------------------------
CREATE TABLE resolutions (
  resolution_id BIGSERIAL PRIMARY KEY,
  subject       TEXT NOT NULL
                CHECK (subject IN ('payout', 'bank_credit', 'transaction', 'settlement_line')),
  subject_id    TEXT NOT NULL,
  action        TEXT NOT NULL,
  reason        TEXT NOT NULL,
  -- The identity of a person. Not a role, not a service account.
  resolved_by   TEXT NOT NULL,
  resolved_at   TIMESTAMPTZ NOT NULL,
  evidence_id   TEXT REFERENCES evidence (evidence_id),
  approved_by   TEXT,
  approved_at   TIMESTAMPTZ,
  CONSTRAINT resolutions_approval_complete
    CHECK ((approved_by IS NULL) = (approved_at IS NULL))
);

CREATE INDEX resolutions_subject_idx ON resolutions (subject, subject_id);

-- ---------------------------------------------------------------------------
-- Append-only, extended from the ledger to the judgements made about it.
--
-- `expected_inflows` is deliberately absent: confirmation sets `confirmed_by` once, and a
-- partial unique index already makes a second confirmation impossible. Everything else
-- here is history.
-- ---------------------------------------------------------------------------
CREATE TRIGGER evidence_append_only
  BEFORE UPDATE OR DELETE ON evidence
  FOR EACH STATEMENT EXECUTE FUNCTION reject_mutation();

CREATE TRIGGER payouts_append_only
  BEFORE DELETE ON payouts
  FOR EACH STATEMENT EXECUTE FUNCTION reject_mutation();

CREATE TRIGGER settlement_lines_append_only
  BEFORE UPDATE OR DELETE ON settlement_lines
  FOR EACH STATEMENT EXECUTE FUNCTION reject_mutation();

CREATE TRIGGER bank_statement_lines_append_only
  BEFORE UPDATE OR DELETE ON bank_statement_lines
  FOR EACH STATEMENT EXECUTE FUNCTION reject_mutation();

CREATE TRIGGER matches_append_only
  BEFORE UPDATE OR DELETE ON matches
  FOR EACH STATEMENT EXECUTE FUNCTION reject_mutation();

CREATE TRIGGER inflow_allocations_append_only
  BEFORE UPDATE OR DELETE ON inflow_allocations
  FOR EACH STATEMENT EXECUTE FUNCTION reject_mutation();

CREATE TRIGGER resolutions_append_only
  BEFORE UPDATE OR DELETE ON resolutions
  FOR EACH STATEMENT EXECUTE FUNCTION reject_mutation();
