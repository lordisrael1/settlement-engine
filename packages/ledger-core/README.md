# @recon/ledger-core

The double-entry engine, and the only path to writing money. It knows accounts, entries and
invariants. It knows nothing about a specific provider, HTTP or files.

**Depends on:** `@recon/canon`, `pg`. **Imported by:** `@recon/reconciler`,
`@recon/inbox`, `@recon/policy`, `apps/*`.

## Invariants live in the database

A check that exists only in TypeScript can be walked past by a migration script, a `psql`
session or a second service.

| Invariant | Enforcement | Where |
|---|---|---|
| Entries sum to zero | `DEFERRABLE INITIALLY DEFERRED` constraint trigger, fires at `COMMIT` | [0001_ledger.sql](migrations/0001_ledger.sql) |
| Append-only | `BEFORE UPDATE OR DELETE` triggers on the three history tables | same |
| Integer kobo | `BIGINT` columns; amounts passed as text and cast, never through a JS number | [post.ts](src/post.ts) |
| Idempotency | the primary key is the event's idempotency key; `ON CONFLICT DO NOTHING` | same |
| Cache equals recompute | `verifyBalances()` compares `account_balances` against `SUM(entries)` | [balance.ts](src/balance.ts) |

The sum-zero trigger is deferred because entries are inserted row by row: an immediate check
would fire on the first row and reject every balanced transaction. Deferring to `COMMIT`
lets it see the whole set, and because it still runs inside the committing transaction, an
unbalanced transaction cannot be persisted even under concurrency
([ADR-0015](../../docs/adr/0015-invariants-enforced-by-database-triggers.md)).

## Schema

    accounts ---------+
                      | FK
    ledger_transactions --< entries          signed BIGINT kobo
            |                  ^
            |                  +-- deferred trigger: SUM(amount_kobo) = 0 per transaction
            |
            +--< transaction_state_changes -> transaction_states (view: newest change wins)

    account_balances   the cache: the only mutable table, and the one the checks watch

`ledger_transactions` has no `state` column. Lifecycle state is derived from the append-only
change log ([ADR-0016](../../docs/adr/0016-lifecycle-state-is-derived.md)).

## API

    postTransaction(db, input)     the only way to write money; atomic and idempotent
    balance(db, accountId)         SUM(entries) — the definition, not an optimisation of it
    cachedBalance(db, accountId)   the shortcut, never trusted over balance()
    allBalances(db)
    verifyBalances(db)             where the cache disagrees with the entries
    verifyConservation(db)         every entry ever written, summed
    reverse(db, transactionId, at) a mirror-image transaction, never an edit
    transition(db, input)          append a lifecycle change; terminal states are terminal
    bookAuthorizedPayment(db, payment, at)
    runMigrations(pool, dirs)      apply .sql files once, checksum-verified
    replay(db), rebuildBalancesFromEvents(db)

`postTransaction` is the mechanism: it writes any balanced set of entries.
[`bookings.ts`](src/bookings.ts) is the policy: which accounts an economic event touches.
Both belong here, because both are statements about our chart of accounts
([ADR-0021](../../docs/adr/0021-chart-of-accounts-policy-lives-in-ledger-core.md)).

`reverse()` is an exact negation and nothing more. Booking a refund as contra-income is a
domain decision belonging to the reconciler
([ADR-0024](../../docs/adr/0024-reverse-is-an-exact-negation.md)).

## Tests

`ledger.test.ts` needs a real Postgres, because the invariants it checks are enforced by
Postgres. It skips itself when `DATABASE_URL` is unset.

    docker compose up -d postgres
    DATABASE_URL=postgres://recon:recon@localhost:5432/recon npm test

The property test asserts that across roughly 1,200 random valid transactions every cached
balance equals its recomputed balance and the ledger still sums to zero. Tune with
`LEDGER_PROPERTY_RUNS`.
