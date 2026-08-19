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

That starts Postgres and the service, applies the migrations under an advisory lock, binds
port 8080 and begins draining the webhook inbox.

```bash
curl localhost:8080/health
# {"status":"ok","database":"reachable","inbox":{"pending":0,"failed":0}}

curl -H 'x-api-key: local-dev-key-0123456789' localhost:8080/balances
curl -X POST -H 'x-api-key: local-dev-key-0123456789' localhost:8080/reconcile/runs
curl -H 'x-api-key: local-dev-key-0123456789' localhost:8080/exceptions
```

A webhook is verified, stored and acknowledged in milliseconds; a worker gives it meaning
moments later, and the delivery id you were handed resolves to the ledger transaction it
became:

```bash
curl -X POST localhost:8080/webhooks/paystack \
     -H 'x-paystack-signature: <hmac-sha512 of the raw body>' \
     --data-binary @charge.json
# {"accepted":true,"deliveryId":"3ceec2a5…","duplicate":false}

curl -H 'x-api-key: local-dev-key-0123456789' localhost:8080/deliveries/3ceec2a5…
# {"state":"processed","transactionId":"payment:paystack:charge:PSK_9f3a2c", …}
```

The two evidence rails take the file itself, because the bytes *are* the evidence and their
hash is its identity:

```bash
curl -X POST -H 'x-api-key: …' --data-binary @settlements.json \
     localhost:8080/ingest/settlement/flutterwave   # a claim — books nothing
curl -X POST -H 'x-api-key: …' --data-binary @statement.json \
     localhost:8080/ingest/bank                     # the proof
curl -X POST -H 'x-api-key: …' localhost:8080/reconcile/runs   # stage 2, then stage 3
```

### The narrated demo

The same libraries, driven by the CLI, with commentary — signed webhooks from two providers
becoming promises, an unbalanced transaction refused *by the database* with the application
bypassed, a settlement report becoming payouts with named deductions, that report matching
the ledger **and moving no money**, and then a bank statement confirming one payout and
booking it. It exits 0 only if every invariant held.

```bash
docker compose run --rm cli node apps/pipeline/dist/main.js demo
docker compose run --rm cli node apps/pipeline/dist/main.js balances
docker compose run --rm cli node apps/pipeline/dist/main.js replay --rebuild
```

Run any of it a second time and nothing moves: every step is idempotent, which is Law 4
demonstrated rather than asserted. For a clean narrative, `docker compose down -v` first.

### The generated day

The demo's messiness is hand-authored — it contains the anomalies somebody thought of. This
one is **generated** from a seed, and it declares in advance what every planted anomaly is
and where the books must land, to the kobo:

```bash
docker compose run --rm cli node apps/pipeline/dist/main.js simulate 42
docker compose run --rm cli node apps/pipeline/dist/main.js simulate 42 --reverse
```

A renegotiated fee contract with payments on both sides of it, a reversal on a rail that
never names its payouts, a chargeback folded in beside the fees, a correspondent-bank charge
nobody announced, a payout still inside its window, and exactly one credit that belongs to
nobody. Everything except the last is explained without a human, and the last is the only
thing anybody is shown.

`--reverse` delivers the bank statements *before* the reports that explain them. Every
finding raised along the way has to close itself when the evidence lands, and the books have
to end in exactly the same place. It exits non-zero if they do not.

## Test it

```bash
npm install && npm test                    # 79 tests; the database suites skip themselves

docker compose up -d postgres
DATABASE_URL=postgres://recon:recon@localhost:5432/recon npm test    # 158 tests
```

The database tests need a real Postgres, because the invariants they check are enforced by
Postgres — mocking it would test the mock's willingness to agree with us. Each suite takes
its own schema, so they can run concurrently without measuring each other's weather.

Among them: Phase 1's exit criterion (across ~1,200 random valid transactions, every cached
balance equals its recomputed balance and the whole ledger still sums to zero), Phase 3's (a
PSP report books nothing; an independent bank credit books everything), Phase 6's (every
capability reachable with correct status codes and auth, and a signed webhook flowing end to
end into an `authorized` transaction — through the real router, via `app.inject()`, with no
port bound), and Phase 8's (a generated day survives in every arrival order, and the one
planted phantom is the only thing a human is shown).

## Status

| Phase | | |
|---|---|---|
| 0 · Foundations and the canonical model | ✅ | [`packages/canon`](packages/canon) |
| 1 · The ledger core | ✅ | [`packages/ledger-core`](packages/ledger-core) |
| 2 · The ingest layer | ✅ | [`packages/ingest`](packages/ingest) — three halves: webhooks, PSP reports, bank statements |
| 3 · The reconciliation engine | ✅ | [`packages/reconciler`](packages/reconciler) — three-way, see D-027 |
| 4 · Exceptions and settlement windows | ✅ | [`packages/reconciler/src/exceptions.ts`](packages/reconciler/src/exceptions.ts) — an appended lifecycle, a self-clearing queue, and the candidates the matcher rejected |
| 5 · Event sourcing and replay | ✅ | [`packages/ledger-core/src/replay.ts`](packages/ledger-core/src/replay.ts) — a log written beside the ledger and folded back to prove it, see D-047 |
| 6 · The API and the service | ✅ | [`apps/api`](apps/api) — three rails, a durable webhook inbox ([`packages/inbox`](packages/inbox)) and a worker that empties it, see D-050 |
| 7 · Containerisation | ✅ | [`Dockerfile`](Dockerfile), [`docker-compose.yml`](docker-compose.yml) — brought forward, see D-022 |
| 8 · Testing and chaos | ✅ | [`packages/simulator`](packages/simulator) — a seeded adversary, driven in every arrival order, see D-058 |
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

Unexplained findings become durable queue items that deduplicate across runs, escalate when
their window passes, and close themselves when the evidence finally arrives — each carrying
the near-misses the matcher rejected. Everything that happens is also appended to one ordered
event log, which `replay` folds from genesis to prove the balances can be rebuilt from it.

All of it is now reachable over HTTP. Three rails enter the service and stay separate: a
webhook is signature-verified and written to a durable inbox in milliseconds — the promise
made to a PSP is "we safely received this event", not "we finished every downstream
operation" — and a worker gives it meaning afterwards, claiming deliveries with `SKIP
LOCKED` so scaling is starting another process. Settlement exports and bank statements are
uploaded as the bytes themselves, because the bytes are the evidence and their hash is its
identity. Nothing books cash except a reconciliation run finding a bank credit that confirms
a payout.

And none of it is taken on trust. A seeded adversary generates the settlement files, bank
statements and signed deliveries of a deliberately messy day — a renegotiated fee contract
with payments on both sides of it, a reversal, a chargeback, a bank charge nobody announced,
a payout still inside its window, and one credit that belongs to nobody — declares in advance
what each of those is and where the books must land, and then feeds them in *every arrival
order*. Each order visits states the tidy one never does, raising findings that must clear
themselves when the evidence lands, and all of them must end with the same balances, to the
kobo, and the same single item in the queue.

**What does not exist yet**: the dashboard (Phase 9). And what the company's own product
database contributes is deliberately nothing but a reference — *"customer A bought service
X"* is a question for that database, joined on the payment reference this one stores (D-049).

## Layout

```
packages/canon         the shared language — types only, depends on nothing
packages/ledger-core   the double-entry engine, and the only path to writing money
packages/ingest        the anti-corruption boundary — no database, no I/O
packages/reconciler    the matching engine                (Phase 3)
packages/inbox         durable acceptance: store the delivery, answer, work it later
packages/policy        the seam — ingest's calendars joined to the database's contracts
packages/simulator     the adversary: seeded files with planted anomalies  (Phase 8)
apps/api               the Fastify service                (Phase 6)
apps/pipeline          the other deployable: a CLI over the same libraries
```

Dependencies point one way only, downward toward `canon`. No cycles.

## Documents

| Document | What it is |
|---|---|
| [docs/RECONCILIATION-BIBLE.md](docs/RECONCILIATION-BIBLE.md) | The doctrine: core beliefs, the seven Laws, target attributes, and the ten build phases with exit criteria. **The specification.** |
| [docs/FIRST-PRINCIPLES.md](docs/FIRST-PRINCIPLES.md) | Why the design is what it is, derived from scratch: why a balance is never a fact, why double-entry falls out of conservation, what reconciliation actually is. |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Libraries vs. deployables, the one-directional dependency graph, and how it becomes a containerised service. |
| [docs/DECISIONS.md](docs/DECISIONS.md) | The decision log — 57 entries, each with its reasoning and the alternatives rejected. Read this before changing anything structural. |
| [AGENTS.md](AGENTS.md) | Engineering rules for anyone (human or agent) writing code here. |

## Where the Laws are enforced

Not in comments, and mostly not in TypeScript.

| Law | Enforced by |
|---|---|
| 1 · entries sum to zero | a **deferred** constraint trigger in Postgres, firing at `COMMIT` |
| 2 · append-only | `BEFORE UPDATE OR DELETE` triggers on every history table, ledger and reconciliation alike |
| 3 · integer kobo | `BIGINT` columns; `bigint` in TypeScript; amounts cast from text, never a JS number — including inside JSONB |
| 4 · idempotency | the primary key **is** the event's idempotency key — and at the door, one layer earlier, a webhook delivery's id is the SHA-256 of its own bytes, so a redelivery collides before anything is parsed |
| 5 · determinism | derived ids, no `randomUUID` in a write path, `asOf` always passed in, non-overlapping fee contracts, versioned holiday tables, an apportionment tie-break that does not depend on iteration order |
| 6 · cache == recompute | `verifyBalances()`, run by the demo and the property test; and `replay()`, which folds the event log and checks the entries, the cache and the log against each other |
| 7 · canonical boundary | `packages/canon` is a leaf; the matcher is handed a calendar and a fee model, never a source name |
| maker-checker | an `ApprovalPolicy` in the application, and a `CHECK` constraint that refuses self-approval in the database |

Two more invariants live in the database because application code cannot be trusted with
them: a payment can never be allocated beyond its receivable (a deferred trigger), and one
bank credit can confirm at most one payout (a partial unique index).
