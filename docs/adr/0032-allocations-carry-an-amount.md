# 32. Allocation is an amount, so settlement can be partial and split

Date: 2026-08-16

## Status

Accepted

## Context

A provider can settle half a payment now and half when a dispute hold lifts, and one payout
can cover many payments. Under a flag-shaped design a half-settled payment has no
representation and is reported as a mismatch.

## Decision

`inflow_allocations` links a promise to an inflow with an amount. A deferred constraint
trigger enforces that a payment is never allocated beyond its receivable. A partly
discharged promise keeps its `authorized` state.

## Consequences

- Partial settlement and many-to-one settlement are both representable.
- The over-allocation check is in the database because without it two payouts could each
  claim the whole of one payment and the ledger would discharge the same receivable twice.
- Partial matching refuses to guess: taking part of a promise leaves the remainder open to
  be matched again later, so a payout smaller than any single receivable is allocated only
  when exactly one candidate could absorb it.
