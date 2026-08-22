# 74. The last mile: reconciliation runs itself, and health reaches a verdict

Date: 2026-08-22

## Status

Accepted

## Context

Everything in this system is built so that a difference cannot disappear quietly. The engine
finds the anomaly, gives it a derived key and a lifecycle, sorts the queue worst-first, keeps
the candidates it rejected, and clears itself when the evidence arrives.

And then it waited for somebody to remember to look.

**Nothing reconciled on its own.** The webhook worker polls. The uploads happen when a file
arrives. But `reconcile` ran only when a person called `POST /reconcile/runs` or typed the CLI
command. A deployment that shipped without an external cron never surfaced an exception at
all: the three records piled up, the queue stayed empty, and an empty queue reads exactly like
a clean set of books. The most dangerous state this system can be in is the one that looks
best.

**Nothing said a number was bad.** `/health` reported `pending` and `failed` and left the
reader to decide what a big number meant — which in practice means nobody decided. A monitor
watching for a non-200 watches a queue grow all weekend and never fires, because the service
is up and cheerfully says so. `failed > 0` is a payment nobody will ever retry, and it was a
field in a JSON body that nothing compared to anything.

**And `/health` leaked.** On a database failure it returned `error: error.message`. A `pg`
connection error carries the host, the port and sometimes the user, and this endpoint is
unauthenticated by design — a health check that needs a credential is a health check the load
balancer cannot make.

Separately, the one unauthenticated write in the system had no rate limit. `/webhooks/:source`
is authenticated by the signature over the body (ADR-0052), which means the work of deciding a
delivery is *not* authentic all happens before the 401: up to `webhookBytes` are buffered and
an HMAC-SHA512 is computed over every byte. Junk never reached the database — always the
important half — but it still cost CPU and memory in proportion to how much of it arrived, on
a URL anybody who has read the docs can find.

## Decision

**A scheduler, off by default.** `startReconcileScheduler` is the same shape as the inbox
worker: a poll, a clock passed in, an unref'd timer, rescheduled from the *end* of the previous
run so a long reconciliation does not stack on itself. `RECON_RECONCILE_INTERVAL_MS` turns it
on.

Off by default because a deployment driving runs from its own cron must not have an internal
timer racing it, and because two replicas would both run it. Running it twice is *safe* — every
write a run performs is keyed, so a concurrent second run duplicates nothing — but it
duplicates the work, which is a decision somebody should make rather than inherit. It
deliberately takes no advisory lock: that would be a second, quieter scheduler-election
mechanism to reason about.

The absence is made loud instead. The service logs a warning at boot when it is unset, and
`/health` raises `reconciliation_stale`.

**`/health` reaches a verdict.** Thresholds live in configuration; `alerts.ts` compares; the
response carries an `alerts` array of sentences in the terms of the business; and the **status
code moves** — 200 while merely busy, 503 once something is breached. That last part is the
whole point: a status code is the one signal every monitor already understands, and the last
mile is getting a person's attention without them remembering to look.

Six verdicts: `inbox_backlog`, `inbox_failed`, `inbox_stale`, `exception_queue`,
`reconciliation_stale`, `bank_unattested`.

`inbox_backlog` subtracts the deliveries that are merely backing off (ADR-0073), and
`inbox_stale` watches the *age* of the oldest unworked delivery separately — a deep queue on a
busy morning is the system working, and a shallow queue whose oldest member arrived an hour
ago is a worker that died. `exception_queue` counts `open` only, never `acknowledged`: paging
a team for the fact that they are doing their jobs is how an alert gets muted.

`reconciliation_stale` reads `MAX(at)` from `matches` rather than a "last run" row somebody
has to remember to write — a status column can be updated by a run that then failed, and a
conclusion cannot be written by a run that did not happen.

This is deliberately **not** a notifier. No email, no Slack, no PagerDuty client — each of
those is a credential, a retry policy and an outbound dependency, and every deployment already
has something that watches an HTTP endpoint. This makes the endpoint worth watching.

**`/health` stops leaking.** The driver's error goes to the log, where the operator is; the
caller gets "The database is unreachable. See the service log for the reason."

**A rate limiter, in-process and honest about it.** A fixed-window counter with a bounded key
map — bounded because the keys are chosen by whoever is calling, and an unbounded map keyed by
attacker-supplied values is a memory-exhaustion bug wearing the costume of a defence against
one. Registered per plugin as an `onRequest` hook, the earliest Fastify offers, so it runs
before the body is read: the cost being defended against is buffering and hashing, and a
limiter that ran after parsing would already have paid it.

Keyed by client address on the webhook rail, where there is no principal by design; by
principal on the management and ingest rails, so one operator's runaway script cannot lock out
another's. `/health` is never limited — a health check refused with a 429 is a load balancer
removing a healthy instance from rotation.

What it is not, stated in the code and the README: per-process and in-memory, so two replicas
allow twice the rate, a restart forgets everything, and a thousand source addresses are a
thousand callers. A limit that holds against a distributed flood belongs at the edge — a WAF,
a gateway — where it can see all the traffic and drop it before it costs a TLS handshake. This
is the floor, and it means a deployment that forgets the gateway is no longer completely open.

`RECON_TRUST_PROXY` matters more now than it did: behind a load balancer with it unset, every
caller shares the balancer's address and the per-address limit becomes a global one.

## Consequences

An operator who does nothing but point an existing uptime monitor at `/health` now finds out
about a stalled worker, a dead scheduler, a failed delivery and a queue nobody is working —
none of which they would have found out about before.

The 503 is a real behaviour change for anything using `/health` as a liveness probe. A
degraded service is *up*, and a Kubernetes liveness probe on this endpoint would restart it
pointlessly. Use it as a readiness or alerting target; the README says so, and every threshold
can be set to `0` to disable it.

Enabling the scheduler on more than one replica doubles the reconciliation work. Correct
answers, wasted queries.

The `alerts` array is unauthenticated, and its sentences reveal queue depths and delivery
counts. That is a deliberate trade — the numbers are operational rather than financial, they
name no customer, no amount and no reference, and an alert nobody can read is not an alert.
