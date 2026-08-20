# 49. The product database is not a fourth record

Date: 2026-08-18

## Status

Accepted

## Context

A reconciliation is an argument between records produced by different parties about the same
money. The company's own user and order database did not touch the money: it recorded an
intention before the payment and knows nothing about what settled.

## Decision

Three rails enter this system, and the product database is none of them. It contributes one
thing — the stable mapping between an internal payment id, the provider's reference and the
merchant — and that travels as `reference` and `merchantId` on records already held. No
customer, order, email, phone or subscription row is copied here.

## Consequences

- Admitting it as a fourth record would add a fourth opinion held by the one participant with
  no independent knowledge, and every disagreement it produced would be about our own
  bookkeeping rather than about the money.
- A system whose job is proving money movement holds as little else as possible.
  `evidence.raw` already stores whole settlement exports and bank statements; a PII mirror
  beside it would multiply the consequences of a leak in exchange for a join the application
  can already do on a reference.
- "Which order was this?" is answered by joining on the reference this system stores.
