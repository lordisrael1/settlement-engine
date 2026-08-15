-- The ledger. Append-only history; balances are derived from it, never stored as truth.
--
-- Laws 1, 2 and 3 are enforced here, in the database, rather than in application code.
-- That is deliberate: a check that lives only in TypeScript is a check that a future
-- migration script, a psql session, or a second service can walk straight past.

-- ---------------------------------------------------------------------------
-- Accounts. Mirrors the chart of accounts in @recon/canon; seeded from it by
-- syncAccounts() so the two can never drift apart silently.
-- ---------------------------------------------------------------------------
CREATE TABLE accounts (
  account_id   TEXT PRIMARY KEY,
  account_type TEXT NOT NULL,
  natural_sign SMALLINT NOT NULL CHECK (natural_sign IN (1, -1)),
  meaning      TEXT NOT NULL
);

-- ---------------------------------------------------------------------------
-- Transactions. The primary key IS the causing event's idempotency key, so Law 4
-- is enforced by the key itself: the same event posted twice collides on INSERT.
-- There is no read-then-write window for concurrent workers to race in.
--
-- Note what is absent: a `state` column. Lifecycle state is derived from the
-- append-only transaction_state_changes table, because a mutable state column
-- would be an UPDATE, and UPDATEs are how history gets quietly rewritten.
-- ---------------------------------------------------------------------------
CREATE TABLE ledger_transactions (
  transaction_id TEXT PRIMARY KEY,
  source         TEXT NOT NULL,
  reference      TEXT NOT NULL,
  -- When it happened in the world. Drives settlement windows.
  occurred_at    TIMESTAMPTZ NOT NULL,
  -- When we learned of it. Never used to derive a number (Law 5).
  recorded_at    TIMESTAMPTZ NOT NULL
);

CREATE INDEX ledger_transactions_source_reference_idx
  ON ledger_transactions (source, reference);
CREATE INDEX ledger_transactions_occurred_at_idx
  ON ledger_transactions (occurred_at);

-- ---------------------------------------------------------------------------
-- Entries. Money is BIGINT kobo (Law 3) — never NUMERIC, never DOUBLE PRECISION.
-- `amount_kobo` is signed: positive debits the account, negative credits it.
-- ---------------------------------------------------------------------------
CREATE TABLE entries (
  entry_id       TEXT PRIMARY KEY,
  transaction_id TEXT NOT NULL REFERENCES ledger_transactions (transaction_id),
  ordinal        INT  NOT NULL,
  account_id     TEXT NOT NULL REFERENCES accounts (account_id),
  amount_kobo    BIGINT NOT NULL,
  currency       TEXT NOT NULL,
  UNIQUE (transaction_id, ordinal)
);

CREATE INDEX entries_account_id_idx     ON entries (account_id);
CREATE INDEX entries_transaction_id_idx ON entries (transaction_id);

-- ---------------------------------------------------------------------------
-- Law 1 — balance-zero, enforced as a DEFERRED constraint trigger.
--
-- Deferred, not immediate: a transaction's entries are inserted row by row, so
-- an immediate check would fire on the first row and reject every balanced
-- transaction ever written. Deferring to COMMIT means the check sees the whole
-- set — and because it runs inside the committing transaction, an unbalanced
-- transaction cannot be persisted even under concurrency.
-- ---------------------------------------------------------------------------
CREATE FUNCTION assert_transaction_balances() RETURNS TRIGGER AS $$
DECLARE
  total          BIGINT;
  currency_count INT;
BEGIN
  SELECT COALESCE(SUM(amount_kobo), 0), COUNT(DISTINCT currency)
    INTO total, currency_count
    FROM entries
   WHERE transaction_id = NEW.transaction_id;

  IF total <> 0 THEN
    RAISE EXCEPTION
      'LAW_1_VIOLATION: transaction % entries sum to % kobo, not zero',
      NEW.transaction_id, total
      USING ERRCODE = 'check_violation';
  END IF;

  -- Summing across currencies would produce a number that means nothing, and
  -- would let a mixed-currency transaction "balance" by coincidence.
  IF currency_count > 1 THEN
    RAISE EXCEPTION
      'LAW_1_VIOLATION: transaction % mixes % currencies in one transaction',
      NEW.transaction_id, currency_count
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER entries_must_balance
  AFTER INSERT ON entries
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION assert_transaction_balances();

-- ---------------------------------------------------------------------------
-- Lifecycle. Transitions are appended; the current state is the newest row.
-- The initial state is recorded as a change from NULL.
-- ---------------------------------------------------------------------------
CREATE TABLE transaction_state_changes (
  change_id      BIGSERIAL PRIMARY KEY,
  transaction_id TEXT NOT NULL REFERENCES ledger_transactions (transaction_id),
  from_state     TEXT,
  to_state       TEXT NOT NULL,
  at             TIMESTAMPTZ NOT NULL,
  -- The transaction that caused the change: a settlement booking, a reversal.
  caused_by      TEXT REFERENCES ledger_transactions (transaction_id)
);

CREATE INDEX transaction_state_changes_transaction_id_idx
  ON transaction_state_changes (transaction_id);

-- Current state, derived. DISTINCT ON takes the newest change per transaction;
-- change_id is a sequence, so "newest" is unambiguous without consulting a clock.
CREATE VIEW transaction_states AS
SELECT DISTINCT ON (transaction_id)
       transaction_id,
       to_state AS state,
       at       AS since,
       change_id
  FROM transaction_state_changes
 ORDER BY transaction_id, change_id DESC;

-- ---------------------------------------------------------------------------
-- Law 2 — append-only. Correct a mistake with a compensating transaction.
--
-- account_balances is deliberately NOT protected: it is a cache, and a cache
-- that cannot be updated is not a cache. Law 6 is what keeps it honest.
-- ---------------------------------------------------------------------------
CREATE FUNCTION reject_mutation() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION
    'LAW_2_VIOLATION: % is append-only; correct it with a compensating transaction',
    TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER ledger_transactions_append_only
  BEFORE UPDATE OR DELETE ON ledger_transactions
  FOR EACH STATEMENT EXECUTE FUNCTION reject_mutation();

CREATE TRIGGER entries_append_only
  BEFORE UPDATE OR DELETE ON entries
  FOR EACH STATEMENT EXECUTE FUNCTION reject_mutation();

CREATE TRIGGER transaction_state_changes_append_only
  BEFORE UPDATE OR DELETE ON transaction_state_changes
  FOR EACH STATEMENT EXECUTE FUNCTION reject_mutation();

-- ---------------------------------------------------------------------------
-- The balance cache. A convenience, never a truth: every value here must equal
-- SUM(entries) for its account, and Law 6 asserts exactly that. When they
-- disagree, the entries win and this table is wrong by definition.
-- ---------------------------------------------------------------------------
CREATE TABLE account_balances (
  account_id   TEXT PRIMARY KEY REFERENCES accounts (account_id),
  balance_kobo BIGINT NOT NULL,
  currency     TEXT   NOT NULL
);
