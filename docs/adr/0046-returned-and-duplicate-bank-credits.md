# 46. Returned payouts and duplicate credits are produced, not merely declared

Date: 2026-08-17

## Status

Accepted

## Context

`RETURNED_PAYOUT` and `DUPLICATE_BANK_CREDIT` existed as reason codes, and
`bookReturnedPayout` and `markPayoutReturned` existed as functions, but no code path could
reach any of them: bank confirmation filtered the statement down to credits, and a returned
payout arrives as a debit.

## Decision

Bank confirmation reads the whole statement. A debit matching a banked payout books an exact
negation of the confirming transaction and marks the payout `returned`. A second credit for
money already banked is reported as a duplicate rather than as unidentified. `confirm` takes
the already-confirmed inflows as evidence for both.

## Consequences

- A returned payout is the most consequential thing a bank statement can say — the money was
  booked, the payment was reported settled, and it bounced — and it is now visible.
- Both outcomes refuse to book, so no money moves either way; the difference is entirely in
  what the operator is told.
- A return must match the credited amount exactly, and unnamed returns are taken only when
  exactly one banked payout fits. Unwinding a settlement on an approximate match would be
  worse than escalating.
