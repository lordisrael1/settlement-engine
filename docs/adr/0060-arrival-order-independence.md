# 60. Arrival order is an argument, and the final state may not depend on it

Date: 2026-08-19

## Status

Accepted

## Context

Evidence does not arrive in the order that makes it easy: a bank statement is exported before
the provider's report is available, a settlement file is uploaded two days late, a webhook is
retried after both. Each order passes through states the canonical order never visits — a
credit that matches nothing yet, a payout with no promises to cover, a settlement line whose
promise has not been booked — and each of those raises a finding that must later clear itself.

## Decision

The harness applies a scenario's arrivals in a caller-supplied order, reconciling after each
one, and the suite asserts that every order reaches byte-identical balances and an identical
queue.

## Consequences

- If the final partition differed by order, the system would have a race rather than a
  reconciliation, and the answer would be whichever ordering happened to occur.
- Under a reversed order the suite observes findings raised and then closed with cause
  `evidence_arrived`, and asserts that every one closed for that reason rather than being
  resolved by a person or left open.
- Six orders are driven — canonical, reversed, and four seeded shuffles — not all 720. The
  shuffle seed is fixed and printed, so a failure is reproducible; the full factorial would
  multiply runtime for orderings that differ from one already tested only in the position of
  two independent files.
