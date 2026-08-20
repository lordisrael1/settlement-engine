# 28. The payout is a first-class entity, and inflows unify the two source shapes

Date: 2026-08-16

## Status

Accepted

## Context

Sources fall into two camps. Flutterwave names the movement: one reference, one fee
breakdown, and a charge count it does not enumerate. Nomba and Monnify list transactions and
leave the movement implicit. A named payout is strictly better information, because the
provider has told us the grouping and arithmetic only has to confirm it.

## Decision

`Payout` carries a `payoutReference`, its own itemised deductions and an `expectedNet`.
Settlement lines belong to one. Both source shapes normalise into an internal
`ExpectedInflow`, which is the only thing bank confirmation matches against.

## Consequences

- The bank matcher is written once rather than once per source shape.
- `ExpectedInflow` carries what confirmation needs — how much, when, from whom, which
  promises, what was deducted — plus a `derived` flag, so an inflow the provider declared
  and one we grouped ourselves are treated differently in the exception queue.
- Derived inflows are keyed by source and settlement date, a grouping this system invented.
  It is labelled as such, and a bank credit that does not match it escalates rather than
  being forced onto it.
