# 55. The policy join is a package, because two deployables need it

Date: 2026-08-18

## Status

Accepted

## Context

The matcher needs a business calendar and a fee model per source. The calendar is declared by
`ingest`, beside the adapter that knows the rail; the contracts are administered data in the
database. The reconciler may import neither — the moment it can reach a source table it can
branch on a source name — so something has to join them.

## Decision

`buildPolicy` moved from `apps/pipeline/src/policy.ts` into `@recon/policy`, imported by both
deployables. It is the only package that imports both `ingest` and `reconciler`.

## Consequences

- The joiner is allowed to import both precisely because it decides nothing: it fetches, it
  joins, it hands over a lookup.
- Two copies of the join that decides how long to wait before calling money late is two
  copies that can disagree, with the API and the CLI reconciling the same database to
  different answers.
- A package for one function, whose dependency shape — imports several packages, imported
  only by deployables — otherwise resembles an application. That is stated in its README so
  it is not mistaken for a mistake.
