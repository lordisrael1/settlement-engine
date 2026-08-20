# Reconciliation Engine

A payment reconciliation engine for Nigerian fintech, built on
[`pay-normalize`](https://www.npmjs.com/org/pay-normalize).

It records a payment the moment the provider's webhook arrives, waits for the settled cash,
and partitions every difference between them into **matched**, **explained** or
**exception**, so that a person only reviews a genuine anomaly.

## How it works

Three independent records describe the same money, and only one of them is cash:

    T+0  Webhook                     a customer paid; the provider owes us
           psp_receivable  +10,000
           merchant_revenue -10,000

    T+1  Settlement report           the provider says a payout is coming, less deductions
           Payout PO-1: gross 10,000 - fee 150 - VAT 11.25 = 9,838.75
           Payments are matched to the payout. Nothing is booked.

    T+2  Bank statement              our own bank, about our own account
           A credit of 9,838.75 confirms PO-1, and only now:
           bank_account   +9,838.75      fees_expense   +150.00
           taxes_withheld    +11.25      psp_receivable -10,000.00

A settlement report is the provider describing its own future behaviour. Booking cash on it
would hide four ordinary events: a payout reported and never sent, one the bank returns, one
credited short of a correspondent-bank charge, and one credited twice.

See [docs/DOMAIN-MODEL.md](docs/DOMAIN-MODEL.md) for the full model.

## Quick start

Requires a container runtime.

    docker compose up --build

That starts Postgres and the service, applies migrations under an advisory lock, binds port
8080 and begins draining the webhook inbox.

    curl localhost:8080/health
    # {"status":"ok","database":"reachable","inbox":{"pending":0,"failed":0}}

    curl -H 'x-api-key: local-dev-key-0123456789' localhost:8080/balances
    curl -X POST -H 'x-api-key: local-dev-key-0123456789' localhost:8080/reconcile/runs
    curl -H 'x-api-key: local-dev-key-0123456789' localhost:8080/exceptions

Webhooks are verified, stored and acknowledged in milliseconds; a worker interprets them
moments later, and the delivery id resolves to the ledger transaction it became:

    curl -X POST localhost:8080/webhooks/paystack \
         -H 'x-paystack-signature: <hmac-sha512 of the raw body>' \
         --data-binary @charge.json
    # {"accepted":true,"deliveryId":"3ceec2a5...","duplicate":false}

    curl -H 'x-api-key: ...' localhost:8080/deliveries/3ceec2a5...
    # {"state":"processed","transactionId":"payment:paystack:charge:PSK_9f3a2c", ...}

The two evidence rails take the file itself, because the bytes are the evidence and their
hash is its identity:

    curl -X POST -H 'x-api-key: ...' --data-binary @settlements.json \
         localhost:8080/ingest/settlement/flutterwave   # a claim; books nothing
    curl -X POST -H 'x-api-key: ...' --data-binary @statement.json \
         localhost:8080/ingest/bank                     # the proof
    curl -X POST -H 'x-api-key: ...' localhost:8080/reconcile/runs

## HTTP API

| Method | Path | Description |
|---|---|---|
| `GET` | `/health` | Database reachability and inbox depth. No authentication. |
| `POST` | `/webhooks/:source` | 200 accepted · 401 bad signature · 404 unknown source · 503 no secret configured |
| `GET` | `/deliveries/:deliveryId` | What became of an accepted webhook, down to the ledger transaction id |
| `GET` | `/balances` | Every account, its meaning, and its balance in kobo |
| `POST` | `/ingest/settlement/:source` | A settlement export, as raw bytes · 501 for a source with no adapter |
| `POST` | `/ingest/bank` | A bank statement, as raw bytes |
| `POST` | `/reconcile/runs` | Runs allocation and bank confirmation; returns what was concluded and booked |
| `GET` | `/reconciliation/summary?from&to` | Matched, explained and exception counts, plus money reported and not yet banked |
| `GET` | `/exceptions`, `/exceptions/:key` | The queue, worst first, with the candidates the matcher rejected |
| `POST` | `/exceptions/:key/resolve` | Records a maker-checked resolution; an unapproved write-off is a 422 |

Management endpoints require `X-API-Key`. Webhook endpoints authenticate by the provider's
signature over the raw bytes and by nothing else, because a provider holds no credential of
ours ([ADR-0052](docs/adr/0052-two-authentication-rails.md)).

## CLI

The same libraries, driven from the command line:

    docker compose run --rm cli node apps/pipeline/dist/main.js <command>

| Command | Description |
|---|---|
| `migrate` | Apply every migration once, checksum-verified |
| `demo` | An end-to-end walkthrough with commentary, against real Postgres |
| `simulate [seed] [--reverse]` | Generate a messy day from a seed and check the books against its declared arithmetic |
| `balances` | Current balances, derived from entries |
| `verify` | Check the balance cache and total conservation |
| `replay [--rebuild]` | Fold the event log from genesis and check every projection against it |
| `ingest-settlement <source> <file>` | Store a provider's report; books nothing |
| `ingest-bank <file> [bank-id]` | Store a bank statement |
| `reconcile` | Allocation, then bank confirmation |
| `exceptions` | The queue, worst first |

Every command is idempotent: running it twice moves no money. For a clean run, start from
`docker compose down -v`.

## Configuration

Configuration arrives as environment variables; see [.env.example](.env.example).

| Variable | Description |
|---|---|
| `DATABASE_URL` | Postgres connection string |
| `RECON_API_KEY` | Management credential. The service refuses to start without it. |
| `RECON_WEBHOOK_SECRET_<SOURCE>` | Per-source webhook signing secret. A source without one answers 503. |
| `RECON_MERCHANT` | Whose books these are. Fee contracts are negotiated per merchant. |
| `RECON_BANK_ACCOUNT`, `RECON_BANK` | Which of our own accounts an upload is about when the request does not say |
| `RECON_DRAIN_INTERVAL_MS`, `RECON_DRAIN_BATCH`, `RECON_DRAIN_MAX_ATTEMPTS` | Inbox worker tuning |
| `PORT`, `LOG_LEVEL` | Defaults 8080 and `info` |

## Development

    npm install
    npm run build
    npm test                    # 79 tests; suites needing a database skip themselves

    docker compose up -d postgres
    DATABASE_URL=postgres://recon:recon@localhost:5432/recon npm test    # 158 tests

The database suites need a real Postgres, because the invariants they assert are enforced by
Postgres. Each suite takes its own schema, so they can run concurrently.

Notable coverage: a property test asserting that across roughly 1,200 random valid
transactions every cached balance equals its recomputed balance and the whole ledger sums to
zero; a test that a settlement report books nothing while an independent bank credit books
everything; an HTTP suite driving every endpoint through the real router via `app.inject()`;
and an end-to-end suite that drives a generated day in six arrival orders and asserts they
all reach identical balances and an identical queue.

## Project structure

    packages/canon         the shared vocabulary; types only, depends on nothing
    packages/ledger-core   the double-entry engine, and the only path to writing money
    packages/ingest        the anti-corruption boundary; no database, no I/O
    packages/reconciler    the matching engine and the exception queue
    packages/inbox         durable webhook acceptance: store, answer, work it later
    packages/policy        joins ingest's calendars to the database's fee contracts
    packages/simulator     a seeded generator of provider files with planted anomalies
    apps/api               the Fastify service
    apps/pipeline          the CLI over the same libraries

Dependencies point one way only, toward `canon`. There are no cycles.

## Features

- Signature-verified webhook ingest from four providers, normalised and posted as balanced
  `authorized` transactions that cannot be duplicated, unbalanced or edited.
- Settlement reports parsed into payouts with named deductions — fee, tax, reserve, penalty,
  chargeback — each bound for its own account.
- Bank statements parsed into canonical credit and debit lines.
- Two-stage matching: allocation of payments to payouts, which books nothing, and bank
  confirmation, which books cash and splits each batch deduction across the payments it was
  charged on.
- Dated fee contracts scoped by merchant, source, channel and currency; deadlines from a
  business calendar with a named time zone, cut-offs, weekends and versioned Nigerian
  holiday tables.
- Full lineage: every record traces to the SHA-256 of its source file and to the row inside
  it.
- A durable exception queue that deduplicates across runs, escalates when a window passes,
  closes itself when evidence arrives, and carries the near-misses the matcher rejected.
- Maker-checked human resolutions that post their own compensating entries and can never
  touch `bank_account`.
- An append-only event log written beside the ledger, which `replay` folds from genesis to
  prove the balances can be rebuilt from it.
- A seeded adversarial simulator that generates a messy day, declares in advance what every
  planted anomaly is, and drives it in every arrival order.

## Roadmap

- **Dashboard.** No UI exists; the queue and the books are reachable over HTTP and from the
  CLI only.
- **Bank feeds.** Bank evidence arrives as an uploaded statement. A direct or open-banking
  feed goes behind the same boundary and must carry data-availability state as data
  ([ADR-0057](docs/adr/0057-bank-evidence-arrives-as-an-upload.md)).
- **Capacity work.** Partitioning, index shaping, pool sizing and load testing are
  deliberately deferred until there is traffic to measure
  ([ADR-0053](docs/adr/0053-scaling-decisions-built-and-deferred.md)).

The company's own product database is deliberately not a fourth record. "Customer A bought
service X" is a question for that database, joined on the payment reference this system
stores ([ADR-0049](docs/adr/0049-the-product-database-is-not-a-record.md)).

## Documentation

| Document | Contents |
|---|---|
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Module layout, the dependency graph, request flow, where each invariant is enforced, and how it is deployed |
| [docs/DOMAIN-MODEL.md](docs/DOMAIN-MODEL.md) | The chart of accounts, the payment lifecycle, matching stages and reason codes, and the exception lifecycle |
| [docs/adr/](docs/adr/README.md) | 62 decision records, each with its context, decision and consequences |
| [CONTRIBUTING.md](CONTRIBUTING.md) | Engineering rules for changing this codebase |
