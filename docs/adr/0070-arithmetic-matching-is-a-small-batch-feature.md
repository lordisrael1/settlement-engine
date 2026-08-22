# 70. Arithmetic-only matching is a small-batch feature, and says so

Date: 2026-08-22

## Status

Accepted — makes explicit a limit ADR-0053 deferred and PERFORMANCE.md alluded to

## Context

Subset-sum is bounded on purpose. ADR-0035 explains why it refuses to guess and
`DEFAULT_SUBSET_LIMITS` bounds the search so a pathological settlement file cannot stall a
run. Both are right.

The number was the problem, and more precisely the *silence* around it.

`maxCandidates` is 24. A busy merchant's daily payout routinely covers 50–500 charges. For any
provider that reports a payout total without per-line references — which is the exact case
the subset engine exists for — a batch over 24 could never be solved. Not "was hard to solve":
could not be attempted.

Worse, the search did not say so. It sliced the candidate pool down to the limit and searched
what was left:

```ts
const pool = items.filter(...).slice(0, limits.maxCandidates);
```

A truncated search that finds nothing reports `none`, and `none` is the answer that produces
`PHANTOM_CREDIT` — a queue entry asserting that no combination of our promises adds up to this
payout, with a `considered` list of near-misses and `amount_differs` beside each one. Every
word of that is a claim about arithmetic that was never performed. A person reads it and goes
looking for a missing webhook that is not missing.

The engine is saved today only because every PSP this repository has an adapter for ships
itemised settlement files, so the reference path carries the volume and the arithmetic path is
a fallback for the residue. But that makes the fallback effectively unusable at scale, and the
day a provider ships coarse files, every large payout escalates as a mystery.

## Decision

**The search refuses rather than truncates.** `uniqueSubsetSummingTo` returns a fourth
outcome, `not_attempted`, carrying the candidate count and the limit, when the pool is larger
than `maxCandidates`. The `.slice()` is gone.

**The refusal has its own reason code.** `BATCH_TOO_LARGE`, an exception, severity 2 — ranked
above lateness because nothing else will ever resolve it. Unlike a T+1 straggler, no later
evidence makes it clear itself: either the batch shrinks, the bound is raised, or a human
matches it by hand.

**The rejected candidates say they were not compared.** A new `RejectionReason`,
`not_attempted`, and a `considered` list built by `unattemptedPromises` — largest first, since
the only useful thing to show about a batch too big to solve is what its biggest pieces were.
Reusing `nearestPromises` here would have put `amount_differs` beside candidates nothing ever
compared, which is the original lie in a smaller form.

**The bound is configuration.** `RECON_SUBSET_MAX_CANDIDATES`, `RECON_SUBSET_MAX_SIZE` and
`RECON_SUBSET_MAX_STEPS`, passed through to every run the service makes. A deployment whose
provider ships coarse files can raise it knowingly.

**The cost of raising it is stated rather than discovered.** The search is exponential in the
candidate count; `maxSteps` is what actually stops it. Raising candidates without raising
steps buys `undecidable` rather than answers, which escalates just the same — differently
worded, equally unmatched. PERFORMANCE.md carries the measurement.

**And it is written down that this is a small-batch feature.** In `DEFAULT_SUBSET_LIMITS`'
own documentation, in the README's limitations, and here.

## Consequences

A payout too large for the bound now produces a queue entry that says what actually happened.
That is the whole change in practice, and it is the difference between five minutes and an
afternoon for whoever picks it up.

Deployments that relied on the truncated search accidentally finding an answer will see those
answers stop. There were no such deployments — a truncated search that finds a unique subset
has found a subset of an arbitrary prefix, which was never a defensible match — but it is a
behaviour change and worth naming.

The queue can now hold `BATCH_TOO_LARGE` entries that will never self-clear. That is honest:
they are not stragglers, and pretending they might resolve themselves is how a queue fills
with entries nobody triages.

This does not make arithmetic-only matching work at scale. It makes its ceiling visible, and
movable. Making it actually work at 500 candidates is a different algorithm — a
meet-in-the-middle search, or exploiting that real payouts batch contiguous time ranges — and
neither is worth building before a provider needs it.
