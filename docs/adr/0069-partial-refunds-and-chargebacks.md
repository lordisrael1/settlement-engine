# 69. A refund may be for part of a payment

Date: 2026-08-22

## Status

Accepted — amends ADR-0024 by adding a domain booking it deliberately does not provide

## Context

ADR-0024 draws a clean line: `reverse()` is an exact negation of a whole transaction, correct
without knowing what caused it, and `bookReversal` is the domain decision that knows it is
looking at a refunded payment and books it as contra-income. That line is right and is not
changed here.

What was missing is that a refund is not necessarily a refund of *everything*.

A customer buys four items for ₦10,000 and cancels one. The PSP reports a settlement line
with status `reversed` and a gross of ₦3,000. The matcher read the status, concluded
`REVERSAL`, and booked `promise.gross` — the whole ₦10,000 — because the amount was never
consulted. Three things then went wrong at once:

- ₦10,000 was credited to `psp_receivable` when only ₦3,000 came back, so the books said the
  PSP owed us nothing while it still owed us ₦7,000.
- ₦10,000 was debited to `reversals`, overstating refunds and understating net revenue by
  ₦7,000 permanently.
- The promise was transitioned to `reversed`, which is terminal. The ₦7,000 that *did* settle
  later had no open receivable to discharge, so it arrived as a payout covering a promise the
  ledger had closed — a `PHANTOM_CREDIT`, or an amount mismatch, days later and nowhere near
  the refund that caused it.

Partial chargebacks have the same shape. The path is currently unreachable through ingest
(ADR-0061), which is why this was easy to miss, and it will not stay unreachable.

Partial order cancellation is not an exotic case. It is the ordinary shape of e-commerce, and
it is one of the first things a payments reviewer asks about.

## Decision

**The amount comes from the line, not from the promise.**

`concludeByReference` now reads the reversing line's own gross and returns it with the
conclusion, along with two new reason codes: `PARTIAL_REVERSAL` and `PARTIAL_CHARGEBACK`, both
`explanation` rather than `exception` — a partial refund is understood, not unexplained.

Two shapes are refused rather than booked, because neither is a refund: a line reversing zero,
and a line reversing more than the promise ever was. Both are parse errors wearing a plausible
face, and they escalate as an amount mismatch.

**Only a whole refund ends the promise's story.**

`bookReversal` takes the `DischargedPromise` it always took, and now compares `amount` to
`receivable`. When they are equal it transitions the promise to `reversed`, exactly as before.
When they differ it books the entries for the refunded part and leaves the promise
`authorized`, still waiting for the payout that will carry the rest.

This is not a new idea in this codebase — it is the test `bookBankConfirmedSettlement` already
applies to a part-settled promise ("a payment settled only in part is still waiting for the
rest, so it keeps its `authorized` state"), applied to the other direction. Allocation has
carried an amount since ADR-0032 for the same reason.

`bookReversal` also gained the two refusals above, so the rule holds for any caller rather
than only for the matcher.

**Only the refunded part is claimed.**

In `allocate`, a reversing line claims `conclusion.amount` against the promise rather than the
whole receivable, so the remainder stays available to whatever payout eventually carries it.
The allocation's `receivable` field stays whole — it is what the booking compares against to
decide whether the story has ended, and shrinking it would make every partial refund look
total again.

## Consequences

`psp_receivable` is now correct after a partial refund, which is the whole point:
`psp_receivable` is the most useful number in the business precisely because it is exactly the
money promised and not yet in our hands.

`reversals` is now the amount actually refunded, so gross revenue less contra-income is a
number a finance person can use.

A promise can now be partially reversed *and* partially settled, in either order, and both are
ordinary. The lifecycle already permitted it; nothing was producing it.

Confidence for a partial is 0.9 rather than 1. The linkage is just as certain — both sides
name the same reference — but the amount is a claim only the PSP made, and a whole reversal is
self-checking against the receivable in a way a partial one is not.

A settlement adapter that reports a `reversed` line with a gross of zero, which some do for
metadata rows, now escalates instead of booking nothing. That is a real behaviour change and
the right one: a line that reverses nothing is not a refund.

Refunds *larger* than the original are still not modelled, and are refused with a message
saying why: that is a goodwill payment, which is a different economic event and does not
belong against this receivable.
