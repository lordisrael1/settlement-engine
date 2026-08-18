# apps/api — the service

**The long-lived process.** A Fastify service that binds a port, receives webhooks, accepts
the two evidence files, exposes the books and the queue, and drains the inbox in the
background.

It **joins** [`apps/pipeline`](../pipeline) rather than replacing it — one set of libraries,
two ways to run them. Nothing under `packages/` changed when it arrived, which is what the
library/deployable split was for ([D-022](../../docs/DECISIONS.md)).

## Three rails, and only one of them books cash

```
POST /webhooks/:source            verify the signature over the raw bytes
                                  → one row in webhook_inbox → 200, in milliseconds
   (the worker, moments later)    → ingest normalises → ledger-core books the promise

POST /ingest/settlement/:source   the PSP's claim   → evidence + payouts. BOOKS NOTHING.
POST /ingest/bank                 our bank's proof  → evidence + statement lines.

POST /reconcile/runs              stage two, then stage three — the only path to cash.
```

The webhook rail is asynchronous because a remote system is on a retry timer and the only
promise worth making it is *"we safely received this event"*. The upload rails are
synchronous because nobody is on a timer, and the operator would rather have the counts than
a receipt. Two different questions, two different answers ([D-050](../../docs/DECISIONS.md),
[D-051](../../docs/DECISIONS.md)).

## The contract

| | | |
|---|---|---|
| `GET` | `/health` | database reachability and how far behind the inbox is. No auth — a health check that needs a credential is one the load balancer cannot make. |
| `POST` | `/webhooks/:source` | 200 accepted · 401 bad signature · 404 unknown source · 503 no secret configured |
| `GET` | `/deliveries/:deliveryId` | what became of an accepted webhook, down to the ledger transaction id |
| `GET` | `/balances` | every account, its meaning, and its balance in kobo |
| `POST` | `/ingest/settlement/:source` | the file as raw bytes · 501 for a source with no adapter |
| `POST` | `/ingest/bank` | the file as raw bytes |
| `POST` | `/reconcile/runs` | what it concluded, what it booked, what it could not explain |
| `GET` | `/reconciliation/summary?from&to` | matched / explained / exceptions, plus money reported and not yet banked |
| `GET` | `/exceptions` · `/exceptions/:key` | the queue, worst first, with the candidates the matcher rejected |
| `POST` | `/exceptions/:key/resolve` | through maker-checker: an unapproved write-off is a 422 |

Two rails of authenticity, deliberately. Management endpoints need `X-API-Key`; webhooks
authenticate by the provider's signature and nothing else, because a PSP holds no credential
of ours ([D-052](../../docs/DECISIONS.md)).

## Run it

```bash
docker compose up --build

curl localhost:8080/health
curl -H 'x-api-key: local-dev-key-0123456789' localhost:8080/balances
curl -X POST -H 'x-api-key: local-dev-key-0123456789' localhost:8080/reconcile/runs
curl -X POST -H 'x-api-key: local-dev-key-0123456789' \
     --data-binary @settlements.json localhost:8080/ingest/settlement/flutterwave
```

## What is deliberately not here

No business logic. Every handler is three lines — parse the request, call one package
function, serialise the answer — and the two things that nearly leaked in went back where
they belonged: the period summary into the reconciler, because the reason-code taxonomy
lives in `canon` and a second copy in a route's SQL could disagree with it; and the
resolution flow, because closing a queue item, recording a decision and posting its
compensating entry is one database transaction, not three HTTP-handler statements
([D-054](../../docs/DECISIONS.md)).

What this layer *does* own is real: raw bytes preserved for signature verification, `bigint`
crossing as a decimal string and never as a JSON number, and each domain refusal mapped to
the status code it deserves, carrying the engine's own message rather than a generic one.

If you find a Law being enforced in this directory, it is in the wrong place.

**Exit criterion, met.** Every capability is reachable by `curl` with correct status codes
and auth; a signed webhook flows end to end into an `authorized` transaction; no business
logic lives in this layer. `apps/api/src/api.test.ts` asserts all three through
`app.inject()`, against a real Postgres.
