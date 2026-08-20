# 16. Transaction lifecycle state is derived, not stored

Date: 2026-08-15

## Status

Accepted

## Context

A mutable `state` column means an `UPDATE`, and updates are how history gets rewritten.

## Decision

`ledger_transactions` has no `state` column. Transitions are appended to
`transaction_state_changes`, and the current state is a `DISTINCT ON` view.

## Consequences

- Ordering is by change sequence rather than by timestamp, so the answer never depends on a
  clock.
- `transition()` takes a row lock, because two workers reacting to the same settlement file
  would otherwise both read `authorized` and both append, recording one event twice.
- `settled` and `reversed` are terminal. `exception` is not: an exception is a question, and
  a late settlement file can answer it.
