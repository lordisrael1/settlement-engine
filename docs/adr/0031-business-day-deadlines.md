# 31. Deadlines are business days and cut-offs, not fixed minutes

Date: 2026-08-16

## Status

Accepted — supersedes [ADR-0008](0008-settlement-window-models-a-deadline.md) and the window
half of [ADR-0026](0026-deadline-windows-and-nullable-rate-cards.md).

## Context

T+1 is a business rule. A card payment taken at 6pm on the Friday of a long weekend is not
overdue on Saturday evening, and a system that says so raises an exception every weekend
until the queue stops being read.

## Decision

`BusinessCalendar` replaces `SettlementWindow`: a cut-off time, a count of business days,
weekends, Nigerian public holidays, and a grace period. `deadlineMinutes` is removed.

## Consequences

- Cut-off and grace are separate: the deadline is when money was expected, grace is how long
  its absence is tolerated. Conflating them is what made the old fixed window need padding
  to T+2, which in turn made genuinely late money invisible for an extra day.
- Holiday tables go stale, and two Nigerian holidays move with the lunar calendar and are
  announced days ahead. The failure is visible and mild: a settlement that was never late
  gets flagged.
