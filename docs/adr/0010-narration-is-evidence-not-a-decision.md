# 10. Source narration is retained verbatim and never parsed for decisions

Date: 2026-08-15

## Status

Accepted

## Context

Settlement sources attach free-text narration to rows. It often contains information a
matcher would like — a reference, a reason, a batch name.

## Decision

`SettlementLine.reasonHints` keeps whatever narration a source attached, as free text. It is
shown in exception context and kept as evidence for a match. No matching decision may be
made by parsing it.

## Consequences

- Source-specific string patterns cannot leak downstream of the ingest boundary.
- Anything narration means must be lifted into a typed canonical field by the adapter that
  understands that source.
- The same rule is applied to bank narration in
  [ADR-0033](0033-content-addressed-evidence.md), where a parser extracts candidate tokens
  and the matcher resolves them against payouts it holds.
