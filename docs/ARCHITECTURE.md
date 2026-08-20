# Architecture

## Layout

The repository is an npm workspace monorepo with two kinds of module.

- **`packages/*` are libraries.** They are imported. They have no entry point and bind no
  port.
- **`apps/*` are deployables.** They have a `main`, they run, and they wire libraries
  together.

Keeping them apart means the domain logic can be tested without a server and reused by more
than one runnable. The ledger does not know it is being served over HTTP.

## Packages

| Package | Responsibility | Depends on |
|---|---|---|
| `canon` | The shared vocabulary: `Money`, `CanonicalPayment`, `SettlementLine`, `Account`, `Entry`, `LedgerTransaction`, reason codes. Types and constants, almost no behaviour. | nothing |
| `ledger-core` | The double-entry engine and the only write path for money: `postTransaction`, `balance`, `reverse`, the transaction lifecycle, migrations, the event log. | `canon`, `pg` |
| `ingest` | The anti-corruption boundary. Provider bytes in, canonical events out. No database, no clock, no network. | `canon`, `protect`, `@pay-normalize/*` |
| `protect` | The data-protection boundary: refuse card data, reduce a payload to what the matcher reads, encrypt what is kept. No database, no clock. | `canon` |
| `reconciler` | Matching, in two stages: allocation against provider reports, and confirmation against bank statements. Also the exception queue, human resolutions, and evidence storage, retention, access and export. | `canon`, `ledger-core`, `protect` |
| `inbox` | Durable webhook acceptance: one table, `accept` and `drain`. | `canon`, `ledger-core`, `pg` |
| `policy` | Joins `ingest`'s calendars to the fee contracts in the database and returns the lookup the matcher takes as an argument. | `canon`, `ingest`, `ledger-core`, `reconciler` |
| `simulator` | A seeded generator of provider-format files and signed deliveries, with declared ground truth. Used by the end-to-end suite and by the CLI. | `canon`, one connector's signing helpers |

## Applications

| App | What it is |
|---|---|
| `apps/api` | The Fastify service. Binds a port, receives webhooks, accepts evidence uploads, exposes balances, summaries and the exception queue, and drains the inbox in the background. |
| `apps/pipeline` | A CLI over the same libraries: `migrate`, `demo`, `simulate`, `balances`, `verify`, `replay`, `ingest-settlement`, `ingest-bank`, `reconcile`, `exceptions`, `evidence-retention`. |

The two deployables share every package. The CLI covers what a service is the wrong tool
for: a scheduled `replay`, a scheduled `evidence-retention`, a one-off ingest of a local
file, and the demo. Retention is a command rather than a background thread on purpose — a
deletion of financial evidence should be something somebody scheduled, with an output
somebody reads ([ADR-0065](adr/0065-evidence-retention-schedule.md)).

## Dependency graph

Dependencies point one way only, toward `canon`. There are no cycles, and TypeScript project
references enforce that at build time.

| From | Imports |
|---|---|
| `apps/api` | `canon`, `ledger-core`, `ingest`, `reconciler`, `policy`, `inbox`, `protect`, `fastify` |
| `apps/pipeline` | `canon`, `ledger-core`, `ingest`, `reconciler`, `policy`, `inbox`, `protect` |
| `policy` | `canon`, `ledger-core`, `ingest`, `reconciler` |
| `inbox` | `canon`, `ledger-core`, `pg` |
| `reconciler` | `canon`, `ledger-core`, `protect` |
| `ingest` | `canon`, `protect`, `@pay-normalize/*` |
| `protect` | `canon` |
| `canon` | nothing |

Three edges are deliberately absent:

- **`ingest` does not import `ledger-core`.** Ingest produces canonical events; deciding what
  to do with them belongs elsewhere. This keeps ingest a pure translator.
- **`ledger-core` does not import `ingest`.** The ledger must be provable in isolation from
  where its inputs came from.
- **`reconciler` does not import `ingest`.** With that edge the matcher could look up a
  source and branch on its name. `policy` exists so the join happens somewhere that decides
  nothing. See [ADR-0055](adr/0055-the-policy-join-is-a-package.md).

`inbox` also does not import `ingest`, or `protect`: it stores and hands back a delivery
without any opinion about what a delivery means, or about which of its fields are worth
keeping. Both the handler and the redactor are supplied by the deployable.

## Request flow

Three inbound rails reach the service and stay separate.

    POST /webhooks/:source            verify the signature over the raw bytes
                                      -> refuse anything carrying card data, storing nothing
                                      -> one row in webhook_inbox -> 200
       (a worker, moments later)      -> ingest normalises -> ledger-core books the promise
                                      -> the payload is reduced to a keep-list, in the same
                                         transaction that records what it meant

    POST /ingest/settlement/:source   the provider's claim  -> evidence + payouts. Books nothing.
    POST /ingest/bank                 the bank's statement  -> evidence + statement lines.

    POST /reconcile/runs              allocation, then bank confirmation. The only path that
                                      books cash.

The webhook rail is asynchronous because a remote system is on a retry timer and the only
answer that can honestly be given in milliseconds is that the event was received. The upload
rails are synchronous because nobody is on a timer, and the operator would rather have the
stored counts than a receipt. See [ADR-0050](adr/0050-webhooks-accepted-durably.md) and
[ADR-0051](adr/0051-upload-rails-parse-synchronously.md).

## Where the invariants are enforced

Most of them are not in TypeScript.

| Invariant | Enforced by |
|---|---|
| A transaction's entries sum to zero | a deferred constraint trigger in Postgres, firing at `COMMIT` |
| History is append-only | `BEFORE UPDATE OR DELETE` triggers on every history table, ledger and reconciliation alike |
| Money is integer kobo | `BIGINT` columns; `bigint` in TypeScript; amounts cast from text, never a JS number, including inside JSONB |
| Idempotency | the primary key is the event's idempotency key; at the door, a webhook delivery's id is the SHA-256 of its own bytes |
| Determinism | derived ids, no `randomUUID` in a write path, `asOf` always passed in, non-overlapping fee contracts, versioned holiday tables, an apportionment tie-break independent of iteration order |
| Cached balance equals recomputed balance | `verifyBalances()`, run by the demo and the property test, and `replay()`, which folds the event log and checks entries, cache and log against each other |
| The canonical boundary | `packages/canon` is a leaf; the matcher is handed a calendar and a fee model, never a source name |
| Maker-checker | an `ApprovalPolicy` in the application, and `CHECK` constraints that refuse self-approval — on resolutions, and on original evidence exports |
| No card data is stored | a scan at the webhook request path *before* the insert, and again inside `ingest`; a Luhn-valid number under a real issuer prefix and length, or a field named as sensitive authentication data, is refused and nothing is written |
| Evidence is never stored in the clear | `recordEvidence` takes a key ring and there is no unencrypted column to write to; the ciphertext is bound to the evidence id, so it cannot be moved between rows |
| A purge really purged | a `CHECK` constraint that a blob marked purged holds no ciphertext |
| Every read of a document is attributable | an append-only `evidence_access` table naming the verified principal, and a `reason` the database requires for anything that hands over bytes |

Two further invariants live in the database because application code cannot be trusted with
them: a payment can never be allocated beyond its receivable (a deferred trigger), and one
bank credit can confirm at most one payout (a partial unique index).

## Deployment

The image contains one program and its whole world. The packages are compiled into it as
dependencies of the app, no differently from Fastify — the only difference is that they
resolve from `packages/` rather than from the registry.

1. `FROM node:20` provides the OS and runtime.
2. The workspace manifest and packages are copied in, and `npm ci` resolves external
   dependencies and links the internal ones.
3. `tsc --build` compiles the packages in dependency order, then the app.
4. The start command decides what the image is: `node apps/api/dist/main.js` for the
   service, overridden for the CLI.
5. Postgres runs as its own container. `docker-compose.yml` describes both as one system.

The service applies migrations at startup while holding an advisory lock, so a fresh machine
needs one command and concurrent replicas cannot race
([ADR-0056](adr/0056-migrations-run-on-boot-under-a-lock.md)).

## Related documents

- [Domain model](DOMAIN-MODEL.md) — accounts, the payment lifecycle, and how matching works.
- [Decision records](adr/README.md) — why the design is what it is.
