# @recon/inbox

Durable webhook acceptance. One table and two functions.

    accept   verify the signature, write the bytes down, answer 200      the request path
    drain    a worker gives the delivery meaning, transactionally        everything after

**Depends on:** `@recon/canon`, `@recon/ledger-core`, `pg`. **Imported by:** `apps/api`.

## Why it exists

A webhook arrives on somebody else's schedule, with a retry timer already running. The only
promise worth making in that moment is that the event was safely received — a promise about
one durable write, not about the ledger, the matcher and the balance cache all having
finished ([ADR-0050](../../docs/adr/0050-webhooks-accepted-durably.md)).

`accept` does a single insert keyed by the SHA-256 of the source and the raw bytes, so a
redelivery collides on the primary key rather than on somebody remembering to check. `drain`
claims deliveries with `FOR UPDATE SKIP LOCKED`, one database transaction per delivery, so
the booking and the record that it was booked land together or not at all. Scaling the
workers means starting more of them.

## Retries back off

A handler that *throws* is saying "I could not do my job just now", which is the only
retryable case. It used to be retried on the drain's own fixed interval, which meant a
delivery's whole budget — eight attempts at 500ms — was spent in **four seconds**.

For the failure this design was built around that is fine: when Postgres is unreachable the
transaction fails, `attempts` never moves, and the delivery waits as long as it has to. The
dangerous case is Postgres *reachable* and the handler throwing for a reason that would have
cleared itself — a deadlock, a serialization failure, a replica hiccup. Eight of those inside
four seconds retires an authentic payment to `failed`, permanently, where only a person can
bring it back.

`next_attempt_at` gates the claim, and `retryAfter` is exponential from one second to a
five-minute cap. The jitter is derived from the delivery id rather than drawn randomly,
because two workers must compute the same delay for the same row — a redrained queue that
behaves differently is a queue this package cannot claim to be resumable
([ADR-0073](../../docs/adr/0073-retries-back-off-and-secrets-overlap.md)).

`DrainReport.deferred` and `inboxDepth`'s `deferred` and `oldestPendingAt` exist because a
stalled queue and a backing-off queue are both "a pending count that is not going down", and
one of them is the system working exactly as designed.

## It does not depend on ingest

This package knows deliveries exist and that somebody can interpret them. It has never heard
of a signature scheme or a payment. The handler passed to `drain` is where a deployable
joins ingest to the ledger — see [`apps/api/src/worker.ts`](../../apps/api/src/worker.ts).

## Deliberate mutability

`state`, `attempts` and `last_error` are updated as a delivery is worked, so `webhook_inbox`
carries no append-only trigger — the same exemption `account_balances` has, for the same
reason. The financial record stays append-only in `entries`.

## The payload does not survive the delivery

`raw` used to be written once and kept forever, which made this table the largest collection
of personal data in the system: a Paystack `charge.success` body carries a customer's name,
email and IP address, and a card's BIN, last four and expiry. `drain` now takes a `redact`
function and applies it **in the same transaction** that records what the delivery meant, so
there is no window in which a delivery is both worked and unredacted
([ADR-0064](../../docs/adr/0064-redaction-at-the-boundary.md)).

Which fields survive is a question about providers, which this package has never heard of, so
the answer arrives as an argument — `@recon/protect` supplies the one every deployable uses.
A delivery that *threw* keeps its bytes, because it will be claimed again and re-verified
against its signature. `redactInboxOriginals` sweeps what the drain will never work.

The cost, stated rather than hidden: once redacted, the HMAC cannot be recomputed over these
bytes. The delivery id is still the SHA-256 of the original body, the verification happened
before the row was written, and re-running it matters only inside a dispute window.
