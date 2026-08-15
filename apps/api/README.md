# apps/api — Phase 6 (not yet built)

**The one thing that actually runs.** Everything under `packages/` is a library that cannot
run by itself. This is the deployable: a long-lived Fastify process that binds a port,
accepts HTTP, receives webhooks, and wires the libraries together.

**Depends on:** all four packages. **Depended on by:** nothing. That shape — depends on
everything, depended on by nothing — is the signature of a deployable, and it is exactly why
the app, and only the app, is what gets containerised (Phase 7).

## The division of concerns it must respect

The API owns *"it arrived over HTTP and is authentic."*
Ingest owns *"turn this shape into a canonical event."*
Neither reaches into the other's concern.

So an inbound webhook: the API verifies the signature and well-formedness (transport), then
hands the raw payload to `@recon/ingest` (meaning), and the resulting canonical event goes
to `@recon/ledger-core`. A settlement upload: the API receives the file, ingest normalises
it, the reconciler matches it.

**The API is the conductor; the packages are the orchestra.** If you find a Law being
enforced in this directory, it is in the wrong place.

## The contract

Deliberate and minimal:

- query balances
- upload / ingest a settlement source
- fetch a reconciliation summary per period
- list and resolve exceptions
- receive inbound webhooks

**Exit criterion.** Every capability reachable via `curl` with correct status codes and
auth; a real or simulated webhook flowing end to end into an `authorized` transaction; and
no business logic in this layer.

See [the bible, Phase 6](../../docs/RECONCILIATION-BIBLE.md#phase-6--the-api-and-the-service).
