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

## It does not depend on ingest

This package knows deliveries exist and that somebody can interpret them. It has never heard
of a signature scheme or a payment. The handler passed to `drain` is where a deployable
joins ingest to the ledger — see [`apps/api/src/worker.ts`](../../apps/api/src/worker.ts).

## Deliberate mutability

`state`, `attempts` and `last_error` are updated as a delivery is worked, so `webhook_inbox`
carries no append-only trigger — the same exemption `account_balances` has, for the same
reason. The evidence half of the row (`source`, `headers`, `raw`, `received_at`) is never
written after the insert, and the financial record stays append-only in `entries`.
