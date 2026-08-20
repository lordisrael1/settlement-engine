# 14. A transaction's id is the causing event's idempotency key

Date: 2026-08-15

## Status

Accepted

## Context

The same real-world event entering the system twice must have the effect of entering it
once. A transaction is the record of exactly one event.

## Decision

`ledger_transactions.transaction_id` is the primary key and holds the idempotency key. There
is no separate `idempotency_key` column.

## Consequences

- Idempotency is enforced by the primary key: `INSERT ... ON CONFLICT DO NOTHING` resolves a
  redelivery in the database, with no read-then-write window for two concurrent workers.
- Derived transactions follow the same rule. A reversal is the original id suffixed with
  `#reversal`, so reversing twice collides on the key instead of refunding twice.
- Ids are derived, never generated. There is no `randomUUID()` in any write path, so
  replaying the same events produces a byte-identical database.
