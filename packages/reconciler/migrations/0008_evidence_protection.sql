-- Evidence gets a body, an expiry, and a visitors' book.
--
-- ADR-0033 said `evidence.raw` is nullable so a deployment can "truncate on a schedule and
-- keep the hash forever". It could not. `evidence` carries a BEFORE UPDATE OR DELETE
-- trigger, so `UPDATE evidence SET raw = NULL` is refused by the database — the retention
-- path that record describes has never been runnable, and no code ever tried to run it.
--
-- The contradiction is real rather than an oversight: **append-only** and **delete this on
-- a schedule** are opposite requirements, and no single table satisfies both. This resolves
-- it the way this codebase already resolves it twice — `account_balances` is a cache and is
-- exempt, `webhook_inbox` is a queue and is exempt — by separating the thing that must
-- never change from the thing that must:
--
--   `evidence`        identity, lineage, parser version, the hash.   Immutable, forever.
--   `evidence_blobs`  the bytes.  Encrypted, versioned, expiring.    Mutable by design.
--
-- The hash stays in the immutable half, which is the point. Six months after the bytes are
-- gone, "this document existed, it hashed to 9f3a…, this parser read it, this operator
-- uploaded it at this time, and these conclusions were drawn from it" is still on the
-- record. What is lost when a blob expires is the ability to re-derive the conclusions —
-- not the ability to state what they were, or what they were drawn from.
--
-- **Existing bytes are not carried across.** This migration cannot encrypt: no key material
-- exists inside a SQL script, and copying plaintext into `evidence_blobs` unencrypted would
-- defeat the entire purpose of the table. A deployment holding evidence it needs takes it
-- out first —
--
--     \copy (SELECT evidence_id, encode(raw, 'base64') FROM evidence WHERE raw IS NOT NULL)
--       TO 'evidence-backup.csv' CSV
--
-- — and re-ingests through the service, which encrypts on the way in.

-- ---------------------------------------------------------------------------
-- The bytes, encrypted per record, with an expiry date.
--
-- Envelope encryption: a fresh AES-256-GCM data key per record, wrapped by a root key the
-- database has never seen (ADR-0063). Disk encryption is not what protects this — the three
-- ways evidence actually leaks are a `pg_dump` somebody took to debug something, a read
-- replica nobody remembered, and a backup with the wrong ACL, and every one of them reads
-- the bytes through Postgres or through a file Postgres wrote.
--
-- The additional authenticated data is the evidence id, so a ciphertext cannot be lifted
-- out of one row and dropped into another: decryption under the wrong id fails. Without
-- that, a database write anybody can make would let one document's bytes be served as
-- another document's evidence, which is precisely what evidence exists to rule out.
--
-- No append-only trigger, deliberately and for the same reason `account_balances` has none.
-- A row here is rewritten three times in its life: sealed at ingest, replaced by a redacted
-- copy at the end of the dispute window, and emptied at the end of its retention. A table
-- that cannot be updated cannot expire, and a retention schedule that cannot run is a
-- paragraph rather than a control.
-- ---------------------------------------------------------------------------
CREATE TABLE evidence_blobs (
  evidence_id  TEXT PRIMARY KEY REFERENCES evidence (evidence_id),

  ciphertext   BYTEA NOT NULL,
  nonce        BYTEA NOT NULL,
  auth_tag     BYTEA NOT NULL,
  -- Which root key wrapped this record's data key. Rotation re-wraps the data key and
  -- leaves the ciphertext alone, so this varies across rows and a retired key must stay
  -- available for as long as any row still names it.
  key_id       TEXT  NOT NULL,
  wrapped_key  BYTEA NOT NULL,

  -- Which version of the document these bytes are. `original` is what arrived, byte for
  -- byte, and is the only version whose hash equals `evidence_id`.
  content      TEXT  NOT NULL CHECK (content IN ('original', 'redacted')),
  -- The plaintext length of *this* version. `evidence.byte_length` is the original's, and
  -- stays true forever; this one changes when a redacted copy replaces it.
  byte_length  INT   NOT NULL CHECK (byte_length >= 0),

  sealed_at    TIMESTAMPTZ NOT NULL,
  -- When this version stops being ours to hold. Derived from the retention schedule at the
  -- moment it is written, so changing the schedule tomorrow does not silently re-date
  -- everything already stored.
  purge_after  TIMESTAMPTZ NOT NULL,
  purged_at    TIMESTAMPTZ,

  -- Purged means empty, enforced rather than promised. Without this, a row could carry a
  -- purge timestamp and its ciphertext at the same time, and the answer to "did you delete
  -- it?" would depend on which column somebody read.
  CONSTRAINT evidence_blobs_purged_is_empty
    CHECK (purged_at IS NULL OR (octet_length(ciphertext) = 0 AND octet_length(wrapped_key) = 0))
);

-- The retention sweep's query: what is due, oldest first. Partial, because in a healthy
-- deployment most rows are not due and an index over those is an index over the answer
-- nobody is looking for.
CREATE INDEX evidence_blobs_due_idx
  ON evidence_blobs (purge_after)
  WHERE purged_at IS NULL;

ALTER TABLE evidence DROP COLUMN raw;

-- ---------------------------------------------------------------------------
-- Who looked at what, and why.
--
-- The gap this closes is reads. Every control in this system so far governs writes — the
-- ledger refuses an unbalanced transaction, a resolution needs a second approver, an
-- exception cannot be edited — and none of them notices somebody reading a hundred thousand
-- evidence records on a Sunday. Exfiltration is a read, and it is invisible to every
-- per-write check ever built.
--
-- Append-only, like `resolutions`, because an access log a principal can edit is a log
-- about principals who did not think to edit it.
--
-- The alert this table exists to support is a *volume* alert: one principal, many records,
-- a short window. No per-request check can catch that, because every individual request in
-- it is legitimate.
-- ---------------------------------------------------------------------------
CREATE TABLE evidence_access (
  access_id   BIGSERIAL PRIMARY KEY,
  evidence_id TEXT NOT NULL REFERENCES evidence (evidence_id),
  -- The *verified* principal, never a claim in a header. An audit record naming an operator
  -- who was named by the operator is decoration (ADR-0066).
  principal   TEXT NOT NULL,
  action      TEXT NOT NULL
              CHECK (action IN ('read_metadata', 'read_raw', 'export', 'purge')),
  -- Which version was handed over, for the actions that hand over bytes.
  content     TEXT CHECK (content IS NULL OR content IN ('original', 'redacted')),
  reason      TEXT,
  approved_by TEXT,
  -- The HTTP request this happened in, so one line here joins to the whole of a request in
  -- the service log.
  request_id  TEXT,
  at          TIMESTAMPTZ NOT NULL,

  -- Metadata is the cheap, ordinary case and needs no justification. Bytes leaving needs
  -- one, and a system that lets it be omitted collects a list of names.
  CONSTRAINT evidence_access_reasoned
    CHECK (action IN ('read_metadata', 'purge') OR (reason IS NOT NULL AND reason <> '')),
  CONSTRAINT evidence_access_no_self_approval
    CHECK (approved_by IS NULL OR approved_by <> principal)
);

CREATE INDEX evidence_access_principal_idx ON evidence_access (principal, at);
CREATE INDEX evidence_access_evidence_idx  ON evidence_access (evidence_id, at);

CREATE TRIGGER evidence_access_append_only
  BEFORE UPDATE OR DELETE ON evidence_access
  FOR EACH STATEMENT EXECUTE FUNCTION reject_mutation();

-- ---------------------------------------------------------------------------
-- Copies taken out of the system, and who agreed to them.
--
-- An export is the one operation that ends with evidence somewhere this system cannot see,
-- which is why it is maker-checked rather than merely authorised — the same control
-- ADR-0042 put on resolutions, pointed at the other direction value leaves. A resolution
-- moves money out of the books; an original export moves a customer's name and email out of
-- the estate.
--
-- The two constraints at the bottom are the whole control, in the database, where a
-- refactor cannot remove them: an original export without a second named approver cannot be
-- recorded, and an approver who is the requester is not a second person.
--
-- Not append-only: `fetched_at` is written when the archive is collected, which is the one
-- fact about an export that is not known when it is created.
-- ---------------------------------------------------------------------------
CREATE TABLE evidence_exports (
  -- The SHA-256 of the download token, and nothing else — so the identity of an export is
  -- derived rather than generated (idempotency, as everywhere else here), the token itself
  -- is never stored, and this id is safe to put in a log line, a response body and an audit
  -- record. Whoever holds this table holds no ability to collect anybody's export.
  export_id    TEXT PRIMARY KEY,
  evidence_id  TEXT NOT NULL REFERENCES evidence (evidence_id),
  content      TEXT NOT NULL CHECK (content IN ('original', 'redacted')),

  reason       TEXT NOT NULL CHECK (reason <> ''),
  requested_by TEXT NOT NULL,
  requested_at TIMESTAMPTZ NOT NULL,
  approved_by  TEXT,
  approved_at  TIMESTAMPTZ,

  -- Short, because a download link that is valid for a week is a download link somebody
  -- forwards.
  expires_at   TIMESTAMPTZ NOT NULL,
  -- Collected once, and emptied on collection. A second attempt with the same token finds
  -- this set and is refused.
  fetched_at   TIMESTAMPTZ,

  -- The archive, sealed under a key that was handed to the requester once and never stored.
  --
  -- So this column is unreadable to the database, to a backup of it, and to us — which is
  -- what "delivered as an encrypted archive" has to mean if it is to mean anything. The
  -- alternative, storing the archive in a form the service can read, would make the export
  -- table a second copy of every document anybody ever exported.
  archive       BYTEA NOT NULL,
  archive_nonce BYTEA NOT NULL,
  archive_tag   BYTEA NOT NULL,
  archive_bytes INT   NOT NULL CHECK (archive_bytes >= 0),

  CONSTRAINT evidence_exports_approval_complete
    CHECK ((approved_by IS NULL) = (approved_at IS NULL)),
  CONSTRAINT evidence_exports_no_self_approval
    CHECK (approved_by IS NULL OR approved_by <> requested_by),
  CONSTRAINT evidence_exports_original_needs_approval
    CHECK (content = 'redacted' OR approved_by IS NOT NULL)
);

CREATE INDEX evidence_exports_evidence_idx ON evidence_exports (evidence_id, requested_at);
