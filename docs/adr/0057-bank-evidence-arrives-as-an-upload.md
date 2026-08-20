# 57. Bank evidence arrives as an uploaded statement; a feed is an adapter behind the same boundary

Date: 2026-08-18

## Status

Accepted

## Context

Direct corporate-bank integrations and open-banking aggregators exist in Nigeria, but
coverage, freshness and field completeness are integration-specific facts about a particular
bank and provider. A statement export works at every bank on the first day, with no consent
flow, vendor or per-bank certification, and produces the same canonical records a feed would.

## Decision

The only bank rail built is `POST /ingest/bank`, taking a statement export as bytes. When a
feed is added it goes behind the same boundary: bytes or records in, an `Evidence` record
with a hash and a parser version out, canonical `BankStatementLine`s after that, and nothing
downstream learning where they came from.

## Consequences

- A feed must model data availability, not just transactions. Aggregators report states such
  as `PARTIAL` and `UNAVAILABLE`. A reconciler handed a partial day and told nothing would
  conclude that money we were paid never arrived, raise `MISSING_SETTLEMENT` against healthy
  payouts, and let self-clearing close real exceptions whose explaining credits were simply
  outside the window it was given. So the adapter must carry that state through as data, and
  a run over incomplete evidence must be scoped rather than treated as a run over everything.
- In a multi-merchant deployment it is each merchant's finance admin who links their
  corporate account, once. Paying customers never do. The account being read is our own,
  which is what makes its statement the only evidence that may book cash.
- Somebody exports and uploads a statement daily. It is idempotent by content address, so a
  double upload and a re-upload after a parser fix are both free, but it is a human step.
