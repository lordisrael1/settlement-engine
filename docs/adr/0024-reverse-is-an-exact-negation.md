# 24. reverse() is an exact negation and nothing more

Date: 2026-08-15

## Status

Accepted

## Context

Correcting a mistake means writing a compensating transaction rather than editing history.
The primitive that does so must be provably correct without knowing what kind of business
event caused the correction.

## Decision

`reverse()` negates every entry of the original transaction. It does not touch the
`reversals` contra-income account.

## Consequences

- Booking a refund as contra-income, so that gross revenue reporting survives the refund, is
  a domain decision about which account absorbs it. That belongs to the reconciler, which
  composes it from `postTransaction` directly.
- `reversals` and `chargebacks` are unused until the reconciler needs them.
