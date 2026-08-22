# Reconciliation Engine

[![CI](https://github.com/lordisrael1/settlement-engine/actions/workflows/ci.yml/badge.svg)](https://github.com/lordisrael1/settlement-engine/actions/workflows/ci.yml)

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
    # {"status":"ok","database":"reachable",
    #  "inbox":{"pending":0,"failed":0,"deferred":0,"oldestPendingAt":null},
    #  "alerts":[]}

`/health` reaches a verdict rather than only reporting numbers: it answers **503** once a
threshold is breached, with a sentence per breach in `alerts`. That is the last mile — a
queue that grows all weekend, a worker that died, a delivery nobody will retry, and a
reconciliation that has not run since Tuesday are all things an existing uptime monitor can
now find out about without anybody remembering to look
([ADR-0074](docs/adr/0074-the-last-mile-is-a-schedule-and-a-verdict.md)). Use it as a
readiness or alerting target, not as a liveness probe: a degraded service is up, and
restarting it fixes nothing.

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
| `GET` | `/health` | Database reachability, inbox depth, and a verdict. 503 when a threshold is breached. No authentication. |
| `POST` | `/webhooks/:source` | 200 accepted · 401 bad signature · 404 unknown source · 503 no secret configured |
| `GET` | `/deliveries/:deliveryId` | What became of an accepted webhook, down to the ledger transaction id |
| `GET` | `/balances` | Every account, its meaning, and its balance in kobo |
| `POST` | `/ingest/settlement/:source` | A settlement export, as raw bytes · 501 for a source with no adapter |
| `POST` | `/ingest/bank` | A bank statement, as raw bytes |
| `POST` | `/reconcile/runs` | Runs allocation and bank confirmation; returns what was concluded and booked |
| `GET` | `/reconciliation/summary?from&to` | Matched, explained and exception counts, plus money reported and not yet banked |
| `GET` | `/exceptions`, `/exceptions/:key` | The queue, worst first, with the candidates the matcher rejected |
| `GET` | `/reserves` | Money a PSP withheld and has not returned, oldest first, overdue ones flagged |
| `GET` | `/bank/position` | Our books against the bank's own running balance. Does **not** prove the statement came from the bank |
| `POST` | `/bank/attestations` | Record that a named person compared the books to the bank's portal. Append-only |
| `POST` | `/exceptions/:key/resolve` | Records a maker-checked resolution; an unapproved write-off is a 422 |
| `GET` | `/ingest/anomalies` | Foreign formats that have moved, worst first ([ADR-0067](docs/adr/0067-format-drift-is-a-record-not-a-counter.md)) |
| `POST` | `/ingest/anomalies/:key/acknowledge` | Take ownership of a drift; it stays owned when the next file shows it again |
| `GET` | `/evidence/:id` | Document metadata and its access log. No grant needed — no personal data in any of it |
| `GET` | `/evidence/:id/raw?reason` | The bytes. Needs the `evidence.raw` grant · 400 without a reason · 410 once purged on schedule |
| `POST` | `/evidence/:id/exports` | A sealed copy. Needs `evidence.export`; an original needs a second approver |
| `GET` | `/evidence/exports/:token` | Collect it, once. No API key — the single-use token is the credential |

The full reference, including every error and what causes it, is at `/docs/`.

Management endpoints require `X-API-Key`. Webhook endpoints authenticate by the provider's
signature over the raw bytes and by nothing else, because a provider holds no credential of
ours ([ADR-0052](docs/adr/0052-two-authentication-rails.md)).

## API reference

    docker compose up --build
    open http://localhost:8080/docs/

A [Scalar](https://scalar.com) reference over an OpenAPI 3.1 document, served by the service
itself — `/docs/openapi.json` and `/docs/openapi.yaml` are the document, and the UI bundle is
self-hosted rather than fetched from a CDN, so it renders on a machine with no route out.

Paths, methods, parameters and request-body schemas are generated from the routes. Responses
and the error catalogue are written in [apps/api/src/openapi.ts](apps/api/src/openapi.ts) and
merged in when the document is built — deliberately *not* attached to the routes, because
Fastify's `schema.response` is a serialiser as well as a description and `fast-json-stringify`
drops any property the schema does not name. Documentation must not be able to reshape a
payload that carries money. A test asserts both halves: that every served route is documented,
and that no route compiles a response schema.

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
| `reconcile [--limit=N]` | Allocation, then bank confirmation. Says in yellow when it read a sample rather than the books. |
| `exceptions` | The queue, worst first |
| `reserves` | Money a PSP withheld and has not returned, oldest first |
| `attest-bank [--balance=<naira>] [--note=...]` | Print our books against the bank's own closing balance; with `--balance`, record that a person checked the portal |
| `evidence-retention [--apply]` | Move every document to the state its retention schedule says. A dry run without `--apply`. |

Every command is idempotent: running it twice moves no money. For a clean run, start from
`docker compose down -v`.

## Configuration

Configuration arrives as environment variables; see [.env.example](.env.example).

| Variable | Description |
|---|---|
| `DATABASE_URL` | Postgres connection string |
| `RECON_API_KEYS` | `principal:secret:grant\|grant`, comma-separated. Every key belongs to a named principal. The service refuses to start without it. |
| `RECON_EVIDENCE_KEY` | The root key evidence is sealed under, as `<key-id>:<base64 of 32 bytes>`. Refuses to start without it. |
| `RECON_EVIDENCE_KEYS_RETIRED` | Keys that no longer seal new records but must still unwrap old ones |
| `RECON_RETENTION_ORIGINAL_DAYS`, `RECON_RETENTION_REDACTED_DAYS`, `RECON_RETENTION_INBOX_DAYS` | The retention schedule, in days. Defaults 30 / 2192 / 30. |
| `RECON_EXPORT_TTL_MS` | How long an export link lives. Default 15 minutes. |
| `RECON_WEBHOOK_SECRET_<SOURCE>` | Per-source webhook signing secret. A source without one answers 503. |
| `RECON_WEBHOOK_SECRET_<SOURCE>_PREVIOUS` | The outgoing secret during a rotation. Both are tried, so a backlog signed with the old one is not discarded ([ADR-0073](docs/adr/0073-retries-back-off-and-secrets-overlap.md)) |
| `RECON_MERCHANT` | Whose books these are. Fee contracts are negotiated per merchant. |
| `RECON_BANK_ACCOUNT`, `RECON_BANK` | Which of our own accounts an upload is about when the request does not say |
| `RECON_DRAIN_INTERVAL_MS`, `RECON_DRAIN_BATCH`, `RECON_DRAIN_MAX_ATTEMPTS` | Inbox worker tuning. Retries back off exponentially between attempts, so eight of them span minutes rather than seconds. |
| `RECON_RECONCILE_INTERVAL_MS` | Reconcile on a schedule. **0 (the default) means nothing in the process reconciles** — drive `POST /reconcile/runs` from a cron instead, and see the warning the service logs at boot. |
| `RECON_RECONCILE_LIMIT` | How many records one run may consider. A run that hits it says so, and stops clearing exceptions it could not see ([ADR-0075](docs/adr/0075-clearing-is-bounded-by-what-the-run-saw.md)). Default 1000. |
| `RECON_SUBSET_MAX_CANDIDATES`, `RECON_SUBSET_MAX_SIZE`, `RECON_SUBSET_MAX_STEPS` | The bounded subset search. The default of 24 candidates is a *small-batch* bound; raising it is exponential, so raise `MAX_STEPS` with it ([ADR-0070](docs/adr/0070-arithmetic-matching-is-a-small-batch-feature.md)). |
| `RECON_RATE_WEBHOOK_PER_MINUTE`, `RECON_RATE_MANAGEMENT_PER_MINUTE`, `RECON_RATE_MAX_KEYS` | Per-caller request ceiling, per process. 0 disables. This is the floor, not the control — see Deployment below. |
| `RECON_ALERT_INBOX_PENDING`, `RECON_ALERT_INBOX_FAILED`, `RECON_ALERT_INBOX_AGE_MS`, `RECON_ALERT_OPEN_EXCEPTIONS`, `RECON_ALERT_RECONCILE_AGE_MS`, `RECON_ALERT_ATTESTATION_AGE_MS` | When `/health` stops saying it is fine. Each 0 disables that verdict. |
| `RECON_TRUST_PROXY` | `true` behind a load balancer. Without it every caller shares the balancer's address, and the per-address rate limit becomes a global one. |
| `PORT`, `LOG_LEVEL` | Defaults 8080 and `info` |

### Deployment requirements

Three things this service does not do for itself, stated as requirements rather than left to
be discovered:

**Reconciliation must be driven.** Set `RECON_RECONCILE_INTERVAL_MS`, or run
`POST /reconcile/runs` from a cron. Not both, and not on more than one replica: every write a
run performs is keyed so a concurrent second run duplicates nothing, but it duplicates the
work. If neither is done, exceptions are never raised and the queue stays empty for the wrong
reason — which is why `/health` reports `reconciliation_stale`.

**Rate limiting belongs at the edge.** The built-in limiter is per-process and in-memory: two
replicas allow twice the rate, a restart forgets everything, and an attacker with a thousand
source addresses is a thousand callers. Put a WAF or gateway limit in front of
`/webhooks/:source`, keep `RECON_WEBHOOK_BYTES` tight, and set `RECON_TRUST_PROXY=true` so the
in-process limiter sees real client addresses.

**Somebody has to compare the books to the bank.** See *The trust boundary* below.

## The trust boundary

Cash is booked from an **uploaded file**, and nothing proves that file came from the bank.

`POST /ingest/bank` is behind an API key and that is the whole of the control. Anyone holding
an ingest key can produce a "bank statement" that confirms inflows and moves `psp_receivable`
into `bank_account`. There is no signature on the bytes, no feed, and — because this system has
no direct line to the bank — no independent balance to diverge from.

`verify` does not catch this and cannot. It proves *internal conservation*: every transaction
balances, the entries sum to zero, the cache agrees with the entries. A fabricated statement
that balances passes all of it trivially. **"The books are internally consistent" and "the
books match reality" are different claims, and only the first is enforced by code.**

Two things narrow it, and neither is a fix:

    curl -H 'x-api-key: ...' localhost:8080/bank/position

compares `bank_account`, summed from entries, to the running balance on the last statement
line ingested. This is free and automatic and catches the ordinary failure — a half-ingested
statement, a rejected credit, a debit nobody modelled. It proves nothing about provenance: a
fabricated file carries a fabricated running balance and agrees with itself perfectly.

    docker compose run --rm cli node apps/pipeline/dist/main.js attest-bank --balance=1450320.55

records that a **named person** opened the bank's own portal and compared. Append-only.
`/health` raises `bank_unattested` when a week passes without one.

A difference between the two numbers is *expected*: the real account holds movements this
system does not model — supplier payments, salaries, standing orders. The question is not
whether it is zero but whether anybody can say what it consists of, which is what the
attestation's note is for.

The open-banking feed on the roadmap is what replaces this. Until it exists, the honest
control is a human on a schedule, and it is written down here because a reviewer will find it
([ADR-0068](docs/adr/0068-the-bank-file-is-the-trust-boundary.md)).

### The bank-file contract

The conversion from a bank's own CSV into the shape `/ingest/bank` accepts lives outside this
repository, because every Nigerian bank exports something different and the per-bank knowledge
belongs where it is maintained ([ADR-0057](docs/adr/0057-bank-evidence-arrives-as-an-upload.md)).
Two clauses of that hand-off are now checked rather than assumed:

**`id` must be unique within the account, forever.** Most Nigerian bank exports have no
per-row id, so a converter synthesises one — and the obvious synthesis, a hash of date, amount
and narration, collides the day two customers pay the same ₦5,000 subscription with the same
narration. **Include the running balance or a within-file sequence**: `${date}:${seq}` is
enough. A repeated id inside one file is refused; a row conflicting with a *different* stored
row is refused and queued as `BANK_LINE_COLLISION`, severity 3. Re-uploading an unchanged file
is still a silent no-op.

**`date` must be ISO-8601** — `YYYY-MM-DD`, read as UTC midnight, or a full timestamp.
`new Date("02/01/2026")` is the 1st of February in every JavaScript engine and a Nigerian
export written DD/MM means the 2nd of January, which is a month of drift into the window that
decides whether a credit can match a payout at all.

## Development

    npm install
    npm run build
    npm test                    # 137 tests; suites needing a database skip themselves

    docker compose up -d postgres
    DATABASE_URL=postgres://recon:recon@localhost:5432/recon npm test    # 257 tests

The database suites need a real Postgres, because the invariants they assert are enforced by
Postgres. Each suite takes its own schema, so they can run concurrently.

CI runs the second command, not the first. A green build with no database would report
success while skipping every trigger-enforced invariant, the replay determinism check, the
exception lifecycle, the durable inbox and all of the HTTP routes — see
[.github/workflows/ci.yml](.github/workflows/ci.yml). Node 22 is the floor: the test script
passes glob patterns to `node --test`, which Node 20 does not expand.

    npm run bench               # measure; see docs/PERFORMANCE.md

Notable coverage: a test that feeds a synthetic PAN through the ingest boundary and asserts
nothing is written; a test that redacts every provider fixture and asserts the canonical
payment is unchanged, so the keep-list stays complete as connectors change; a property test
asserting that across roughly 1,200 random valid
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
    packages/protect       refuse card data, keep only what the matcher reads, encrypt it
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
  closes itself when evidence arrives, and carries the near-misses the matcher rejected — and
  that clears **only what a run actually looked at**, never an item a person has acknowledged
  ([ADR-0075](docs/adr/0075-clearing-is-bounded-by-what-the-run-saw.md)).
- Reserves with a deadline: a withholding becomes a dated obligation the moment it books, a
  release clears it oldest-first, and one past its date is chased. Without this, a PSP that
  returns reserves on schedule and one that never returns any produce identical books
  ([ADR-0071](docs/adr/0071-reserves-carry-a-deadline.md)).
- Partial refunds and partial chargebacks: a ₦3,000 refund against a ₦10,000 charge takes back
  ₦3,000 and leaves the rest waiting for its payout
  ([ADR-0069](docs/adr/0069-partial-refunds-and-chargebacks.md)).
- Same-amount bank credits paired as a *set* where the set is unambiguous even though no
  member of it is — the ordinary Tuesday of a fixed-price business, and otherwise a queue whose
  depth tracks transaction volume
  ([ADR-0072](docs/adr/0072-same-amount-credits-are-paired-as-a-set.md)).
- Maker-checked human resolutions that post their own compensating entries and can never
  touch `bank_account`.
- A data-protection boundary: a delivery or upload carrying a card number or sensitive
  authentication data is refused before it is stored; provider payloads are reduced to the
  fields reconciliation reads in the same transaction that records what they meant; every
  stored document is encrypted per record under a key the database has never seen; and every
  read of a document names a verified principal in an append-only access log.
- An append-only event log written beside the ledger, which `replay` folds from genesis to
  prove the balances can be rebuilt from it.
- A seeded adversarial simulator that generates a messy day, declares in advance what every
  planted anomaly is, and drives it in every arrival order.
- Operational honesty: retries that back off with deterministic jitter, a webhook secret ring
  so a rotation does not discard a backlog, a fixed lock order on the balance cache, a
  per-caller rate ceiling on the unauthenticated rail, and a `/health` that answers 503 rather
  than leaving a number for nobody to read
  ([ADR-0073](docs/adr/0073-retries-back-off-and-secrets-overlap.md),
  [ADR-0074](docs/adr/0074-the-last-mile-is-a-schedule-and-a-verdict.md)).

## Known limits

Stated here rather than left to be discovered. Each one is a real boundary of what this system
claims, not a bug list.

**Only a person can tell you the books match the bank.** Cash is booked from an uploaded file
and nothing proves its provenance. See *The trust boundary* above.

**NGN only.** A webhook in any other currency is `ignored` with a reason, and it is *ignored*
rather than queued — so a Nigerian merchant taking international card payments settled in USD
and converted has those payments silently absent from reconciliation rather than visibly
unmatched. The ledger has one currency, `Money` will not combine two, and multi-currency is a
change to the chart of accounts and every balance, not a configuration flag.

**Arithmetic-only matching is a small-batch feature.** The bounded subset search considers 24
candidates by default. A payout batching more than that is escalated as `BATCH_TOO_LARGE` —
honestly, saying it was never attempted — rather than reported as unmatched. This is survivable
because every PSP with an adapter here ships itemised settlement files, so the reference path
carries the volume ([ADR-0070](docs/adr/0070-arithmetic-matching-is-a-small-batch-feature.md)).

**Three credits against two same-amount payouts still escalates all three.** Set pairing needs
the two sides to be the same size; sizing it correctly when they are not needs the bank's own
running balance to disambiguate.

**One hot row per account.** Every booking for a merchant contends on the `psp_receivable`
balance row, so adding workers stops raising throughput past that point. Lock *ordering* is
fixed, so this costs latency rather than deadlocks — but it is a design property of the cache
and no index fixes it. The options are per-account sharding or dropping the cache to a
periodically-materialised view with `verifyBalances` as the source of truth; both are deferred
([ADR-0053](docs/adr/0053-scaling-decisions-built-and-deferred.md)).

**Static keys make maker-checker only as strong as key custody.** Self-approval is genuinely
refused, in the application layer and again by a database check. But one person holding two
principals' keys satisfies "a different approver". An identity provider is the real fix;
`authenticate` is the function that changes
([ADR-0066](docs/adr/0066-pci-scope-and-evidence-access.md)).

**This system cannot see whether the customer got what they paid for.** "Charged but never
provisioned" and "provisioned but never charged" are outside it by design — the product
database is not a fourth record, and the merchant must cover that with a join on the payment
reference stored here. Worth saying plainly rather than letting a reader assume this is a
complete revenue-integrity check
([ADR-0049](docs/adr/0049-the-product-database-is-not-a-record.md)).

**Reserves withheld before ADR-0071 shipped have no hold rows** and will not be chased by this
mechanism. Backfilling is possible from `entries` and is deliberately not automatic: the
deadline would be derived from a schedule nobody agreed to at the time.

## Roadmap

- **Dashboard.** No UI exists; the queue and the books are reachable over HTTP and from the
  CLI only.
- **Bank feeds.** Bank evidence arrives as an uploaded statement, which is why provenance is a
  human control today. A direct or open-banking feed goes behind the same boundary, must carry
  data-availability state as data, and is what turns the attestation from a control into a
  cross-check ([ADR-0057](docs/adr/0057-bank-evidence-arrives-as-an-upload.md),
  [ADR-0068](docs/adr/0068-the-bank-file-is-the-trust-boundary.md)).
- **Multi-currency.** NGN is hardcoded through the chart of accounts, `Money`, and every
  balance. A merchant settling in USD needs a currency dimension on accounts and balances, an
  FX rate as dated administered data beside the fee contracts, and a decision about which
  moment the rate is taken at. None of that is a flag.
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
| [docs/PERFORMANCE.md](docs/PERFORMANCE.md) | Measured throughput for parsing, ledger writes and batch matching — including where subset-sum stops finding answers |
| [docs/adr/](docs/adr/README.md) | 75 decision records, each with its context, decision and consequences |
| [CONTRIBUTING.md](CONTRIBUTING.md) | Engineering rules for changing this codebase |
