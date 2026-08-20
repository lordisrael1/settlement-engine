# Contributing

## Getting set up

    npm install
    npm run build
    npm test

Tests that need a database skip themselves when `DATABASE_URL` is unset. To run everything:

    docker compose up -d postgres
    DATABASE_URL=postgres://recon:recon@localhost:5432/recon npm test

Read [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) and
[docs/DOMAIN-MODEL.md](docs/DOMAIN-MODEL.md) before making a structural change, and check
[docs/adr/](docs/adr/README.md) for whether the question has already been decided.

## Engineering rules

- **Do not preserve backward compatibility.** Remove obsolete paths instead of adding
  compatibility layers, fallbacks or shims.
- **Choose the simplest implementation that fully meets the current requirement.** Avoid
  speculative abstractions, configuration and indirection.
- **Grow the system in layers.** Start from the smallest version that works end to end, and
  add each capability on top of something that already works.
- **Keep components modular and concerns separated.**
- **Prefer established libraries** where they reduce complexity or improve reliability, and
  lean on the dependencies already here before adding more. Check a library's documentation
  and types before assuming it lacks a capability.
- **Make decisions for the long term.** Do not accept a stopgap that is meant to be
  replaced later.

## Domain rules

These are enforced in code, ideally in the database, and are not suspended for a special
case.

- **Every ledger transaction's entries sum to exactly zero.** A write that does not balance
  is rejected inside the same database transaction as the write.
- **Entries and transactions are append-only.** Correct a mistake with a new compensating
  transaction, never an `UPDATE` or a `DELETE`.
- **Money is integer kobo** — `bigint` in TypeScript, `BIGINT` in Postgres. Never a float,
  never a decimal string parsed as a number. Conversion from a source's representation
  happens exactly once, in `packages/ingest`.
- **The same real-world event entering twice has the effect of entering once.** Every
  inbound event carries a natural idempotency key, and the key is the primary key.
- **Nothing in a write path reads the wall clock or generates a random id.** `asOf` is
  always an argument, so a run can be replayed to the same answer.
- **A balance is derived.** The cache exists for speed and is checked against the
  recomputation.
- **Only bank evidence may increase `bank_account`.** A provider's settlement report books
  nothing.
- **`if (source === 'paystack')` must never appear downstream of `packages/ingest`.**
  Per-source variation travels as data — a fee model, a calendar — never as a branch.

## Structure

`packages/*` are libraries: they are imported, they do not run. `apps/*` are deployables:
they have an entry point and bind a port. Dependencies point one way only, toward
`packages/canon`, and there are no cycles.

Business logic does not belong in `apps/api`. A route handler parses the request, calls one
package function and serialises the answer.

## Decision records

Record every non-obvious decision in [docs/adr/](docs/adr/README.md), following the template
the existing records use: context, decision, consequences. Take the next number in sequence.

Records are immutable once merged. A decision that changes is superseded by a new record
that says so; the old record keeps its number, and its status line points at the replacement.

## Migrations

Migrations are numbered `.sql` files under each package's `migrations/` directory. Each runs
once, in its own transaction, and its checksum is recorded — editing an applied migration is
an error, not a silent no-op. Add a new file rather than changing an old one.
