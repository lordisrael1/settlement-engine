# 1. PostgreSQL is the ledger's system of record

Date: 2026-08-15

## Status

Accepted

## Context

The ledger rests on one invariant: the signed amounts of a transaction's entries sum to
zero. That check must run inside the same database transaction as the write. If it runs
outside, a concurrent writer can persist an unbalanced transaction in the gap between check
and insert, and the invariant becomes advisory.

The `pay-normalize` reference implementation uses MongoDB, which is appropriate for
stateless webhook normalisation but puts the check in application code.

## Decision

The ledger stores transactions and entries in PostgreSQL, and the balance-zero invariant is
enforced by a database constraint rather than by application code.

## Consequences

- ACID transactions and constraint triggers are available to enforce money invariants.
- The ingest packages stay aligned with the `pay-normalize` world; only the store beneath
  the ledger is Postgres.
- Tests that assert database-enforced invariants require a real Postgres instance; they
  cannot be run against a mock.
