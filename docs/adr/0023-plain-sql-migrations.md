# 23. Plain SQL migrations with a checksum-verifying runner

Date: 2026-08-15

## Status

Accepted — supersedes [ADR-0011](0011-no-test-harness-in-canon.md).

## Context

The schema needs ordering and once-only semantics. A migration framework would add a CLI, a
config file and a second file format to provide them.

## Decision

Numbered `.sql` files and a small runner. Each file runs once, in its own transaction, and
its SHA-256 is recorded.

## Consequences

- Editing an applied migration is a loud error instead of a silent no-op, so the schema in
  front of you is the schema that was built.
- `runMigrations` takes a list of directories, so each package owns its migrations without a
  shared numbering authority. Colliding filenames are rejected with an explanation.
- `syncAccounts` re-seeds the `accounts` table from `CHART_OF_ACCOUNTS` on every run, making
  the TypeScript constant the source of truth and the table a projection of it.
- The test harness arrived with the ledger core: `node --test` with no runner dependency,
  plus `fast-check` for the property test.
