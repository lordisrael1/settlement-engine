# 44. The exception queue clears itself by diffing each run against what is open

Date: 2026-08-17

## Status

Accepted

## Context

A T+1 straggler should sit as pending, escalate when its window passes, and clear itself when
the settlement file lands, with nobody alerted. Without a diff, the queue only ever grows.

## Decision

After each run, exceptions the run no longer finds are resolved with cause
`evidence_arrived`. Closure is scoped by subject kind, so a run that had nothing to say about
a subject does not close its problems.

## Consequences

- `exception_events` refuses a resolution with no cause, by constraint. That field is what
  lets the table answer how much of the queue clears itself: a high number means the calendar
  is tuned correctly, a low one means either the calendar is wrong or something real is
  happening.
- `evidence_arrived` and `resolved_by_human` are separate causes, because conflating them
  would hide how much human time the queue costs.
- Treating silence as resolution would close problems that are still real, so a partial run
  must narrow its scope; the parameter exists for that.
