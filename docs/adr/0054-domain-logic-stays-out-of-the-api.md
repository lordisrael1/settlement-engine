# 54. Summarising and resolving live in the reconciler, not in route handlers

Date: 2026-08-18

## Status

Accepted

## Context

Two pieces of domain logic nearly landed in the HTTP layer: the period summary, and the
exception-resolution flow.

## Decision

`summarize()` and `resolveException()` live in `@recon/reconciler`. The API layer keeps the
mapping from HTTP to those calls, the serialisation of the answers, and the mapping from a
domain refusal to a status code.

## Consequences

- A period summary groups reason codes into matched, explained and exceptions, and that
  grouping is `reasonKind` in `canon`. Writing it as a `CASE` in a route's SQL would create a
  second copy of the taxonomy — and the copy in the route is the one nobody would update.
- Resolving is three writes: a decision, a compensating entry, and the closing of a queue
  item. Sequencing them in a handler would put the atomicity of a financial correction in the
  transport layer, where a thrown error between the second and third leaves an entry posted
  whose justification never saved.
- The API does own real concerns: `bigint` crossing as a decimal string and never as a JSON
  number, since a JSON number is a double; `UnknownSourceError` as 404,
  `NoSettlementAdapterError` as 501, and a domain refusal as 422 carrying the engine's own
  message; and an unmapped error as a 500 with a log line rather than a stack trace on the
  wire.
- Every handler stays at parse, call one package function, serialise. A status code that
  needs a condition on an account or a source means domain logic has begun leaking upward.
