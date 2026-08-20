# 30. Fee contracts are versioned data, not a function

Date: 2026-08-16

## Status

Accepted — supersedes the fee half of
[ADR-0026](0026-deadline-windows-and-nullable-rate-cards.md).

## Context

A single rate constant cannot do three things: reconcile a past period at that period's
rates, separate VAT from the provider's fee, or say who approved a rate and when.

## Decision

`FeeContract` carries `effectiveFrom`/`effectiveTo`, a merchant, a VAT rate and an approver.
`FeeModel` is `(gross, at) => FeeBreakdown | null`. Contracts live in `fee_contracts` with a
`btree_gist` exclusion constraint forbidding overlap.

## Consequences

- Reconciling last quarter uses last quarter's rates. Applying a renegotiated card to older
  payments would invent a fee variance on each of them.
- VAT is its own deduction, bound for the tax authority rather than the provider.
- A rate is an assertion somebody approved, so "why did we expect 1.4%?" has an answer with
  a name and a date.
- Overlap is a database constraint rather than a read-time tie-break, because two contracts
  in force at once makes fee expectations non-deterministic.
- Contract administration and an approval workflow are now required. Published rate cards
  remain as seeds with `approvedBy: 'published-rate-card'` — a list price, not an agreement
  anyone signed, and the queue can tell the difference.
