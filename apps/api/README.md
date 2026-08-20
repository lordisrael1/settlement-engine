# apps/api

The Fastify service. It binds a port, receives webhooks, accepts the two evidence uploads,
exposes the books and the exception queue, and drains the inbox in the background.

It runs alongside [`apps/pipeline`](../pipeline): one set of libraries, two ways to run them.

## Three rails, and only one books cash

    POST /webhooks/:source            verify the signature over the raw bytes
                                      -> one row in webhook_inbox -> 200, in milliseconds
       (the worker, moments later)    -> ingest normalises -> ledger-core books the promise

    POST /ingest/settlement/:source   the provider's claim -> evidence + payouts. Books nothing.
    POST /ingest/bank                 the bank's proof     -> evidence + statement lines.

    POST /reconcile/runs              allocation, then bank confirmation. The only path to cash.

The webhook rail is asynchronous because a remote system is on a retry timer. The upload
rails are synchronous because nobody is, and the operator would rather have the stored counts
than a receipt ([ADR-0050](../../docs/adr/0050-webhooks-accepted-durably.md),
[ADR-0051](../../docs/adr/0051-upload-rails-parse-synchronously.md)).

## Endpoints

| Method | Path | Notes |
|---|---|---|
| `GET` | `/health` | Database reachability and inbox depth. No authentication — a health check that needs a credential is one the load balancer cannot make. |
| `POST` | `/webhooks/:source` | 200 accepted · 401 bad signature · 404 unknown source · 503 no secret configured |
| `GET` | `/deliveries/:deliveryId` | What became of an accepted webhook, down to the ledger transaction id |
| `GET` | `/balances` | Every account, its meaning, and its balance in kobo |
| `POST` | `/ingest/settlement/:source` | Raw bytes · 501 for a source with no adapter |
| `POST` | `/ingest/bank` | Raw bytes |
| `POST` | `/reconcile/runs` | What was concluded, what was booked, what could not be explained |
| `GET` | `/reconciliation/summary?from&to` | Matched, explained and exception counts, plus money reported and not yet banked |
| `GET` | `/exceptions`, `/exceptions/:key` | The queue, worst first, with the candidates the matcher rejected |
| `POST` | `/exceptions/:key/resolve` | Maker-checked; an unapproved write-off is a 422 |

Management endpoints require `X-API-Key`. Webhooks authenticate by the provider's signature
and nothing else, because a provider holds no credential of ours
([ADR-0052](../../docs/adr/0052-two-authentication-rails.md)).

## Running it

    docker compose up --build

    curl localhost:8080/health
    curl -H 'x-api-key: local-dev-key-0123456789' localhost:8080/balances
    curl -X POST -H 'x-api-key: local-dev-key-0123456789' localhost:8080/reconcile/runs

## What does not belong here

No business logic. Every handler parses the request, calls one package function and
serialises the answer. The period summary lives in the reconciler because the reason-code
taxonomy lives in `canon`, and the resolution flow lives there because closing a queue item,
recording a decision and posting its compensating entry is one database transaction
([ADR-0054](../../docs/adr/0054-domain-logic-stays-out-of-the-api.md)).

What this layer does own: raw bytes preserved for signature verification, `bigint` crossing
as a decimal string and never as a JSON number, and each domain refusal mapped to a status
code carrying the engine's own message rather than a generic one.

## Tests

`src/api.test.ts` drives every endpoint through the real router via `app.inject()`, with no
port bound, against a real Postgres. It asserts correct status codes and authentication, a
signed webhook flowing end to end into an `authorized` transaction, and that no business
logic lives in this layer.
