# @recon/inbox — the durable acceptance rail

**Problem it solves.** A PSP webhook arrives on somebody else's schedule, with a retry
timer already running. The only promise worth making in that moment is *"we safely
received this event"* — and it is a promise about one durable write, not about the ledger,
the matcher, the balance cache and the dashboard all having finished.

**What it is.** One table and two functions.

```
accept   verify the signature, write the bytes down, answer 200      (the request path)
drain    a worker gives the delivery meaning, transactionally        (everything after)
```

`accept` does a single insert keyed by the SHA-256 of the source and the raw bytes, so a
redelivery — guaranteed, not merely likely — collides on the primary key rather than on
anybody remembering to check. `drain` claims deliveries with `FOR UPDATE SKIP LOCKED`,
one database transaction per delivery, so the booking and the record that it was booked
land together or not at all. Scaling the workers is starting more of them.

**Depends on:** `canon` (its vocabulary), `ledger-core` (the connection and the
transaction helper), `pg`. **Depended on by:** `apps/api`.

Notably it does **not** depend on `ingest`. This package knows that deliveries exist and
that somebody can interpret them; it has never heard of a signature scheme or a payment.
The handler passed to `drain` is where a deployable joins ingest to the ledger, and that
join belongs in a deployable — see [`apps/api/src/worker.ts`](../../apps/api/src/worker.ts).

**The one deliberate mutability in the system.** `state`, `attempts` and `last_error` are
updated as a delivery is worked, so `webhook_inbox` carries no append-only trigger — the
same exemption `account_balances` has, for the same reason. The evidence half of the row
(`source`, `headers`, `raw`, `received_at`) is never written after the insert, and the
financial record stays append-only where it belongs: in `entries`, which is where the
delivery ends up if it means anything.

See [DECISIONS.md § D-050](../../docs/DECISIONS.md).
