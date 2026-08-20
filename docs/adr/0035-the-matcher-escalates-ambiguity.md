# 35. The matcher escalates ambiguity rather than resolving it

Date: 2026-08-16

## Status

Accepted

## Context

A wrong match does not fail loudly. It settles the wrong records and leaves the right ones to
escalate later as inexplicable absences, long after anyone can reconstruct what happened.

## Decision

Ambiguity escalates in four places: a batch with two valid subsets; a bank credit fitting two
open inflows equally well; a reference naming two promises; and a shortfall larger than the
source's declared bank-charge allowance.

## Consequences

- Escalating an ambiguous payout costs a reviewer a few minutes. Guessing costs them a week
  of not knowing anything is wrong.
- The bank-charge allowance is the one deliberate tolerance in the system, and it is
  per-source data rather than a constant: correspondent banks take small unannounced
  charges, so a credit short by 52.50 naira is ordinary and one short by 52,000 is not.
- Batch matching remains exact-sum. In integer kobo with a dated fee contract there is
  nothing to be tolerant of. `FX_ROUNDING` exists for the day a second currency appears.
