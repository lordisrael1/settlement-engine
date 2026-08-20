# 22. A CLI deployable is built before the HTTP service

Date: 2026-08-15

## Status

Accepted

## Context

Containerisation was required before the HTTP service existed, and a container needs a
program to run.

## Decision

Build `apps/pipeline`, a CLI over the same libraries — `migrate`, `demo`, `balances`,
`verify`, `ingest-settlement` — as the first deployable.

## Consequences

- The smallest deployable that exercises the ledger and ingest layers end to end, respecting
  the library/deployable split.
- It is not a stopgap. When `apps/api` arrived it joined this deployable rather than
  replacing it: a service for traffic and a CLI for operators, over one set of libraries.
  Nothing under `packages/` changed when the service landed.
