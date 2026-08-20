# 65. Evidence is split into an immutable record and an expiring body, on a schedule a command runs

Date: 2026-08-20

## Status

Accepted — supersedes the retention half of ADR-0033

## Context

ADR-0033 said `evidence.raw` is nullable so a deployment can "truncate on a schedule and
keep the hash forever". It could not. `evidence` carries a `BEFORE UPDATE OR DELETE` trigger
(migration 0002), so `UPDATE evidence SET raw = NULL` is refused by the database. The
retention path that record describes had never been runnable, and no code ever tried to run
it.

The contradiction is real rather than an oversight. **Append-only** and **delete this on a
schedule** are opposite requirements, and no single table satisfies both.

There was also no retention code anywhere in the repository, and no schedule written down.

## Decision

Split the table the way this codebase already resolves the same tension twice —
`account_balances` is a cache and is exempt from append-only, `webhook_inbox` is a queue and
is exempt:

    evidence         identity, lineage, parser version, the hash.   Immutable, forever.
    evidence_blobs   the bytes. Encrypted, versioned, expiring.     Mutable by design.

`evidence.raw` is dropped rather than left dead, per the rule in CONTRIBUTING.md about not
keeping obsolete paths.

The schedule, with defaults that are a starting position and not a legal opinion:

| Data | Retention |
| --- | --- |
| Provider payload, as it arrived | 30 days, then replaced by a keep-list copy |
| Redacted payload; settlement exports; bank statements | 6 years, then destroyed |
| Hash, lineage, parser version, access log, event log | indefinite |
| `webhook_inbox.raw` | redacted on processing; stragglers swept at 30 days |

It runs as `pipeline evidence-retention`, **a dry run unless `--apply`**. Every destruction
appends an `EvidencePurged` event in the same transaction.

## Consequences

- The hash stays in the immutable half. Six months after the bytes are gone, "this document
  existed, it hashed to 9f3a…, this parser read it, this operator uploaded it, and these
  conclusions were drawn from it" is still on the record. What is lost is the ability to
  re-derive the conclusions, not the ability to state what they were.
- A purge empties the row rather than deleting it, and a database constraint enforces that a
  purged row holds no ciphertext. A deleted row would leave no record that there had ever
  been anything to delete, which is the one thing a purge must not do.
- Re-uploading a file whose blob was purged does **not** restore it. The evidence row is the
  identity and already exists; resurrecting destroyed bytes would make the schedule a
  suggestion.
- It is a command an operator schedules, not a thread inside the service. A deletion of
  financial evidence should be something somebody scheduled with an output somebody reads,
  and the CLI is already where this system's scheduled work lives — `replay` set the
  precedent (ADR-0022).
- Dry run is the default because a command that destroys evidence should have to be asked
  twice, including on the day somebody shortens the schedule by a decimal point.
- One document per transaction, and a document that will not decrypt is *reported* rather
  than thrown. A run that aborts on the first failure is a run that quietly stops running —
  the same reasoning the inbox drain applies to a poison delivery.
- `purge_after` is computed when the bytes are written and stored, so a schedule changed next
  quarter does not silently re-date everything already held, in either direction.
- The six-year figure is the shortest that satisfies the ordinary Nigerian financial
  record-keeping expectation. It is `RECON_RETENTION_REDACTED_DAYS` because it is a question
  for counsel against CBN and FIRS obligations, and nobody should have to edit a TypeScript
  constant to record that answer.
- Nigeria's Data Protection Act 2023 is the binding regime for the personal data that remains
  — data minimisation, a lawful basis, subject-access and erasure handling, and breach
  notification to the NDPC. The redaction above is most of the compliance work; what a
  deployment still owes is a documented lawful basis and this schedule, confirmed and
  published.
