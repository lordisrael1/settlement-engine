# 48. The log opens with a genesis event

Date: 2026-08-17

## Status

Accepted

## Context

A log that begins today cannot explain a ledger that began earlier. Transactions written
before the log existed are in `entries` and nowhere in `events`, so a replay would fold to
zero and report every account as drifted.

## Decision

Migration `0006` writes one `LedgerOpened` event carrying the per-account position as it
stood at adoption, and one `ExceptionRaised` per exception open at that moment. On a fresh
database neither is written.

## Consequences

- An opening balance is what any other set of books does with the same problem.
- The period before adoption is attested rather than reconstructed, and that is stated in the
  event's own `detail` rather than left to be inferred.
