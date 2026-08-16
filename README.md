# Reconciliation Engine

A Nigerian fintech reconciliation engine, built on [`pay-normalize`](https://www.npmjs.com/org/pay-normalize).

> **Record the fast promise, wait for the slow money, and explain — provably — every
> difference between them.**

A payment notification arrives in seconds. The settled cash arrives later — T+1 for card
and PSP-aggregated channels, near-instant for direct NIP transfers and virtual-account
credits. This system records the promise immediately, waits for the money, and partitions
every difference into **matched**, **explained**, or **exception** — so a human only ever
looks at a genuine anomaly.

**Three records, and only one of them is money.**

```
T+0  Webhook                    a customer paid; the PSP owes us
       psp_receivable  +₦10,000
       merchant_revenue −₦10,000

T+1  PSP settlement report      the PSP says a payout is coming, less named deductions
       Payout PO-1: gross ₦10,000 − fee ₦150 − VAT ₦11.25 = ₦9,838.75
       Payments matched to the payout. NOTHING IS BOOKED.

T+2  Bank statement             our own bank, about our own account
       Credit of ₦9,838.75 confirms PO-1 — and only now:
       bank_account   +₦9,838.75      fees_expense   +₦150.00
       taxes_withheld +₦11.25         psp_receivable −₦10,000.00
```

A settlement report is a party with an interest in the answer describing its own future
behaviour. Booking cash on it makes four ordinary events invisible: a payout reported and
never sent, one the bank returns, one credited short of a correspondent-bank charge, and
one credited twice.

## Run it

Requires only a container runtime.

```bash
docker compose up --build
```

That starts Postgres and the service, applies the migrations, and runs Phases 1 to 3 end to
end with commentary — signed webhooks from two providers becoming promises, an unbalanced
transaction being refused *by the database* with the application bypassed, a settlement
report becoming payouts with named deductions, that report matching the ledger **and moving
no money**, and then a bank statement confirming one payout and booking it. It exits 0 only
if every invariant held.

Run it a second time and nothing moves: every step is idempotent, which is Law 4
demonstrated rather than asserted. For a clean narrative, `docker compose down -v` first.

```bash
docker compose run --rm pipeline node apps/pipeline/dist/main.js balances
docker compose run --rm pipeline node apps/pipeline/dist/main.js verify
docker compose run --rm pipeline node apps/pipeline/dist/main.js reconcile
```

The three ingestion paths, and the order they matter in:

```bash
main.js ingest-settlement flutterwave settlements.json   # a claim
main.js ingest-bank statement.json gtbank                # the proof
main.js reconcile                                        # stage 2, then stage 3
```

## Test it

```bash
npm install && npm test                    # 66 tests; the database suites skip themselves

docker compose up -d postgres
DATABASE_URL=postgres://recon:recon@localhost:5432/recon npm test    # 86 tests
```

The database tests need a real Postgres, because the invariants they check are enforced by
Postgres — mocking it would test the mock's willingness to agree with us. Each suite takes
its own schema, so they can run concurrently without measuring each other's weather.

Among them: Phase 1's exit criterion (across ~1,200 random valid transactions, every cached
balance equals its recomputed balance and the whole ledger still sums to zero), and Phase
3's (a PSP report books nothing; an independent bank credit books everything).

## Status

| Phase | | |
|---|---|---|
| 0 · Foundations and the canonical model | ✅ | [`packages/canon`](packages/canon) |
| 1 · The ledger core | ✅ | [`packages/ledger-core`](packages/ledger-core) |
| 2 · The ingest layer | ✅ | [`packages/ingest`](packages/ingest) — three halves: webhooks, PSP reports, bank statements |
| 3 · The reconciliation engine | ✅ | [`packages/reconciler`](packages/reconciler) — three-way, see D-027 |
| 4 · Exceptions and settlement windows | — | the state machine and the queue; the calendar and the resolution trail already exist |
| 5 · Event sourcing and replay | — | |
| 6 · The API and the service | — | [`apps/api`](apps/api) |
| 7 · Containerisation | ✅ | [`Dockerfile`](Dockerfile), [`docker-compose.yml`](docker-compose.yml) — brought forward, see D-022 |
| 8 · Testing and chaos | partial | property, idempotency and invariant tests exist; the adversarial simulator is Phase 8 |
| 9 · Dashboard and demo | — | |

**What works today.** A webhook from any of four sources is signature-verified, normalised,
and posted as a balanced `authorized` transaction that cannot be duplicated, unbalanced or
edited. A settlement report becomes a `Payout` with named deductions — fee, tax, reserve,
penalty, chargeback — each bound for its own account. A bank statement becomes canonical
credit and debit lines. The matcher allocates payments to payouts without booking anything,
and books cash only when an independent bank credit confirms the payout, splitting each
batch deduction across the payments it was charged on. Fee expectations come from dated
contracts scoped per merchant, source, channel and currency; deadlines come from a business
calendar with a named time zone, cut-offs, weekends and versioned Nigerian holiday tables.
Every record traces to the SHA-256 of the file it came from and to the row inside it, and a
human correction is an approved, appended decision that posts its own compensating entry.

**What does not exist yet** is the exception *state machine* and the queue a human works
from — the findings are produced and recorded, but nothing yet moves them through
`overdue → exception → resolved`. That is Phase 4.

## Layout

```
packages/canon         the shared language — types only, depends on nothing
packages/ledger-core   the double-entry engine, and the only path to writing money
packages/ingest        the anti-corruption boundary — no database, no I/O
packages/reconciler    the matching engine                (Phase 3)
apps/pipeline          the deployable: a CLI over the libraries
apps/api               the Fastify service                (Phase 6)
```

Dependencies point one way only, downward toward `canon`. No cycles.

## Documents

| Document | What it is |
|---|---|
| [docs/RECONCILIATION-BIBLE.md](docs/RECONCILIATION-BIBLE.md) | The doctrine: core beliefs, the seven Laws, target attributes, and the ten build phases with exit criteria. **The specification.** |
| [docs/FIRST-PRINCIPLES.md](docs/FIRST-PRINCIPLES.md) | Why the design is what it is, derived from scratch: why a balance is never a fact, why double-entry falls out of conservation, what reconciliation actually is. |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Libraries vs. deployables, the one-directional dependency graph, and how it becomes a containerised service. |
| [docs/DECISIONS.md](docs/DECISIONS.md) | The decision log — 42 entries, each with its reasoning and the alternatives rejected. Read this before changing anything structural. |
| [AGENTS.md](AGENTS.md) | Engineering rules for anyone (human or agent) writing code here. |

## Where the Laws are enforced

Not in comments, and mostly not in TypeScript.

| Law | Enforced by |
|---|---|
| 1 · entries sum to zero | a **deferred** constraint trigger in Postgres, firing at `COMMIT` |
| 2 · append-only | `BEFORE UPDATE OR DELETE` triggers on every history table, ledger and reconciliation alike |
| 3 · integer kobo | `BIGINT` columns; `bigint` in TypeScript; amounts cast from text, never a JS number — including inside JSONB |
| 4 · idempotency | the primary key **is** the event's idempotency key |
| 5 · determinism | derived ids, no `randomUUID` in a write path, `asOf` always passed in, non-overlapping fee contracts, versioned holiday tables, an apportionment tie-break that does not depend on iteration order |
| 6 · cache == recompute | `verifyBalances()`, run by the demo and the property test |
| 7 · canonical boundary | `packages/canon` is a leaf; the matcher is handed a calendar and a fee model, never a source name |
| maker-checker | an `ApprovalPolicy` in the application, and a `CHECK` constraint that refuses self-approval in the database |

Two more invariants live in the database because application code cannot be trusted with
them: a payment can never be allocated beyond its receivable (a deferred trigger), and one
bank credit can confirm at most one payout (a partial unique index).
