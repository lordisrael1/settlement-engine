# 15. Balance-zero and append-only are enforced by database triggers

Date: 2026-08-15

## Status

Accepted

## Context

A check that lives only in application code can be walked past by a migration script, a
`psql` session, or a second service.

## Decision

Both invariants are enforced in Postgres. Balance-zero is a
`CONSTRAINT TRIGGER ... DEFERRABLE INITIALLY DEFERRED` on `entries`; append-only is a
`BEFORE UPDATE OR DELETE` trigger on the three history tables. The application keeps a
fail-fast check as well, so callers get an error naming the missing money, but the database
has the final say.

## Consequences

- The balance-zero trigger must be deferred: entries are inserted row by row, so an
  immediate check would fire on the first row and reject every balanced transaction.
  Deferring to `COMMIT` lets the trigger see the whole set while still running inside the
  committing transaction, so concurrency cannot slip an unbalanced transaction through.
- The demo and the test suite prove this by writing entries with raw SQL, bypassing the
  application entirely, and letting `COMMIT` refuse.
- `account_balances` is exempt from the append-only triggers, because a cache that cannot be
  updated is not a cache. The cache-equals-recompute check keeps it honest.
