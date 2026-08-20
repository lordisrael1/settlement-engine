# 43. An exception is an entity with an appended lifecycle and a derived key

Date: 2026-08-17

## Status

Accepted

## Context

Matching could say what was wrong at the moment of a run. It could not say that the same
thing had been wrong since Tuesday, that somebody was already looking at it, or that it had
resolved itself. Every run started from nothing and reported everything, which is a report
rather than a queue.

## Decision

Findings that reach `exception` become rows in `exception_events`, append-only, with the
current state derived by a view taking the newest event per key. The key is
`(subject, subjectId, reason)`, derived rather than generated. States are
`open -> acknowledged -> resolved`.

## Consequences

- Without a derived key the queue would grow by the number of runs rather than the number of
  problems. Derivation is also what lets a replay reach the same keys as the run it replays.
- Events and a view rather than a `state` column, matching the shape the ledger already uses
  for `transaction_state_changes`, so a reader who knows one knows the other.
- An exception that resolved and is found again appends a reopening rather than being treated
  as never having closed, which preserves the most useful signal the table holds: which
  problems recur.
- A view rather than a table on the read path, and a state machine to keep in mind.
  `severityOf` sorts the queue by what the problem is rather than when it arrived.
