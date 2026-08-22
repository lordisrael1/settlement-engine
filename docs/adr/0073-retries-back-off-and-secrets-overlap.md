# 73. Retries back off, and a rotated secret keeps its predecessor

Date: 2026-08-22

## Status

Accepted — amends ADR-0050

## Context

ADR-0050 makes the durable inbox the promise this system gives a PSP: the bytes are written
down, then acknowledged, and a worker interprets them afterwards. A handler that *throws* is
saying "I could not do my job just now", which is the retryable case and the only one.

Two things about how that retry worked turned transient problems into permanent losses.

**There was no delay between attempts.** The drain claimed `state = 'pending' AND attempts <
maxAttempts` on a fixed `intervalMs` timer, and `recordFailure` incremented `attempts` the
moment a handler threw. Nothing sat between those two facts, so with the shipped defaults —
500ms interval, 8 attempts — a delivery's entire retry budget was spent in **four seconds**.

For the failure the design was built around this is fine: when Postgres is unreachable the
whole transaction fails, `attempts` never moves, and the delivery waits as long as it has to.
The dangerous case is the other one — Postgres reachable and the handler throwing for a reason
that would have cleared itself. A deadlock under concurrency, a serialization failure, a brief
replica hiccup, a lock held a second too long by a reconciliation run. Every one of those
increments `attempts`, and eight of them inside four seconds retires an authentic payment to
`failed`, permanently, where nothing retries it and only a person can bring it back.

Deadlocks were not hypothetical. The balance cache is one row per account and every booking
for a merchant contends on `psp_receivable`; settlement confirmations touched several accounts
in *deduction order*, which is the order the PSP itemised them, so two confirmations from two
files could genuinely take the same locks in different orders. A transient error class the
system's own design produced was exactly the one its retry policy could not survive.

**A rotated secret discarded the backlog.** A delivery is verified twice: once at the door,
and again by the worker, because the stored bytes are re-verified before they are interpreted.
`config.webhookSecret` returned one string. Rotate it while a backlog exists and every pending
delivery signed with the old secret fails the second check — and the worker's answer to a
signature that no longer verifies is `rejected`, which is terminal and retried by nothing.

So rotating a webhook secret on a busy afternoon silently discarded real payments. Given the
durable-inbox design, this was the one place rotation bit, and it bit hardest exactly when the
queue was deepest.

## Decision

**`next_attempt_at`, and a claim query that respects it.**

One nullable column. `NULL` means "now", which is what a freshly accepted delivery means and
what every pre-existing row means, so a first attempt never waits. `recordFailure` sets it to
`now + backoff(attempts)`.

The backoff is exponential from one second, doubling, capped at five minutes. Eight attempts
now span roughly nine minutes rather than four seconds.

The jitter is **derived from the delivery id**, never from `Math.random`. Two workers must
compute the same delay for the same row, or a redrained queue is not reproducible — and this
package's whole claim is that it can be interrupted and resumed without changing what happens
(determinism). The id is already a SHA-256, so its low bits are already uniform; ±12.5% is
enough to stop a thousand deliveries that failed together from returning together.

The partial index is replaced rather than added to, since a claim on a retrying queue would
otherwise read index entries for rows that are pending but not yet due — which is most of
them, precisely when the claim needs to be fast.

`DrainReport` gains `deferred`, and `inboxDepth` gains `deferred` and `oldestPendingAt`. A
stalled queue and a backing-off queue are both "a pending count that is not going down", and
one of them is the system working exactly as designed.

**The balance cache is locked in a fixed order.** `postTransaction` sorts its per-account
upserts by account id, which imposes a total order every writer shares and removes the
lock-ordering deadlock class entirely. This does nothing for *contention* on `psp_receivable`
— see ADR-0053 — but contention costs throughput and a deadlock cost a payment.

**Secrets are a ring, and rotation overlaps.** `Config.webhookSecrets` returns a list:
`RECON_WEBHOOK_SECRET_<SOURCE>` and, when set, `RECON_WEBHOOK_SECRET_<SOURCE>_PREVIOUS`.
`verifyWebhook` accepts a string or a list and tries each, current first, so the overwhelmingly
common case still costs one HMAC and the previous secret is reached only when the current one
has already failed.

The rotation procedure is: set `_PREVIOUS` to the outgoing secret, set the current one to the
new secret, wait for the inbox to drain, remove `_PREVIOUS`. It is in the README.

The worker's `unverified` message now says what actually happened — an authentic delivery
stranded by a rotation — and names the variable that recovers it, because the previous message
led an operator to conclude the provider had sent a bad payload.

## Consequences

A poison payload now takes minutes rather than seconds to reach `failed`. That is the correct
trade: a payload nobody can parse is not urgent, and a real payment discarded over a deadlock
is.

`retryAfter` is exported, so a deployment can reason about the schedule and a test can assert
it without waiting nine minutes. `DrainOptions.backoff` lets a suite drain with `() => 0`.

Rotating a secret is now a two-step change with a wait in the middle rather than a one-line
edit. That is a real operational cost, and it is smaller than the cost it replaces.

Holding two secrets doubles the worst-case verification work for an unauthentic delivery on a
rotating source. The rate limiter (ADR-0074) is what bounds that.

Sorting the balance upserts removes ordering deadlocks and not contention. A single hot row is
a design property of the cache, not something an index fixes; the options are per-account
sharding or dropping the cache to a periodically-materialised view with `verifyBalances` as
the source of truth. Both are still deferred, and now named as deferred rather than implied.
