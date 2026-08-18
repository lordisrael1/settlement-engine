-- The inbox: what a provider told us, kept before anybody worked out what it meant.
--
-- Every other table in this system holds a *conclusion* — a promise, a claim, a proof, a
-- judgement. This one holds an obligation. A PSP has handed us bytes over HTTP and is
-- waiting, with a retry timer running, for us to say we have them. Nothing about that
-- moment should depend on the ledger being reachable, on the reconciler being idle, or on
-- a settlement file being parsed: the only promise worth making to the caller is
-- "we safely received this event", and the only way to keep it is to write the bytes down
-- and answer.
--
-- Two consequences shape the columns below.
--
--   **The identity is the bytes.** `delivery_id` is SHA-256 over the source and the raw
--   body, so a redelivery — which providers guarantee, not merely risk — collides on the
--   primary key rather than on anybody remembering (Law 4, at the door). It is derivable by
--   anyone holding the same bytes, exactly as an evidence id is (D-033), and it needs no
--   parsing to compute: at the moment of acceptance we have verified the signature and
--   deliberately not yet run a parser over a stranger's bytes.
--
--   **This is a work queue, and work queues change.** `state`, `attempts` and `last_error`
--   are updated as the delivery is worked, so this table carries no append-only trigger.
--   That is the same exemption `account_balances` has and for the same reason: a cache, or
--   a queue, that cannot be updated is not one. What must never change is the evidence
--   half — `source`, `headers`, `raw`, `received_at` — and nothing in the code writes them
--   after the insert. The financial record remains append-only where it belongs: in
--   `entries`, which is where this delivery ends up if it means anything.

CREATE TABLE webhook_inbox (
  -- SHA-256 of source ‖ raw body. Content-addressed, so the same delivery twice is one row.
  delivery_id   TEXT PRIMARY KEY,
  source        TEXT        NOT NULL,

  -- Kept because a signature is computed over them and over the body together, so a
  -- verification that cannot be reproduced later is a verification nobody can audit.
  headers       JSONB       NOT NULL,
  -- The bytes exactly as they arrived. Not the re-serialised JSON: `JSON.parse` followed by
  -- `JSON.stringify` produces different bytes — reordered keys, different escaping — and the
  -- signature is over the original ones.
  raw           BYTEA       NOT NULL,
  received_at   TIMESTAMPTZ NOT NULL,

  state         TEXT        NOT NULL DEFAULT 'pending'
                  CHECK (state IN ('pending', 'processed', 'ignored', 'rejected', 'failed')),

  -- How many times a worker has tried and thrown. A delivery that cannot be worked is not
  -- retried forever in silence: past the cap it becomes 'failed', which is a human's problem
  -- rather than a loop's.
  attempts      INTEGER     NOT NULL DEFAULT 0,
  last_error    TEXT,

  -- What the delivery turned out to mean, in one line: 'posted', 'duplicate',
  -- 'debit event — money leaving, not a promise of money arriving'. The reason an ignored
  -- delivery was ignored is the only thing that distinguishes a provider event we have no
  -- use for from one we silently dropped.
  detail        TEXT,
  -- The ledger transaction it became, where it became one. This is the audit edge between
  -- "a stranger sent us bytes" and "the books say we are owed ₦10,000".
  transaction_id TEXT,
  processed_at  TIMESTAMPTZ
);

-- The claim query, and nothing else. A partial index on the pending rows only: a healthy
-- inbox is almost entirely processed rows, and an index over those is an index over history
-- that the one query anybody runs will never read.
CREATE INDEX webhook_inbox_pending_idx
  ON webhook_inbox (received_at, delivery_id)
  WHERE state = 'pending';

CREATE INDEX webhook_inbox_source_idx ON webhook_inbox (source, received_at);
