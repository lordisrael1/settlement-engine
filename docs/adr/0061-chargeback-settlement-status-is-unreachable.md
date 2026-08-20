# 61. The chargeback settlement status is unreachable through ingest, and is recorded as a gap

Date: 2026-08-19

## Status

Accepted

## Context

`packages/canon` defines `SettlementStatus` as `settled | reversed | chargeback`, and the
matcher has a branch for the third: a clawback against an already settled promise books
immediately via `bookChargeback`. But ingest's `SETTLED_STATUSES` maps only
`SUCCESSFUL -> settled` and `REVERSED -> reversed`, so there is no path from any connector's
vocabulary to `chargeback`.

## Decision

The simulator's chargeback is a Flutterwave `chargeback` deduction folded into a payout,
which books to the `chargebacks` account when the bank confirms it. It is not a settlement
line carrying `SettlementStatus: 'chargeback'`, because no adapter can produce one.

## Consequences

- Adding a status mapping is a change to the anti-corruption boundary, and it should be made
  when a real provider file pins what the row looks like — the same discipline that keeps
  Paystack's settlement adapter `null` until a sanitized export exists.
- The clawback path that is reachable is exercised end to end and books to the right account.
  The line-status path is dead code until a connector can produce it, and this record is what
  stops that being discovered by accident.
