# apps/pipeline

The CLI deployable. It opens a database connection, dispatches a command and prints. It owns
no business logic — every decision it appears to make is delegated to a package.

**Depends on:** every package. **Depended on by:** nothing.

## Why it exists beside apps/api

It came first: containerisation needed a program to run before the service existed. The
service joined it rather than replacing it — a service for traffic, a CLI for operators,
over one set of libraries ([ADR-0022](../../docs/adr/0022-a-cli-deployable-alongside-the-service.md)).

The CLI remains the right tool for what a service is the wrong tool for: a scheduled
`replay`, a one-off ingest of a file on somebody's laptop, the demo, and `simulate`.

## Commands

    migrate                            apply every migration once, checksum-verified
    demo                               the whole system end to end, with commentary
    simulate [seed] [--reverse]        a generated messy day, checked against its own
                                       declared arithmetic; --reverse delivers the bank
                                       statements before the reports that explain them
    balances                           current balances, derived from entries
    verify                             check the balance cache and total conservation
    replay [--rebuild]                 fold the event log from genesis and check every
                                       projection against it; --rebuild discards the cache
    ingest-settlement <source> <file>  a provider's claim; books nothing
    ingest-bank <file> [bank-id]       a bank statement; the only evidence that books cash
    reconcile                          allocation, then bank confirmation
    exceptions                         the queue, worst first, with rejected candidates

Run any of them against the composed system:

    docker compose run --rm cli node apps/pipeline/dist/main.js balances

## The demo

Eighteen steps on real payload shapes, against real Postgres:

1. Signed webhooks from two providers — two signature schemes, one canonical promise
2. A redelivery changes nothing
3. An unbalanced transaction is refused twice: by the application, and by the database with
   the application bypassed entirely. `UPDATE entries` is refused
4. The rate card reproduces the fee Paystack itself reported, on all three branches
5. A settlement report becomes payouts with named deductions — a 168 shortfall is a 118 fee
   and a 50 stamp duty, bound for different accounts. A USD row is refused rather than
   converted
6. That report meets the ledger and the bank balance does not move
7. A bank statement arrives, and only now is there cash: fee, tax and receivable in one
   balanced transaction
8. Reconciling again books nothing
9. What each payment in the batch actually cost, apportioned pro rata, with the fee contract
   that explained it stored beside the conclusion
10. A human reclassifies a deduction — approved, appended, compensated — and is refused when
    they try to approve their own decision or to type cash into `bank_account`
11. The queue: raised once, deduplicated across runs, clearing itself when evidence lands
12. The system checks itself: cache against entries, and every entry ever written, summed

Running it twice is part of the point: every step is idempotent, so the second run reports
duplicates everywhere and moves nothing. For a clean run:

    docker compose down -v && docker compose up --build
    docker compose run --rm cli node apps/pipeline/dist/main.js demo

## Fixtures

[`fixtures/`](fixtures/) holds payloads in the exact shapes the providers send. The Paystack
webhook bodies carry the `fees` field the rate-card check is validated against, and the
Flutterwave settlement envelope carries the `chargeback` field the hint is lifted from. The
demo signs each webhook the way its provider does, so verification runs for real rather than
being stubbed.
