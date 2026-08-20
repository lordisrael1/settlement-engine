# 4. A payment is two ledger transactions, and deductions are booked at settlement

Date: 2026-08-15

## Status

Accepted — amended by [ADR-0027](0027-three-way-reconciliation.md) and
[ADR-0031](0031-business-day-deadlines.md).

## Context

A payment produces information (a webhook, in seconds) and money (settled cash, later). At
the moment the webhook arrives the fee is not knowable: a rate card can change, a cap can
apply, an international surcharge can land.

## Decision

Record a payment as two ledger transactions:

    T+0        authorized   psp_receivable  +gross      merchant_revenue  -gross
    T+1/T+2    settled      bank_account    +credited   psp_receivable    -sum discharged
               on bank      fees_expense    +fee        taxes_withheld    +tax
               evidence     psp_reserve     +reserve    penalties         +penalty

Revenue is booked at gross — what the customer paid. Deductions are debits, booked only when
the money arrives and the amounts are known.

## Consequences

- No estimated fee enters the books, so no correcting entry is needed for a guess.
- `psp_receivable` is exactly the money promised but not yet paid at any instant, because
  the receivable opens and closes at gross.
- Signs are correct: an expense is debit-natural, and a fee is a cost.
- The second transaction is triggered by an independent bank credit, not by the PSP's
  settlement report — see [ADR-0027](0027-three-way-reconciliation.md). It books what the
  bank actually paid against every named deduction, and is refused if those do not account
  for the receivable exactly.
