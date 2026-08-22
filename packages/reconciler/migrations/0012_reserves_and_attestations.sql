-- Two things the books could hold indefinitely without anybody noticing.
--
-- Both are absences rather than errors, which is why neither had a home. Every other record
-- in this schema exists because something *happened*; these exist because something did not.

-- ---------------------------------------------------------------------------
-- Rolling reserves: our money, in somebody else's account, with a date on it.
--
-- `psp_reserve` is an asset, and correctly so — a reserve is withheld, not kept. But an
-- asset with no deadline attached is indistinguishable from an asset that is merely not back
-- yet, forever. A PSP that holds 5% of every payout for ninety days and then quietly holds it
-- for two hundred produces no exception, no variance, and no shortfall: the balance simply
-- sits there, growing, looking exactly like a healthy reserve position. That is money not
-- being chased, and nothing in the system was in a position to say so (ADR-0071).
--
-- What makes it tractable is that the PSP already tells us. A `reserve` adjustment on a
-- payout is a withholding and a `reserve_release` is a return, both itemised in the file, and
-- the only missing piece was a deadline — which is policy, per source, and arrives with the
-- rest of the source's policy rather than being guessed at here.
-- ---------------------------------------------------------------------------
CREATE TABLE reserve_holds (
  -- The inflow the reserve was withheld from. One movement withholds at most one net
  -- reserve, so this is the natural key and a re-run collides on it rather than doubling
  -- the position (idempotency).
  inflow_key      TEXT PRIMARY KEY,
  source          TEXT        NOT NULL,

  withheld_kobo   BIGINT      NOT NULL CHECK (withheld_kobo > 0),
  currency        TEXT        NOT NULL DEFAULT 'NGN',

  -- When the money was actually withheld: the value date of the bank credit that confirmed
  -- the payout, not the moment this row was written. A reserve's clock starts when the
  -- shortened payout lands, and dating it to the reconciliation run would restart every
  -- reserve's clock on the day somebody happened to re-import a file.
  withheld_at     TIMESTAMPTZ NOT NULL,
  -- When the source undertook to return it. NULL for a source with no declared reserve
  -- schedule — an honest "we were never told", which is a different fact from "it is not due
  -- yet" and is reported as one rather than being silently treated as either.
  due_at          TIMESTAMPTZ,

  -- The bank credit that proves the withholding happened, and the file it came from.
  confirmed_by    TEXT        NOT NULL,
  evidence_id     TEXT        REFERENCES evidence (evidence_id)
);

CREATE INDEX reserve_holds_due_idx ON reserve_holds (due_at NULLS LAST, inflow_key);

-- Releases are appended, never subtracted from the hold.
--
-- The alternative — a `released_kobo` column the reconciler decrements — is an UPDATE, and
-- the position it produces cannot be explained: "₦40,000 of ₦100,000 is back" says nothing
-- about which payouts carried it or when. This says all of it, and the position below is
-- derived, so the two can never disagree.
--
-- A release names no particular withholding: the PSP simply reports a `reserve_release` on
-- some later payout. So it is applied oldest-first, which is both the convention every
-- rolling-reserve schedule actually follows and the only allocation that does not require
-- guessing.
CREATE TABLE reserve_releases (
  release_id      BIGSERIAL   PRIMARY KEY,
  inflow_key      TEXT        NOT NULL REFERENCES reserve_holds (inflow_key),
  -- The inflow whose file carried the release.
  released_by     TEXT        NOT NULL,
  amount_kobo     BIGINT      NOT NULL CHECK (amount_kobo > 0),
  at              TIMESTAMPTZ NOT NULL,

  -- One payout releases against one hold at most once. A re-run of the same reconciliation
  -- collides here rather than releasing the reserve twice.
  UNIQUE (inflow_key, released_by)
);

CREATE TRIGGER reserve_releases_append_only
  BEFORE UPDATE OR DELETE ON reserve_releases
  FOR EACH STATEMENT EXECUTE FUNCTION reject_mutation();

-- What is still out there, derived from the two tables above and never stored.
CREATE VIEW reserve_positions AS
SELECT h.inflow_key,
       h.source,
       h.withheld_kobo,
       h.currency,
       h.withheld_at,
       h.due_at,
       h.confirmed_by,
       h.evidence_id,
       COALESCE(SUM(r.amount_kobo), 0)                     AS released_kobo,
       h.withheld_kobo - COALESCE(SUM(r.amount_kobo), 0)   AS outstanding_kobo
  FROM reserve_holds h
  LEFT JOIN reserve_releases r ON r.inflow_key = h.inflow_key
 GROUP BY h.inflow_key, h.source, h.withheld_kobo, h.currency, h.withheld_at, h.due_at,
          h.confirmed_by, h.evidence_id;

-- ---------------------------------------------------------------------------
-- The trust boundary, written down.
--
-- This system's cash booking rests entirely on an uploaded file. `POST /ingest/bank` is
-- behind an API key, and that is the whole of the control: anyone holding an ingest key can
-- produce a "bank statement" that confirms inflows and moves `psp_receivable` into
-- `bank_account`. There is no signature on the bytes, no feed from the bank, and no
-- independent check that the file came from anywhere in particular.
--
-- `verify` does not catch it and cannot. It proves the books are *internally* consistent —
-- every transaction balances, the entries sum to zero, the cache agrees with the entries —
-- and a fabricated statement that balances passes all of it trivially. Internal consistency
-- and agreement with reality are different claims, and only the first was ever enforced
-- (ADR-0068).
--
-- Until the open-banking feed on the roadmap exists, the honest control is out-of-band: a
-- person opens the bank's own portal, reads the balance, and compares it to ours. That is a
-- real control and it was entirely undocumented, which means in practice it was not
-- happening. This makes it a record — with a name attached, a difference computed, and a
-- staleness anybody can query — so that "when did somebody last check the books against the
-- bank?" has an answer that is not a shrug.
-- ---------------------------------------------------------------------------
CREATE TABLE bank_attestations (
  attestation_id      BIGSERIAL   PRIMARY KEY,
  bank_account_id     TEXT        NOT NULL,

  -- The moment the person read the portal, not the moment they typed it in. A balance read
  -- at 09:00 and recorded at 11:00 is a statement about 09:00.
  as_of               TIMESTAMPTZ NOT NULL,
  -- What the bank's own portal said.
  portal_balance_kobo BIGINT      NOT NULL,
  -- What our books said at the same moment, computed from `entries` rather than the cache:
  -- an attestation against a cache would be checking one of our own projections against the
  -- bank, which is a weaker claim than the one being made.
  ledger_balance_kobo BIGINT      NOT NULL,
  difference_kobo     BIGINT      NOT NULL,
  currency            TEXT        NOT NULL DEFAULT 'NGN',

  -- A person. Not a service account, not a role — the same standard `resolutions` holds,
  -- because this is the same kind of act: a human asserting something the machine cannot.
  attested_by         TEXT        NOT NULL,
  -- What explains the difference, where there is one. Almost always there is: the bank
  -- account holds movements this system never models — outgoing supplier payments, salaries,
  -- a standing order — so a non-zero difference is expected and an *unexplained* one is the
  -- finding. Free text, because the explanation is a sentence about the business.
  note                TEXT,
  recorded_at         TIMESTAMPTZ NOT NULL,

  CONSTRAINT bank_attestations_difference_is_arithmetic
    CHECK (difference_kobo = portal_balance_kobo - ledger_balance_kobo)
);

CREATE INDEX bank_attestations_account_idx
  ON bank_attestations (bank_account_id, as_of DESC);

-- Append-only, like every other assertion a human makes in this schema. An attestation that
-- can be edited afterwards is not evidence that somebody checked; it is evidence that
-- somebody has a row.
CREATE TRIGGER bank_attestations_append_only
  BEFORE UPDATE OR DELETE ON bank_attestations
  FOR EACH STATEMENT EXECUTE FUNCTION reject_mutation();
