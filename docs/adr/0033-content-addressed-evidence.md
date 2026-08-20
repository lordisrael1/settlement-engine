# 33. Evidence is content-addressed and retained; narration is tokenised

Date: 2026-08-16

## Status

Accepted — the retention half superseded by [ADR-0065](0065-evidence-retention-schedule.md)

## Context

Six months after a match, "the system matched it" is not an answer. Which file, who uploaded
it, and which parser read it are the questions actually asked.

Bank narration is the only thing linking a credit to a payout at most Nigerian banks, and it
is truncated and inconsistent.

## Decision

Every canonical record carries an `evidenceId` — the SHA-256 of the file it came from. The
`evidence` table stores the bytes, the uploader, the receipt time and the parser version, and
is append-only. Bank narration is parsed into `narrationTokens` (candidates), never into a
resolved reference.

## Consequences

- Content-addressing makes re-uploading a file a no-op by construction, and makes "is this
  the file you used?" answerable by anyone holding the file.
- `parserVersion` is recorded because a parser is part of the reasoning: when an adapter is
  corrected, every conclusion the old one reached is suspect and findable.
- The matcher resolves narration tokens against payouts it actually holds, so a guess is
  never indistinguishable from a reference the bank supplied.
- Storage, retention and sensitive-data controls are now this system's problem.
  `evidence.raw` is nullable so a deployment can truncate on a schedule and keep the hash.
  **This last consequence was wrong and is superseded by ADR-0065.** The append-only trigger
  on `evidence` refuses that `UPDATE`, so the path described here never existed; the bytes
  now live in a separate, encrypted, expiring `evidence_blobs`, and the hash stays here.
