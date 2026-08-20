# 47. The event log is written beside the ledger, not instead of it

Date: 2026-08-17

## Status

Accepted

## Context

A log-first design would make the primary write an event insert, which moves the balance-zero
invariant out of the database and into application code. For a financial ledger that trades a
database-enforced invariant for an application-enforced one.

There is also a subtler problem: when the log is the only writer, replaying it can only
reproduce itself. The fold agrees with the projection because the projection came from the
fold, so a bug in the writer is invisible.

## Decision

An append-only `events` table records every domain happening, written in the same database
transaction as the state change that causes it. `replay` folds it from event zero and asserts
the projections match. `rebuildBalancesFromEvents` discards the balance cache and rebuilds it
from the fold. The ledger remains the write path.

## Consequences

- One ordered narrative from genesis, replayable, with balances rebuildable from it.
- Entries and the log are written by different code in the same transaction, so agreement
  between them is evidence rather than tautology. `replay` checks three independent records —
  the entries, the balance cache and the log — and reports which pair disagrees.
- Every booking carries its entries twice, in two shapes. That duplication is the price of
  the cross-check being meaningful.
- A transaction posted with no event is invisible to the fold, so the fold checks for exactly
  that at entry level. Any booking function added later must supply an event.
