# 11. The canonical package ships without tests

Date: 2026-08-15

## Status

Superseded by [ADR-0023](0023-plain-sql-migrations.md) — the harness arrived with the ledger.

## Context

`packages/canon` is type definitions and constants with almost no behaviour.

## Decision

`packages/canon` ships with no tests. The compiler is its check.

## Consequences

- No test harness exists until there is behaviour worth asserting.
- The harness arrives with the ledger core, including the property test that balances and
  conservation hold across thousands of random transactions.
