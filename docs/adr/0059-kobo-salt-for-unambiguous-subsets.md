# 59. Generated amounts carry a kobo salt, so the matcher is never asked to guess

Date: 2026-08-19

## Status

Accepted

## Context

A payout is matched by finding the unique subset of promises summing to its gross, and the
matcher escalates when two subsets fit equally well. Amounts drawn naively collide: 5,000 +
15,000 and 8,000 + 12,000 are the same payout. A seed that happened to draw both would
escalate a payout that was going perfectly well, and the suite would fail for a reason that
is not a defect.

## Decision

Every promise the simulator generates is a whole-hundred-naira base plus a distinct
power-of-two kobo salt. Batches are capped at thirteen promises, because 2^13 - 1 = 8191 kobo
is the largest salt sum that still fits under 100 naira.

## Consequences

- A subset's total modulo 100 naira is the sum of its salts, which identifies the subset
  uniquely.
- Ambiguity is still tested, on purpose, in its own scenario, with the assertion that the
  matcher escalates rather than picking one. Making it impossible by accident and mandatory
  by intent is the difference between a suite that measures the engine and one that measures
  the seed.
- The base scenario cannot exceed thirteen promises per source pool. The generator throws,
  naming the seed, rather than silently producing an ambiguous day.
