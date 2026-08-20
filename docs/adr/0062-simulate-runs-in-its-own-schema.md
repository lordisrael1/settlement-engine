# 62. simulate runs in a schema of its own

Date: 2026-08-19

## Status

Accepted

## Context

The `simulate` command prints every account balance against what the scenario's own
arithmetic says it should be. That is an absolute claim, and an absolute claim about a ledger
is only meaningful if nothing else has written to it.

Run against the shared schema it measured whatever else was there, and two seeds could not
coexist at all: each scenario's fee contracts occupy the same scope with the same dates, so
seeding a second seed's contracts on top of a first raises `fee_contracts_no_overlap`.

## Decision

`simulate` creates, drops and rebuilds a schema named after its seed — `simulator_seed_42` —
migrates it, and runs there. It does not touch the default schema.

## Consequences

- The exclusion constraint was correct and the command was wrong. Widening the contract scope
  or making contract ids merchant-unique would have worked around a constraint that exists to
  prevent exactly that data error.
- Named rather than random, so the books can be opened afterwards with
  `psql -c 'SET search_path = simulator_seed_42'`.
- Dropped and rebuilt at the start, so the second run of a seed is the same scenario rather
  than the same scenario on top of the previous one.
