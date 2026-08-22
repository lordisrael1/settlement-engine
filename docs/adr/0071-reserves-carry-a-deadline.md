# 71. A withheld reserve carries a deadline, or it is money nobody chases

Date: 2026-08-22

## Status

Accepted

## Context

ADR-0029 gets the accounting right. A reserve is a *named* deduction, it books to
`psp_reserve`, and `psp_reserve` is an **asset** — because the PSP is holding our money, not
keeping it, and booking it as a cost would understate what we are owed by exactly the amount
we are owed.

What was missing is the other half of being owed something: a date.

Without one, a reserve position is unfalsifiable. Consider two PSPs. The first withholds 5% of
every payout and returns each tranche after ninety days. The second withholds 5% of every
payout and returns nothing, ever. They produce:

- the same `psp_reserve` balance, growing;
- the same reconciliation, with every payout matched and explained;
- the same empty exception queue;
- the same clean `verify`.

There is no number anywhere in the system that differs between a healthy rolling reserve and a
PSP quietly keeping our money. The balance grows in both cases and looks correct in both
cases, because in both cases it *is* correct — it is a faithful record of what was withheld,
and a faithful record of a withholding says nothing about whether it came back.

This is precisely the class of silent disappearance the rest of the engine exists to prevent,
and it was the one place the engine could not see. Nothing raises an exception, because
nothing is inconsistent. Three records agree perfectly that the money is over there.

## Decision

**A withholding becomes a dated obligation.**

When a bank credit confirms a payout whose net `psp_reserve` movement is positive, the
reconciliation writes a `reserve_holds` row in the *same transaction as the booking*: the
inflow it was withheld from, the amount, and a `due_at`. Same transaction, because separately
would permit a `psp_reserve` entry with no hold behind it — a balance growing with nothing
recording when any of it is due, which is the exact state this exists to make impossible.

The clock starts at the **value date of the confirming bank credit**, not at the run's `asOf`.
A reserve's ninety days run from when the money was actually held back, and dating it to the
run would restart every reserve's clock on the day somebody re-imported a file.

**The deadline is policy, per source.** `SourcePolicy.reserveReleaseDays`, arriving with the
calendar and the fee model and the bank-charge allowance, so nothing in the matcher learns a
PSP's name. Ninety days is the common Nigerian rolling-reserve term and is a number somebody
chose, which is why it lives in policy rather than as a constant.

`null` is a distinct and meaningful value: the source declared no schedule. Such a hold is
recorded and reported — it is still our money in somebody else's account — but never becomes
an exception. An exception no evidence can ever clear is the worst entry a queue can hold, and
inventing a deadline for a source that promised nothing would manufacture exactly that.

**Releases are appended, and applied oldest-first.** A `reserve_release` adjustment arrives as
a negative deduction on some later payout and names no particular withholding. So
`reserve_releases` records which hold each release answered and by how much, and the position
is a view over the two tables rather than a decremented column. The alternative — a
`released_kobo` the reconciler updates — is an UPDATE, and produces a position nobody can
explain: "₦40,000 of ₦100,000 is back" says nothing about which payouts carried it.

Oldest-first is stated rather than implied. It is what every rolling-reserve schedule actually
does, and it is the only allocation that requires no guessing.

**Overdue holds join the queue through the ordinary machinery.** `unreleasedReserves` produces
`ExceptionDraft`s exactly like the matcher's own findings, so `RESERVE_UNRELEASED` raises,
deduplicates, and — this is the important half — *clears itself* the moment a release finally
arrives, with nobody alerted (ADR-0044).

The subject is the **payout**, not an account balance. "PO-4471 settled ₦180,000 short on the
3rd of March, you said ninety days, it is the 12th of July" is something a person can take to
a PSP. "psp_reserve is large" is not.

## Consequences

This is the only finding in a reconciliation run that comes from the *books* rather than from
comparing two records — because that is what it is about: money nobody disputes we are owed,
that nobody has sent back, and that no third record will ever mention.

A release larger than everything outstanding is not forced to fit. The remainder is left
unallocated, because the alternative is inventing a hold to absorb it. It surfaces as a
`psp_reserve` balance below the sum of holds — an honest loose end rather than a tidy lie.

`GET /reserves` and the `reserves` CLI command list what is outstanding, oldest first,
including the undated ones. A source holding money on no declared schedule at all is a thing
to notice when reading that list — which is the correct place for it, rather than an alert
nobody can action.

Reserves withheld before this shipped have no hold rows and will never be chased by this
mechanism. Backfilling them is possible from `entries` and is deliberately not done
automatically: the `due_at` would be derived from a schedule nobody agreed to at the time.
