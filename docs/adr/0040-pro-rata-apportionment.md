# 40. Batch deductions are apportioned pro rata by gross, by largest remainder

Date: 2026-08-16

## Status

Accepted

## Context

Gross allocation says which receivables a payout closed. It does not say what an individual
payment cost — the number behind per-payment margin, per-merchant profitability and every
fee dispute with a provider.

## Decision

Each allocation stores its share of every deduction and the resulting net. The rule is pro
rata by gross allocated, resolved by largest remainder, with equal remainders broken by
transaction id, applied per account independently. The rule that produced a split is stored
with it.

## Consequences

- Pro rata by gross, because provider pricing is overwhelmingly percentage-driven.
- Largest remainder, because integer kobo do not divide evenly and the shares must add back
  to the total exactly. A rounding rule that loses a kobo makes apportioned deductions
  disagree with the deduction actually booked.
- Ties by transaction id, because "whichever the map iterated first" is not reproducible.
- Per account independently, because apportioning the aggregate and splitting it afterwards
  rounds twice and reconciles to neither.
- This is not a claim about what the provider would have charged had each payment settled
  alone; a flat component or a cap makes that a different number. It is a defensible split of
  a real charge.
- Stored rather than recomputed, so an old answer stays reproducible after the rule changes.
- Only provider deductions are apportioned. A correspondent-bank charge is discovered at bank
  confirmation, is levied on the credit rather than on any payment, and books to
  `bank_charges` on the confirming transaction without being attributed to individual
  payments.
