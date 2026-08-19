# apps/pipeline — the CLI deployable

Everything under `packages/` is a library that cannot run on its own. This is a process you
start: it opens a database connection, dispatches a command, and prints. It owns no
business logic — every decision it appears to make is delegated to a package.

**Depends on:** every package. **Depended on by:** nothing. That shape — depends on
everything, depended on by nothing — is the signature of a deployable.

## Why it exists beside `apps/api`

It came first: Phase 7 asked for a container, a container needs something to run, and the
Fastify service was three phases away. The service **joined** it rather than replacing it,
exactly as [D-022](../../docs/DECISIONS.md) said it would — a service for the traffic, a CLI
for the operator, over one set of libraries. Nothing inside `packages/` changed when it
landed.

The CLI is still the right tool for what a service is the wrong tool for: a scheduled
`replay` proving the books rebuild from the log, a one-off ingest of a file on somebody's
laptop, the narrated `demo`, and `simulate` — Phase 8's adversary with its answer printed
rather than asserted, because "158 tests pass" and "here is the day it survived" are
different kinds of evidence and only the second one can be watched.

## Commands

```bash
migrate                            apply every migration once, checksum-verified
demo                               the whole system, end to end, with commentary
simulate [seed] [--reverse]        a generated messy day, driven and checked against its
                                   own declared arithmetic; --reverse delivers the bank
                                   statements before the reports that explain them
balances                           current balances, derived from entries
verify                             Law 6 and Law 1, checked right now
replay [--rebuild]                 fold the event log from genesis and check every
                                   projection against it; --rebuild discards the cache first
ingest-settlement <source> <file>  a PSP's claim   — stored, and books nothing
ingest-bank <file> [bank-id]       our bank's proof — the only evidence that can book cash
reconcile                          stage 2 (allocate), then stage 3 (confirm)
exceptions                         the queue, worst first, with the rejected candidates
```

Run any of them against the composed system:

```bash
docker compose run --rm cli node apps/pipeline/dist/main.js balances
```

## The demo

Eighteen steps, on real payload shapes, against real Postgres. The spine of it:

1. Signed webhooks from two providers — two signature schemes, one canonical promise
2. A redelivery changes nothing — **Law 4**
3. An unbalanced transaction is refused twice: by the app, *and* by the database with the
   app bypassed entirely — **Law 1**. `UPDATE entries` is refused — **Law 2**
4. The rate card reproduces the fee Paystack itself reported, on all three branches
5. A Flutterwave settlement report becomes payouts with **named** deductions — a ₦168
   shortfall is a ₦118 fee and a ₦50 stamp duty, bound for different accounts. The USD row
   is refused rather than converted
6. That report meets the ledger **and the bank balance does not move** — the whole of D-027
   in one printed number
7. A bank statement arrives, and only now is there cash: fee, tax and receivable in one
   balanced transaction
8. Reconciling again books nothing — **Law 4** on the matching
9. What each payment in the batch actually cost, apportioned pro rata, with the fee contract
   that explained it stored beside the conclusion
10. A human reclassifies a deduction — approved, appended, compensated — and is refused when
    they try to approve their own decision or to type cash into `bank_account`
11. The queue: raised once, deduplicated across runs, and clearing itself when evidence lands
12. The system checks itself — **Law 6**, and Law 1 across every entry ever written

**Running it twice is not a mistake — it is the point.** Every step is idempotent, so the
second run reports duplicates everywhere and moves not one kobo. For a clean narrative:

```bash
docker compose down -v && docker compose up --build
docker compose run --rm cli node apps/pipeline/dist/main.js demo
```

## Fixtures

[`fixtures/`](fixtures/) holds payloads in the exact shapes the providers send — the
Paystack webhook bodies carry the `fees` field the rate-card check is validated against, and
the Flutterwave settlement envelope carries the `chargeback` field the hint is lifted from.
The demo signs each webhook the way its provider does — HMAC-SHA512 in hex for Paystack,
HMAC-SHA256 in base64 for Flutterwave — so verification runs for real rather than being
stubbed out.
