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
| `GET` | `/deliveries/:deliveryId` | What became of an accepted webhook, down to the ledger transaction id, and which version of its payload is still held |
| `GET` | `/balances` | Every account, its meaning, and its balance in kobo |
| `POST` | `/ingest/settlement/:source` | Raw bytes · 501 for a source with no adapter |
| `POST` | `/ingest/bank` | Raw bytes |
| `POST` | `/reconcile/runs` | What was concluded, what was booked, what could not be explained |
| `GET` | `/reconciliation/summary?from&to` | Matched, explained and exception counts, plus money reported and not yet banked |
| `GET` | `/exceptions`, `/exceptions/:key` | The queue, worst first, with the candidates the matcher rejected |
| `POST` | `/exceptions/:key/resolve` | Maker-checked; an unapproved write-off is a 422 |
| `GET` | `/evidence/:id` | Metadata and the document's own access log. No personal data, so no grant. |
| `GET` | `/evidence/:id/raw?reason=` | The bytes. Needs the `evidence.raw` grant and a reason; 410 once retention has run. |
| `POST` | `/evidence/:id/exports` | Redacted by default; an original needs a second named approver. Needs `evidence.export`. |
| `GET` | `/evidence/exports/:token` | The sealed archive, once, before it expires. The token is the credential. |

Management endpoints require `X-API-Key`, and the key belongs to a **named principal** whose
name is what every audit record carries
([ADR-0066](../../docs/adr/0066-pci-scope-and-evidence-access.md)). Webhooks authenticate by
the provider's signature and nothing else, because a provider holds no credential of ours
([ADR-0052](../../docs/adr/0052-two-authentication-rails.md)).

## The data-protection boundary

`POST /webhooks/:source` gained a fifth step, between the signature check and the insert: a
delivery carrying a card number or sensitive authentication data is refused with a 422 and
**nothing is stored**. This is the only place in the system that can keep card data out of
the database, because the step after it is the durable acceptance the whole rail is built
around. The upload rails are guarded the same way, inside `@recon/ingest`.

The worker redacts each delivery's payload in the same transaction that records what it
meant, so there is no window in which a delivery is both worked and unredacted
([ADR-0064](../../docs/adr/0064-redaction-at-the-boundary.md)). Evidence uploaded here is
encrypted per record before it is stored, and `receivedFrom` is the verified principal rather
than a name the caller supplied about itself.

## Running it

    docker compose up --build

    curl localhost:8080/health
    curl -H 'x-api-key: local-dev-key-0123456789' localhost:8080/balances
    curl -X POST -H 'x-api-key: local-dev-key-0123456789' localhost:8080/reconcile/runs

    # The bytes of a document, which needs the grant and a reason.
    curl -H 'x-api-key: local-dev-audit-0123456789'       'localhost:8080/evidence/<id>/raw?reason=dispute%204417'

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
logic lives in this layer — plus, since ADR-0066, that a delivery carrying a synthetic PAN is
refused with nothing stored, that a worked delivery keeps its reference and loses the
customer, that a valid key without `evidence.raw` is a 403, and that an original export
without a second named person is a 422.
