-- The inbox stops being the system's personal-data store.
--
-- ADR-0049 kept customer names, emails and phone numbers out of the reconciliation tables,
-- and was right to. It said nothing about this table, which has been storing whole provider
-- payloads forever — and a Paystack `charge.success` body carries `customer.first_name`,
-- `customer.last_name`, `customer.email`, `ip_address`, and an `authorization` object with
-- the card's BIN, last four and expiry. That made `webhook_inbox.raw` the largest
-- collection of personal data in a system whose entire design principle is holding as
-- little as possible (ADR-0064).
--
-- The fix is not a second table. It is one column that says which version of the bytes is
-- in `raw`, and a drain that replaces the original with a keep-list copy inside the same
-- transaction that marks the delivery worked.
--
-- **Why the redaction happens at that exact moment.** A delivery is claimed, interpreted,
-- and its outcome written in one transaction; the signature is re-verified during that
-- interpretation, over the original bytes. Redacting any earlier would break the
-- verification the worker is about to perform. Redacting any later — on a schedule, from
-- another process — leaves a window whose width is a configuration value, and "how much
-- personal data do we hold?" would have the answer "it depends how busy the retention job
-- has been". Inside the transaction there is no window at all.
--
-- What is given up, said plainly: once redacted, the HMAC cannot be recomputed over these
-- bytes, so "prove this delivery is authentic" stops being answerable from the row. It
-- stops being answerable *from the row* — the delivery id is still the SHA-256 of the
-- original source and body, the verification happened before the row was written, and the
-- fact that it verified is what the acceptance itself records. Re-running the HMAC matters
-- inside a dispute window and nowhere else, which is why the originals survive one
-- (ADR-0064).

ALTER TABLE webhook_inbox
  -- Which version of the payload `raw` holds. Not inferred from `state`: a delivery can be
  -- processed and not yet redacted, and a system that guesses which bytes it is holding
  -- cannot answer the only question that matters about them.
  ADD COLUMN content TEXT NOT NULL DEFAULT 'original'
    CHECK (content IN ('original', 'redacted')),
  -- When the original was destroyed. Null while it is still here. A deletion nobody can see
  -- is indistinguishable from a deletion nobody performed.
  ADD COLUMN redacted_at TIMESTAMPTZ,
  -- How many scalar values the keep-list dropped. A number that suddenly reads zero on a
  -- provider's payloads means the shape changed under the redactor, and is worth an alert
  -- long before anybody notices the payloads got bigger.
  ADD COLUMN redacted_dropped INT,

  ADD CONSTRAINT webhook_inbox_redaction_complete
    CHECK ((content = 'original') = (redacted_at IS NULL));

-- The retention sweep's query, and nothing else: the originals still here, oldest first.
-- Partial, because in a healthy deployment almost every row is already redacted and an
-- index over those is an index over the answer nobody is looking for.
CREATE INDEX webhook_inbox_original_idx
  ON webhook_inbox (received_at, delivery_id)
  WHERE content = 'original';
