# apps/api

The Fastify service. It binds a port, receives webhooks, accepts the two evidence uploads,
exposes the books and the exception queue, drains the inbox in the background, and — when it
is told to — reconciles on a schedule.

It runs alongside [`apps/pipeline`](../pipeline): one set of libraries, two ways to run them.

## Three rails, and only one books cash

    POST /webhooks/:source            verify the signature over the raw bytes
                                      -> one row in webhook_inbox -> 200, in milliseconds
       (the worker, moments later)    -> ingest normalises -> ledger-core books the promise

    POST /ingest/settlement/:source   the provider's claim -> evidence + payouts. Books nothing.
    POST /ingest/bank                 the bank's proof     -> evidence + statement lines.

    POST /reconcile/runs              allocation, then bank confirmation. The only path to cash.
       (or the scheduler, on an       same call, no person involved. OFF by default — see
        interval)                     "Two loops, and one of them is off" below.

The webhook rail is asynchronous because a remote system is on a retry timer. The upload
rails are synchronous because nobody is, and the operator would rather have the stored counts
than a receipt ([ADR-0050](../../docs/adr/0050-webhooks-accepted-durably.md),
[ADR-0051](../../docs/adr/0051-upload-rails-parse-synchronously.md)).

## Endpoints

| Method | Path | Notes |
|---|---|---|
| `GET` | `/health` | Database reachability, inbox depth, and a **verdict**: 503 once a threshold is breached, with a sentence per breach in `alerts`. No authentication — a health check that needs a credential is one the load balancer cannot make. |
| `POST` | `/webhooks/:source` | 200 accepted · 401 bad signature · 404 unknown source · 503 no secret configured |
| `GET` | `/deliveries/:deliveryId` | What became of an accepted webhook, down to the ledger transaction id, and which version of its payload is still held |
| `GET` | `/balances` | Every account, its meaning, and its balance in kobo |
| `POST` | `/ingest/settlement/:source` | Raw bytes · 501 for a source with no adapter |
| `POST` | `/ingest/bank` | Raw bytes |
| `POST` | `/reconcile/runs` | What was concluded, what was booked, what could not be explained |
| `GET` | `/reconciliation/summary?from&to` | Matched, explained and exception counts, plus money reported and not yet banked |
| `GET` | `/exceptions`, `/exceptions/:key` | The queue, worst first, with the candidates the matcher rejected |
| `POST` | `/exceptions/:key/resolve` | Maker-checked; an unapproved write-off is a 422 |
| `GET` | `/reserves` | Money a PSP withheld and has not returned, oldest first. A hold with no `dueAt` belongs to a source that declared no schedule: never overdue, never self-clearing. |
| `GET` | `/bank/position` | Our books against the bank's own running balance. Catches a half-ingested statement; proves **nothing** about where the file came from. |
| `POST` | `/bank/attestations` | A named person compared the books to the bank's portal. Append-only; `attestedBy` is the authenticated principal, never a name the body supplied. |
| `GET` | `/evidence/:id` | Metadata and the document's own access log. No personal data, so no grant. |
| `GET` | `/evidence/:id/raw?reason=` | The bytes. Needs the `evidence.raw` grant and a reason; 410 once retention has run. |
| `POST` | `/evidence/:id/exports` | Redacted by default; an original needs a second named approver. Needs `evidence.export`. |
| `GET` | `/evidence/exports/:token` | The sealed archive, once, before it expires. The token is the credential. |

Management endpoints require `X-API-Key`, and the key belongs to a **named principal** whose
name is what every audit record carries
([ADR-0066](../../docs/adr/0066-pci-scope-and-evidence-access.md)). Webhooks authenticate by
the provider's signature and nothing else, because a provider holds no credential of ours
([ADR-0052](../../docs/adr/0052-two-authentication-rails.md)).

## Two loops, and one of them is off

The inbox worker always polls: a provider is on a retry timer and the deliveries are already
durable, so there is nothing to decide.

The **reconcile scheduler** starts only when `RECON_RECONCILE_INTERVAL_MS` is set, and the
default is off. A deployment driving runs from its own cron must not have an internal timer
racing it, and two replicas would both run it — safely, since every write a run makes is keyed
and a concurrent second run duplicates nothing, but it duplicates the work, which somebody
should choose rather than inherit.

The consequence of setting neither is the quietest failure this service has: nothing surfaces
an exception except a run, so the three records pile up and the empty queue reads exactly like
a clean set of books. So the absence is made loud — a warning at boot, and a
`reconciliation_stale` verdict on `/health`
([ADR-0074](../../docs/adr/0074-the-last-mile-is-a-schedule-and-a-verdict.md)).

## /health reaches a verdict

It used to report `pending` and `failed` and leave the reader to decide what a big number
meant, which in practice means nobody decided: a monitor watching for a non-200 watches a
queue grow all weekend and never fires. Six thresholds now live in configuration, and the
status code moves — 200 while merely busy, **503** once one is breached — because a status
code is the one signal every monitor already understands.

`inbox_backlog` · `inbox_failed` · `inbox_stale` · `exception_queue` ·
`reconciliation_stale` · `bank_unattested`

Use it as a readiness or alerting target, never as a liveness probe: a degraded service is up,
and restarting it fixes nothing. Every threshold set to `0` disables that verdict.

It is deliberately not a notifier. An email or Slack client is a credential, a retry policy and
an outbound dependency, and every deployment already has something that watches an HTTP
endpoint — this makes the endpoint worth watching. It also no longer returns the database
driver's error text: a `pg` connection failure carries the host and port, and this endpoint is
unauthenticated.

## Rate limiting, and what it is not

`/webhooks/:source` is unauthenticated by design, and the work of deciding a delivery is *not*
authentic all happens before the 401: the body is buffered and an HMAC-SHA512 is computed over
every byte of it. A per-caller ceiling runs as the earliest `onRequest` hook on each rail —
before the body is read, which is the whole point.

Per-process and in-memory, so two replicas allow twice the rate, a restart forgets everything,
and a thousand source addresses are a thousand callers. **This is the floor, not the control.**
A limit that holds against a distributed flood belongs at a WAF or gateway where it can see all
the traffic; set `RECON_TRUST_PROXY=true` behind one, or every caller shares the balancer's
address and the per-address limit becomes a global one. `/health` is never limited — a health
check refused with a 429 is a load balancer removing a healthy instance from rotation.

## Rotating a webhook secret

A delivery is verified twice: at the door, and again by the worker before it is interpreted.
Rotating a secret while a backlog exists used to fail that second check for every pending
delivery signed with the old one — and the worker's answer to a signature that no longer
verifies is `rejected`, which is terminal. Real payments, discarded, because a credential was
rotated on a busy afternoon.

`RECON_WEBHOOK_SECRET_<SOURCE>_PREVIOUS` is tried alongside the current secret, so the rotation
is: set `_PREVIOUS` to the outgoing secret, set the current one to the new secret, wait for
`/health` to report `inbox.pending == 0`, remove `_PREVIOUS`
([ADR-0073](../../docs/adr/0073-retries-back-off-and-secrets-overlap.md)).

## The trust boundary

`POST /ingest/bank` is behind an API key and that is the whole control over what books cash.
Anyone holding an ingest key can produce a statement that confirms inflows and moves
`psp_receivable` into `bank_account`; there is no signature on the bytes and no feed. `verify`
cannot catch a fabrication, because it proves internal conservation and a fabricated statement
that balances is internally conserved.

`GET /bank/position` is what the service can check by itself. `POST /bank/attestations` records
a person checking the bank's own portal, and `bank_unattested` notices when nobody has. Neither
is a fix — the open-banking feed is
([ADR-0068](../../docs/adr/0068-the-bank-file-is-the-trust-boundary.md)).

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

Ajv's type coercion is **off**, which is a money decision rather than a style one. It is on by
default, so a body sending `{"portalBalanceKobo": 100}` against a `type: 'string'` schema would
be quietly turned into `"100"` and accepted — which defeats the reason every amount crosses
this boundary as a decimal string. A JSON number is a double, and `9007199254740993` has
already lost its last digit by the time `JSON.parse` returns, so the coerced string is a wrong
amount that validates perfectly. The caller sent a number, and the number is not the one they
meant.

## Tests

`src/api.test.ts` drives every endpoint through the real router via `app.inject()`, with no
port bound, against a real Postgres. It asserts correct status codes and authentication, a
signed webhook flowing end to end into an `authorized` transaction, and that no business
logic lives in this layer — plus, since ADR-0066, that a delivery carrying a synthetic PAN is
refused with nothing stored, that a worked delivery keeps its reference and loses the
customer, that a valid key without `evidence.raw` is a 403, and that an original export
without a second named person is a 422.

It runs with the rate limits and every alert threshold set to **0**, deliberately. The suite
makes hundreds of requests from one address in seconds and constructs, on purpose, the very
states the alerts exist to report — so leaving either on would make `/health` answer 503 for
reasons the suite arranged, and every other test's meaning would depend on the order they ran
in. `src/ratelimit.test.ts` proves the limiter directly, against a clock it is handed.
