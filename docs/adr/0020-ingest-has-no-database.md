# 20. Ingest has no database, and deduplication takes an injected predicate

Date: 2026-08-15

## Status

Accepted

## Context

`packages/ingest` translates foreign shapes into canonical events. Persisting those events
is a separate concern belonging to the component that reads them.

## Decision

`dedupe(items, alreadySeen)` is a pure function over a set passed in. `packages/ingest` owns
no table and performs no I/O.

## Consequences

- Ingest depends on `canon` and `pay-normalize` and nothing else, which makes it
  exhaustively testable with no I/O.
- Settlement-line persistence belongs to the reconciler, which is the component that reads
  them.
- Webhook idempotency is durable through the ledger's primary key. Settlement-line
  idempotency was, until the reconciler gave settlement lines a table, enforced only within
  a run.
- `dedupe` also drops duplicates within one batch — an overlapping re-export, or a provider
  listing a record twice on one page.
