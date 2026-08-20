# 25. No Paystack settlement adapter

Date: 2026-08-15

## Status

Accepted

## Context

Paystack's connector refuses to parse settlement exports until a sanitized real file pins
the column layout. Inventing a column mapping from documentation would produce a parser that
looks correct and is wrong, and a wrong settlement parser does not fail loudly — it books
the wrong amounts.

## Decision

`sourceProfile('paystack').settlement` is `null`, and `ingestSettlement('paystack', ...)`
throws `NoSettlementAdapterError`.

## Consequences

- Paystack's webhook half works fully; only its settlement half is unsupported, and it says
  so explicitly.
- Two genuinely different foreign shapes are still covered: Flutterwave (a JSON envelope
  with a nested data array) and Nomba (a bare array of records).
- To enable it: donate a sanitized export upstream, or write the adapter here against a real
  file. One entry in the source table changes.
