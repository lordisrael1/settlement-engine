# 13. Canonical payment status adopts the upstream spelling

Date: 2026-08-15

## Status

Accepted — supersedes the naming half of [ADR-0009](0009-payment-status-ranking.md).

## Context

[ADR-0009](0009-payment-status-ranking.md) defined the status ordering independently, using
lowercase names. Reading `@pay-normalize/core` confirmed the same ordering under a different
spelling.

## Decision

`PaymentStatus` is `PENDING | FAILED | SUCCESSFUL | REVERSED`, character for character
identical to `TransactionStatus` in `@pay-normalize/core`.

## Consequences

- No mapping table at the boundary, and therefore nothing that can drift.
- The ordering from [ADR-0009](0009-payment-status-ranking.md) stands, now verified against
  the upstream table rather than assumed.
