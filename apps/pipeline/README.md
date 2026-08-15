# apps/pipeline — the deployable

Everything under `packages/` is a library that cannot run on its own. This is the process
you start: it opens a database connection, dispatches a command, and prints. It owns no
business logic — every decision it appears to make is delegated to a package.

**Depends on:** all three packages. **Depended on by:** nothing. That shape — depends on
everything, depended on by nothing — is the signature of a deployable, and it is why this
directory, and only this directory, is what the Dockerfile runs.

## Why it exists before `apps/api`

Phase 7 asks for a container, and a container needs something to run. Phase 6's Fastify
service is not built yet, so this CLI is the smallest honest deployable that exercises
Phases 1 and 2 end to end. When `apps/api` arrives it joins this one rather than replacing
it — a service and a CLI over the same libraries, which is exactly the reuse the
library/deployable split exists to allow. Nothing inside `packages/` changes.

## Commands

```bash
migrate                            apply every migration once, checksum-verified
demo                               Phases 1 and 2, end to end, with commentary
balances                           current balances, derived from entries
verify                             Law 6 and Law 1, checked right now
ingest-settlement <source> <file>  normalize a settlement payload and print the lines
```

Run any of them against the composed system:

```bash
docker compose run --rm pipeline node apps/pipeline/dist/main.js balances
```

## The demo

`docker compose up` runs it. Eleven steps, on real payload shapes, against real Postgres:

1. Three signed Paystack webhooks become `authorized` promises
2. A redelivery changes nothing — **Law 4**
3. Balances, derived from entries
4. An unbalanced transaction is refused twice — by the app, *and* by the database with
   the app bypassed entirely — **Law 1**
5. `UPDATE entries` is refused — **Law 2**
6. A Flutterwave settlement payload becomes `SettlementLine[]`; the USD row is refused
   rather than converted; a chargeback folded into a fee is surfaced as a hint
7. The same payload again — **Law 4** on the money half
8. The rate card reproduces the fee Paystack itself reported, on all three branches
9. A payment is reversed by a mirror-image transaction — **Law 2**, operationally
10. Balances after the reversal
11. The system checks itself — **Law 6**, and Law 1 across every entry ever written

**Running it twice is not a mistake — it is the point.** Every step is idempotent, so the
second run reports duplicates everywhere and moves not one kobo. That is Law 4
demonstrated rather than asserted. For a clean narrative:

```bash
docker compose down -v && docker compose up --build
```

## Fixtures

[`fixtures/`](fixtures/) holds payloads in the exact shapes the providers send — the
Paystack webhook bodies carry the `fees` field the rate-card check is validated against,
and the Flutterwave settlement envelope carries the `chargeback` field the hint is lifted
from. The demo signs each webhook with HMAC-SHA512 the way Paystack does, so verification
runs for real rather than being stubbed out.
