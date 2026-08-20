# 36. The reason-code taxonomy covers the three-way model

Date: 2026-08-16

## Status

Accepted

## Context

A difference with no reason code is not allowed to exist. The three-way model creates
differences the original taxonomy could not name — chiefly "reported but not banked", which
is neither matched nor missing and is the most common real state in Nigerian settlement.

## Decision

Add `PAYOUT_MATCH`, `BANK_CONFIRMED`, `AWAITING_BANK_CREDIT`, `PARTIAL_SETTLEMENT`,
`RESERVE_WITHHELD`, `TAX_WITHHELD`, `PENALTY`, `BANK_CHARGE`, `AMOUNT_MISMATCH`,
`DUPLICATE_BANK_CREDIT`, `RETURNED_PAYOUT`, `UNIDENTIFIED_CREDIT` and `PAYOUT_UNBALANCED`.
`REASON_KIND` groups every code as a match, an explanation or an exception.

## Consequences

- `AMOUNT_MISMATCH` closes an older gap: two records naming the same reference and
  disagreeing about the amount, with no fee contract able to explain it, previously had to
  masquerade as a phantom credit plus a missing settlement.
- The grouping lives in `canon` because it states what a code means, and a second copy in the
  matcher could disagree with it.
