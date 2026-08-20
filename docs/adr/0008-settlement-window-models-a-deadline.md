# 8. SettlementWindow models a deadline only

Date: 2026-08-15

## Status

Superseded by [ADR-0031](0031-business-day-deadlines.md).

## Context

Settlement timing is often described as a range — "T+1 to T+2". Every use of that timing in
this system asks one question: is this promise overdue?

## Decision

`SettlementWindow = { deadlineMinutes: number }` — an upper bound only.

## Consequences

- Money arriving earlier than expected is still money, and matching it early is not an
  error, so a lower bound would be a field nothing reads.
- Suspiciously early settlement cannot be flagged. If that becomes a signal worth raising,
  a lower bound arrives with a reason code and a consumer.
