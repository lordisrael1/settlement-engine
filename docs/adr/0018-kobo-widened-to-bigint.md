# 18. Upstream kobo is a number; canonical kobo is a bigint

Date: 2026-08-15

## Status

Accepted

## Context

`@pay-normalize/core` represents kobo as a branded `number` guarded against exceeding
`MAX_SAFE_INTEGER`. This system stores `BIGINT` and keeps no ceiling.

## Decision

`toMoney()` in `packages/ingest/src/kobo.ts` is the single place a connector amount becomes
canonical `Money`.

## Consequences

- Widening a safe integer to `bigint` is exact, so nothing is lost.
- The hard part — never letting a float touch money — is done upstream with string and
  BigInt parsing, so this is a representation change guarded by one assertion that catches a
  non-integer escaping the library's guarantees.
