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
    bookReversal(db, event, promise)          whole or partial; only a whole one ends the promise
    bookReserveRelease(db, confirmation, returned)   the one credit that discharges nothing
    runMigrations(pool, dirs)      apply .sql files once, checksum-verified
    replay(db), rebuildBalancesFromEvents(db)

`postTransaction` is the mechanism: it writes any balanced set of entries.
[`bookings.ts`](src/bookings.ts) is the policy: which accounts an economic event touches.
Both belong here, because both are statements about our chart of accounts
([ADR-0021](../../docs/adr/0021-chart-of-accounts-policy-lives-in-ledger-core.md)).

`reverse()` is an exact negation and nothing more. Booking a refund as contra-income is a
domain decision belonging to the reconciler
([ADR-0024](../../docs/adr/0024-reverse-is-an-exact-negation.md)).

`bookReversal` handles a refund of **part** of a payment: when the amount coming back is less
than the receivable, it books the entries for that part and leaves the promise `authorized`,
because the PSP still owes us the rest and a payout is still coming for it. Transitioning to
`reversed` on a ₦3,000 refund against a ₦10,000 charge would close a promise that is ₦7,000
alive, and the ₦7,000 would resurface later as a settlement matching nothing
([ADR-0069](../../docs/adr/0069-partial-refunds-and-chargebacks.md)). It is the same test
`bookBankConfirmedSettlement` already applies to a part-settled promise, in the other
direction.

`bookReserveRelease` is the one bank credit that discharges no receivable: a rolling reserve
coming back moves `psp_reserve` into `bank_account` and closes nothing, because nothing new was
earned. It cannot go through `bookBankConfirmedSettlement`, which refuses an empty discharge
list — correctly, since money with nothing to discharge is otherwise a phantom credit
([ADR-0071](../../docs/adr/0071-reserves-carry-a-deadline.md)).

`postTransaction` sorts its per-account balance upserts by account id. Each upsert takes a row
lock, and two concurrent transactions taking the same locks in different orders deadlock — which
was reachable without any exotic concurrency, since a settlement confirmation touched its
accounts in the order the PSP itemised its deductions. A fixed order removes the deadlock class
entirely. It does nothing for *contention* on `psp_receivable`, which is a design property of
the cache rather than something an index fixes
([ADR-0073](../../docs/adr/0073-retries-back-off-and-secrets-overlap.md), ADR-0053).

## Tests

`ledger.test.ts` needs a real Postgres, because the invariants it checks are enforced by
Postgres. It skips itself when `DATABASE_URL` is unset.

    docker compose up -d postgres
    DATABASE_URL=postgres://recon:recon@localhost:5432/recon npm test

The property test asserts that across roughly 1,200 random valid transactions every cached
balance equals its recomputed balance and the ledger still sums to zero. Tune with
`LEDGER_PROPERTY_RUNS`.
