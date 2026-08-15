# @recon/ledger-core — Phase 1 ✅

**The engine that is correct about money.** The pure, source-agnostic double-entry core.
It knows accounts, entries, and invariants. It knows nothing about Paystack, HTTP, or
files — and must never learn.

Because it is the only path to writing money, no other layer can violate Law 1. They have
to come through here.

**Depends on:** `@recon/canon`, `pg`.
**Imported by:** `@recon/reconciler` (Phase 3), `apps/*`.

## The invariants live in the database, not in this code

This is the load-bearing decision of the whole phase. A check that exists only in
TypeScript is a check that a migration script, a `psql` session, or a second service can
walk straight past.

| Law | Enforcement | Where |
|---|---|---|
| **1** — entries sum to zero | `DEFERRABLE INITIALLY DEFERRED` constraint trigger, fires at `COMMIT` | [0001_ledger.sql](migrations/0001_ledger.sql) |
| **2** — append-only | `BEFORE UPDATE OR DELETE` triggers that raise on the three history tables | same |
| **3** — integer kobo | `BIGINT` columns; amounts passed as text and cast, never through a JS number | [post.ts](src/post.ts) |
| **4** — idempotency | the primary key *is* the event's idempotency key; `ON CONFLICT DO NOTHING` | same |
| **6** — cache == recompute | `verifyBalances()` compares `account_balances` against `SUM(entries)` | [balance.ts](src/balance.ts) |

The Law 1 trigger is **deferred** for a reason: a transaction's entries are inserted row
by row, so an immediate check would fire on the first row and reject every balanced
transaction ever written. Deferring to `COMMIT` lets it see the whole set — and because
it still runs inside the committing transaction, an unbalanced transaction cannot be
persisted even under concurrency.

## The shape of the schema

```
accounts ─────────┐
                  │ FK
ledger_transactions ──< entries            (money: BIGINT kobo, signed)
        │                  ↑
        │                  └── deferred trigger: SUM(amount_kobo) = 0 per transaction
        │
        └──< transaction_state_changes  →  transaction_states  (VIEW: newest change wins)

account_balances   the cache — the only mutable table, and the only one Law 6 watches
```

Note what is **absent**: a `state` column on `ledger_transactions`. Lifecycle state is
derived from the append-only change log, because a mutable state column would mean an
`UPDATE`, and `UPDATE`s are how history gets quietly rewritten.

## API

```ts
postTransaction(db, input)     // the only way to write money. Atomic, idempotent.
balance(db, accountId)         // SUM(entries). The definition, not an optimisation of one.
cachedBalance(db, accountId)   // the shortcut. Never trusted over balance().
allBalances(db)
verifyBalances(db)             // Law 6: where the cache disagrees with the entries
verifyConservation(db)         // Law 1 across the whole ledger: every entry ever, summed
reverse(db, transactionId, at) // a mirror-image transaction. Never an edit.
transition(db, input)          // append a lifecycle change; terminal states are terminal
bookAuthorizedPayment(db, payment, at)  // the chart-of-accounts policy (see below)
runMigrations(pool, dirs)      // apply .sql files once, checksum-verified
```

### Mechanism vs. policy

`postTransaction` is the **mechanism** — it faithfully writes any balanced set of entries.
[`bookings.ts`](src/bookings.ts) is the **policy**: which accounts a given economic event
touches. Both belong here, because both are statements about our chart of accounts, and
neither has any idea which PSP an event came from.

`bookAuthorizedPayment` books revenue at **gross** and no fee at all, because at that
moment the fee is genuinely unknown. See
[DECISIONS.md § D-004](../../docs/DECISIONS.md).

### `reverse()` is an exact negation

It is the mechanical Law 2 primitive: every amount negated, nothing touched. Booking a
refund as contra-income against the `reversals` account is a different, domain-level
decision that belongs to the reconciler, which composes it from `postTransaction`
directly.

## Tests

`ledger.test.ts` needs a real Postgres, because the invariants it checks are enforced by
Postgres — mocking the database here would test the mock's willingness to agree with us.
The suite skips itself cleanly when `DATABASE_URL` is unset.

```bash
docker compose up -d postgres
DATABASE_URL=postgres://recon:recon@localhost:5432/recon npm test
```

The property test is Phase 1's exit criterion: across ~1,200 random valid transactions,
every account's cached balance equals its recomputed balance and the whole ledger still
sums to zero. Tune with `LEDGER_PROPERTY_RUNS`.

See [the bible, Phase 1](../../docs/RECONCILIATION-BIBLE.md#phase-1--the-ledger-core-the-double-entry-engine).
