# AGENTS.md

- Do not preserve backward compatibility. Remove obsolete paths instead of adding compatibility layers, fallbacks, or migrations.
- Choose the simplest implementation that fully meets the current requirements. Avoid speculative abstractions, configuration, and indirection.
- Grow the system in layers. Start from the smallest version that works end to end, and add each new capability on top of a product that already works. Never trade a working product for unfinished complexity.
- Keep components modular and concerns clearly separated.
- Prefer established, well-maintained libraries when they reduce overall complexity or improve reliability. Do not reimplement common functionality without a clear reason.
- Lean on the dependencies already in the project before writing your own implementation or adding packages. Do not assume a library lacks a capability without checking its documentation and types.
- Make architectural decisions for the long term. Do not accept a stopgap that only works for now and is meant to be replaced later.

## Project-specific rules

This repository is a Nigerian fintech reconciliation engine. Its design doctrine is not
optional context — it is the specification.

- Read [docs/RECONCILIATION-BIBLE.md](docs/RECONCILIATION-BIBLE.md) before making design decisions.
  Part I defines seven Laws. They are enforced in code, ideally at the database level,
  and are never suspended "just this once."
- Build the phases in order. Do not begin a phase until the previous phase's exit
  criterion is met.
- Money is **integer kobo** (`bigint` in TypeScript, `BIGINT` in Postgres). Never float,
  never a decimal string parsed as a number. Conversion from a source's representation
  happens exactly once, in the ingest layer.
- Every ledger transaction's entries sum to exactly zero. A write that does not balance
  is rejected inside the same database transaction as the write.
- Entries and transactions are append-only. Correct a mistake with a new compensating
  transaction, never an `UPDATE` or `DELETE`.
- `if (source === 'paystack')` must never appear downstream of `packages/ingest`.
  Per-source variation is carried as *data* (fee model, settlement window), never as a branch.
- Record every non-obvious decision in [docs/DECISIONS.md](docs/DECISIONS.md) with its reasoning.

## Layout

`packages/*` are libraries — they are imported, they do not run.
`apps/*` are deployables — they have an entry point and bind a port.
Dependencies point one way only, downward toward `packages/canon`. No cycles.
See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).
