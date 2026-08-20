# 29. Deductions are named, and a booking that needs a plug is refused

Date: 2026-08-16

## Status

Accepted

## Context

"The payout is 4,200 naira short" is not actionable. "4,200 naira is a rolling reserve
returned in 90 days" is. Forcing an unexplained difference into `fees_expense` always
balances and always misstates: an unexplained shortfall becomes an unusually expensive day
nobody investigates.

## Decision

`AdjustmentKind` is `fee | tax | reserve | reserve_release | penalty | refund | chargeback`,
each mapped to its own account. `bookBankConfirmedSettlement` throws unless the discharged
total equals the credited amount plus the named deductions.

## Consequences

- A reserve is an asset — the provider is holding our money, not keeping it — so booking it
  as a cost would understate what we are owed by exactly the amount we are owed.
- Tax is an expense, but not the provider's, so it books to `taxes_withheld` rather than
  inflating what looks like provider pricing.
- A transaction that will not balance without a plug is escalated instead of booked.
- `payoutArithmetic` checks the provider's report against itself before any matching. A file
  whose declared net does not equal its gross less its own itemised deductions raises
  `PAYOUT_UNBALANCED`, so downstream discrepancies are not blamed on the payments.
