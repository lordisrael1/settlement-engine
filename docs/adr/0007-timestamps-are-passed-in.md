# 7. Timestamps are Date, and the current time is always an argument

Date: 2026-08-15

## Status

Accepted

## Context

Reconciliation must be deterministic: the same ordered inputs must produce the same
partition and the same balances, or replay and audit prove nothing.

## Decision

Canonical types carry `Date`, and every function whose answer depends on the current time
takes an explicit `asOf: Date`. No function in the core calls `new Date()`.

## Consequences

- Settlement-window logic is testable without waiting for a day to pass.
- A reconciliation run can be replayed and reach the same answer.
- ISO-8601 strings were rejected: every window calculation would parse them back to a `Date`,
  moving the cost rather than removing it. Serialising `Date` and `bigint` is the API
  layer's concern, at the boundary.
