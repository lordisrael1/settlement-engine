# 19. SettlementLine.settledAt is nullable

Date: 2026-08-15

## Status

Accepted

## Context

Not every source discloses when the money moved.

## Decision

`settledAt` is `Date | null`, mirroring the upstream `settlementDate`.

## Consequences

- The record states the truth: this source reported money moved, but not when. The matcher
  reasons with the promise's timestamp instead.
- Defaulting to the transaction's own timestamp was rejected: it fabricates a settlement date
  that reads as authoritative.
- Rejecting the row was rejected: it discards real money over a missing field.
