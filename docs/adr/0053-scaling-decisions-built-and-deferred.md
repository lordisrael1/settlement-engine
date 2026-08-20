# 53. Structural scaling concerns are built now; capacity tuning is deferred

Date: 2026-08-18

## Status

Accepted

## Context

High-volume operation has two halves. One is architecture that cannot be retrofitted without
changing interfaces. The other is tuning against a workload nobody has measured yet.

## Decision

Build the structural half now and defer the tuning.

Built: durable acceptance separated from interpretation
([ADR-0050](0050-webhooks-accepted-durably.md)); idempotency at every entry point, keyed by
content or by the event's own id; claim-and-work with `SKIP LOCKED`, so adding a worker is
starting a process; stateless request handling, so the service scales by replica count; and a
bounded reconciliation run, because subset-sum batching over an unbounded set of open
promises does not return.

Deferred: time-based partitioning of `entries`, `events` and `webhook_inbox`; indexes shaped
to the queries a real dashboard turns out to run; connection-pool sizing and a pooler; and
load tests with realistic duplicate, delayed and out-of-order traffic.

## Consequences

- `account_balances` holds one row per account and every posting updates it. At high write
  rates that row is a lock hotspot: `bank_account` would serialise every settlement booking.
  The escape route is already built — the balance table is a projection, it is checked
  against the entries, and `rebuildBalancesFromEvents` rebuilds it from the log — so the fix
  is to stop updating it synchronously and rebuild it on a schedule, with no change to the
  ledger.
- Every deferred item changes one thing: a table's storage, an index, a pool size, or when a
  projection is refreshed. None touches an invariant, a canonical type, or an interface
  between packages.
