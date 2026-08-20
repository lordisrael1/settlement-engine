-- Four things the three-way model asserted and this schema could not yet record.
--
--   a fee contract is scoped to a channel and a currency, not just a merchant and a source
--   a canonical record traces to a *row* of a file, not merely to the file
--   an allocation carries its share of the deductions, not only its share of the gross
--   a human resolution has a key, a value, an approver who is not the maker, and a booking
--
-- 0002 is history and is not edited. Everything below is additive: new columns, new
-- constraints, and one exclusion constraint replaced because its scope genuinely changed.

-- ---------------------------------------------------------------------------
-- Evidence: where the bytes live when they no longer live here.
--
-- A statement can run to hundreds of megabytes and a retention policy eventually says
-- delete the payload and keep the record. When `raw` is truncated, this is the only thing
-- between a hash and an unanswerable question. It is a locator recorded at ingest — never a
-- promise that the object is still there, which is why nothing reads it to decide anything.
-- ---------------------------------------------------------------------------
ALTER TABLE evidence
  ADD COLUMN storage_location TEXT;

-- ---------------------------------------------------------------------------
-- Row-level lineage.
--
-- "Which file?" was answerable; "which line of it?" was not. In a five-thousand-row export
-- those are different questions, and only the second one lets somebody reproduce a
-- conclusion. `source_row_number` is the zero-based index as parsed; `source_path` is a
-- locator in the artifact's own idiom — `$[3]`, `$.data[3]`, `row:17`.
--
-- Nullable because a record ingested before this existed genuinely does not know, and
-- backfilling a guess into an append-only table is worse than admitting the gap.
-- ---------------------------------------------------------------------------
ALTER TABLE payouts
  ADD COLUMN source_row_number INT,
  ADD COLUMN source_path       TEXT;

ALTER TABLE settlement_lines
  ADD COLUMN source_row_number INT,
  ADD COLUMN source_path       TEXT,
  -- The rail, as a typed field. It was previously present only inside `reason_hints`,
  -- where reading it to price a fee would have meant parsing narration to make a decision —
  -- exactly what ADR-0010 forbids.
  ADD COLUMN channel           TEXT;

ALTER TABLE bank_statement_lines
  ADD COLUMN source_row_number INT,
  ADD COLUMN source_path       TEXT;

-- ---------------------------------------------------------------------------
-- Fee contracts, scoped by channel and currency.
--
-- A single rate per merchant and source means every non-card payment develops a permanent
-- variance against a price that was never quoted for it — the exact false-alert machine a
-- fee model exists to prevent. Card is not transfer; NGN is not USD.
--
-- `channel = '*'` is a contract covering every channel: a merchant genuinely on one blended
-- rate. It is a value rather than a NULL because NULL-means-wildcard is a rule that reads as
-- a bug the first time somebody adds a channel-specific contract beside it, and because an
-- exclusion constraint cannot express "overlaps unless one side is a wildcard" anyway.
--
-- So the constraint forbids overlap *within* a scope, and the one deliberate overlap
-- between scopes — a specific channel beside '*' — is resolved in exactly one place, by
-- `contractAt` in @recon/canon, in favour of the more specific.
-- ---------------------------------------------------------------------------
ALTER TABLE fee_contracts
  ADD COLUMN channel  TEXT NOT NULL DEFAULT '*',
  ADD COLUMN currency TEXT NOT NULL DEFAULT 'NGN';

-- The default existed to fill the rows already here. Leaving it would let a future insert
-- silently create a blended contract when it meant to create a card one.
ALTER TABLE fee_contracts
  ALTER COLUMN channel  DROP DEFAULT,
  ALTER COLUMN currency DROP DEFAULT;

ALTER TABLE fee_contracts
  ADD CONSTRAINT fee_contracts_known_channel CHECK (
    channel IN ('*', 'card', 'bank_transfer', 'ussd', 'qr', 'wallet', 'pos', 'unknown')
  );

ALTER TABLE fee_contracts
  DROP CONSTRAINT fee_contracts_no_overlap;

ALTER TABLE fee_contracts
  ADD CONSTRAINT fee_contracts_no_overlap EXCLUDE USING gist (
    source      WITH =,
    merchant_id WITH =,
    channel     WITH =,
    currency    WITH =,
    tstzrange(effective_from, effective_to) WITH &&
  );

-- ---------------------------------------------------------------------------
-- Which contract explained which decision.
--
-- A fee model is administered data that changes. Recomputing a March decision against
-- today's contract table can therefore reach a different answer than the one we acted on,
-- which would make the decision unreproducible in precisely the way the effective dating
-- was meant to prevent. So the contract that priced it is written down at the moment it
-- prices it: [{transaction_id, contract_id, channel, expected_fee, expected_vat, observed_fee}].
--
-- Kobo as text inside the document, never a JSON number — a JSON number is a double.
-- ---------------------------------------------------------------------------
ALTER TABLE matches
  ADD COLUMN fee_explanations JSONB NOT NULL DEFAULT '[]';

-- ---------------------------------------------------------------------------
-- Per-allocation apportionment.
--
-- Allocating gross alone answers "which receivable did this payout close?" but not "what
-- did this payment cost?" — and one batch fee across forty payments is the ordinary case,
-- not an exotic one. Per-payment margin, per-merchant profitability and any fee dispute all
-- need the second answer, and computing it later from a stored gross is not the same thing:
-- the deductions may have been apportioned under a rule that has since changed.
--
-- The rule is largest-remainder pro rata by gross allocated, applied per account, with ties
-- broken by transaction id. It is exact-sum by construction — the apportioned shares add
-- back to the total to the kobo, which is why this may be stored rather than recomputed.
-- ---------------------------------------------------------------------------
ALTER TABLE inflow_allocations
  -- What this payment contributes to the expected credit: gross allocated less its share.
  ADD COLUMN net_kobo   BIGINT,
  -- [{account_id, kobo}] — this payment's share of each named deduction.
  ADD COLUMN deductions JSONB NOT NULL DEFAULT '[]';

-- ---------------------------------------------------------------------------
-- Resolutions: a key, a value, an approver who is not the maker, and a booking.
--
-- `resolution_key` makes a retried request append one decision rather than two (idempotency), and
-- is the identity of the compensating transaction the decision posts. Backfilled for any
-- row written before it existed, because those decisions really were distinct.
-- ---------------------------------------------------------------------------
ALTER TABLE resolutions
  ADD COLUMN resolution_key        TEXT,
  ADD COLUMN amount_kobo           BIGINT,
  ADD COLUMN currency              TEXT,
  ADD COLUMN booked_transaction_id TEXT REFERENCES ledger_transactions (transaction_id);

-- The append-only trigger is statement-level, so it refuses this backfill even when there are no
-- rows to back-fill. Lifting it here is not an exception to the law: a migration is the one
-- place the *shape* of history may change, it runs inside a transaction so no other session
-- ever sees the table unguarded, and the trigger goes straight back on below. The
-- alternative — leaving the column nullable forever — would make `resolution_key` a field
-- the application has to remember rather than one the database guarantees.
DROP TRIGGER resolutions_append_only ON resolutions;

UPDATE resolutions SET resolution_key = 'legacy:' || resolution_id WHERE resolution_key IS NULL;

ALTER TABLE resolutions
  ALTER COLUMN resolution_key SET NOT NULL,
  ADD CONSTRAINT resolutions_key_unique UNIQUE (resolution_key),
  ADD CONSTRAINT resolutions_amount_complete
    CHECK ((amount_kobo IS NULL) = (currency IS NULL)),
  -- A resolution states what a decision is worth. Direction belongs in the compensating
  -- entries; a negative "worth" would let a large write-off be recorded as a small one.
  ADD CONSTRAINT resolutions_amount_non_negative
    CHECK (amount_kobo IS NULL OR amount_kobo >= 0),
  -- Maker-checker, in the database. An approver who is the maker is not oversight, it is a
  -- field being filled in — and a control enforced only in application code is one refactor
  -- away from not existing.
  ADD CONSTRAINT resolutions_no_self_approval
    CHECK (approved_by IS NULL OR approved_by <> resolved_by);

CREATE TRIGGER resolutions_append_only
  BEFORE UPDATE OR DELETE ON resolutions
  FOR EACH STATEMENT EXECUTE FUNCTION reject_mutation();

CREATE INDEX resolutions_booked_idx ON resolutions (booked_transaction_id)
  WHERE booked_transaction_id IS NOT NULL;
