# 72. Same-amount credits are paired as a set, or the queue depth tracks transaction volume

Date: 2026-08-22

## Status

Accepted — narrows the "escalate ambiguity" rule of ADR-0035 in one specific, provable case

## Context

ADR-0035 is the rule this engine is built on: two candidates that fit equally well means
escalate, because guessing costs a week of nobody knowing anything is wrong and escalating
costs five minutes. `uniqueByAmount` implements it — a bank credit confirms an inflow only if
exactly one open inflow matches its amount.

The trouble is what "exactly one" does to an ordinary Tuesday.

Two payouts that net to the same figure on the same day produce two identical bank credits.
Each credit sees two candidates. Each refuses. Both escalate as `UNIDENTIFIED_CREDIT`,
severity 3 — the same rank as cash that arrived and belongs to nobody — while a human looking
at the statement sees the answer immediately.

For a subscription or fixed-price business, same-net payouts are not an edge case; they are
the norm. Round prices produce round nets, and the number of same-amount collisions grows with
transaction volume. So does the queue.

The reference path is what would normally rescue this, and it is unavailable in exactly this
case: Nigerian bank narrations are frequently truncated or generic, which is *why* the amount
path is being used at all. The worst-case input for this matcher — round prices, weak
narration — is also one of the most common.

A queue whose depth scales with transaction volume is how reconciliation tools die in
practice. Not by being wrong. By being unread.

## Decision

The question `uniqueByAmount` asks cannot be answered by one credit alone, so it is asked once
for the whole statement instead.

`pairEqualAmounts` groups unmatched credits by amount and unmatched inflows by expected net,
and pairs a group only when **all four** of these hold:

**The sets are the same size.** Three credits against two inflows means one of the credits is
something else — possibly a duplicate, possibly fraud — and pairing any of them is choosing
which mystery to ignore.

**Nobody named.** Any credit whose narration identifies an inflow, and any inflow named by any
credit in the statement, is removed from both sides first. The reference path is strictly
better evidence and is never pre-empted by arithmetic.

**Amounts are exact.** No bank-charge allowance. The allowance exists to explain a shortfall
on a credit already identified; using it to *decide* identity would let two credits ₦50 apart
join one group.

**Every pairing is legal.** Each credit must satisfy `notBefore` against each inflow in the
group. If some pairings are legal and others are not, the bijection carries information, and
choosing one becomes a real decision this function is not entitled to make.

Where all four hold, pairing is FIFO by value date — the convention a human would use, and a
total order over data already in the statement, so it is deterministic.

**Why this is not a guess.** The *set* is unambiguous even though no member of it is: there is
exactly one set of pairings up to ordering. And because every member carries the same amount,
each booking's entries are identical whichever way round the bijection falls. What differs
between orderings is only which statement row is filed as the evidence for which payout.

That is an audit imprecision, and it is recorded as one: confidence 0.7 — below
`bankByAmount`'s 0.85, because which member of the set this row is remains a convention rather
than a finding — and the `considered` list carries the alternatives, the only place in this
engine where a *successful* match keeps its working.

It is gated by policy: `SourcePolicy.pairEqualAmounts`, `false` for `UNPROFILED_SOURCE` like
every other allowance, and enabled by `buildPolicy` for sources we hold a profile for.

## Consequences

The common case stops flooding the queue, and the escalation still happens whenever the sets
disagree in size — which is exactly when one of the credits really is a mystery.

A mis-paired credit attaches the wrong statement row to the right payout. The amounts, the
accounts, the deductions and the discharged promises are all identical, so nothing financial
turns on it; what is affected is the answer to "show me the bank line that confirmed PO-91",
which may return its twin. The confidence and the retained candidates are how a reader knows
to check.

This is the first narrowing of ADR-0035 in the repository, and it is deliberately narrow: it
applies only where the alternative answers are provably interchangeable. Any case where they
are not still escalates.

A remaining gap, named rather than fixed: three credits and two inflows still escalates all
three, even when two of them obviously pair. Sizing that correctly needs the bank's own
running balance to disambiguate, which is a different piece of work.
