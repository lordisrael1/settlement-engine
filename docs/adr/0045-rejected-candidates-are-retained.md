# 45. The matcher keeps the candidates it rejected

Date: 2026-08-17

## Status

Accepted

## Context

"12,000 naira credited, matches nothing" is a mystery an operator has to reconstruct from
scratch. The matcher has already done that work while failing to match.

## Decision

`MatchResult.considered` carries up to four near-misses, each with the amount it was out by
and why it lost — `amount_differs`, `outside_window`, `already_claimed`, `ambiguous`,
`wrong_state`. It is persisted with the exception.

## Consequences

- An exception arrives as a decision an operator can make now rather than an investigation
  they must start.
- The list is bounded at four: every open inflow is a haystack, not an explanation, and a
  queue entry has to stay readable at a glance.
- A little more work on the failure path and a JSONB column, both paid only when something is
  already wrong.
