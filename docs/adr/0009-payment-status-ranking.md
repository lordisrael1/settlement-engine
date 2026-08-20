# 9. Payment status has a total order, defined in the canonical package

Date: 2026-08-15

## Status

Accepted — the naming half superseded by [ADR-0013](0013-canonical-status-spelling.md).

## Context

Webhooks arrive out of order. The final status of a payment must not depend on the order in
which its notifications were delivered.

## Decision

`packages/canon/src/payment.ts` defines `pending(0) < failed(1) < success(2) < reversed(3)`,
with a higher rank superseding a lower one.

## Consequences

- The ordering is part of the canonical language rather than an ingest implementation detail.
- `reversed` outranks `success` because a reversal is always later news than the success it
  undoes. `success` outranks `failed` because a success notification for a reference thought
  to have failed is a real outcome, while a late failure notice for a reference that
  succeeded is stale.
- `pay-normalize` has its own ranking table. The two are reconciled to one definition in
  [ADR-0013](0013-canonical-status-spelling.md); two ranking tables that can disagree is a
  determinism bug.
