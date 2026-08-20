# @recon/simulator

A seeded generator of a deliberately messy settlement day: provider-format files and signed
webhook deliveries, plus a declaration of what every planted anomaly is and where the books
must land.

**Depends on:** `@recon/canon` and one connector's signing helpers. No database, no clock,
no filesystem.

    import { generate, arrivals } from '@recon/simulator';

    const scenario = generate({ seed: 42, calendarFor, secrets });
    // scenario.deliveries   signed webhooks, ready for ingestWebhook
    // scenario.settlements  provider-format settlement exports, as bytes
    // scenario.statements   bank statements, as bytes
    // scenario.truth        what each anomaly is, and where the books must land

## What one scenario contains

| Planted | Expected handling |
|---|---|
| A fee renegotiation, with payments on both sides | Each payment priced by the contract in force at its own moment, with no variance either side |
| A reversal, on a rail that never names its payouts | Recognised from the row's own status, booked to `reversals`, waits for no bank credit |
| A chargeback, folded in beside the fees | Booked to `chargebacks`, not absorbed into `fees_expense` |
| An unannounced correspondent-bank charge | Explained as `BANK_CHARGE`, within the source's allowance |
| A payout reported and not yet credited | `AWAITING_BANK_CREDIT` — pending, not in the queue |
| Exactly one credit belonging to nobody | `UNIDENTIFIED_CREDIT`, and the only item a person sees |

Everything except the last must be explained without a person.

## Three properties

**It produces bytes, not records.** A simulator handing the matcher a `Payout` object would
exercise the matcher and skip the boundary, and the boundary is where a real settlement
export goes wrong. Every record downstream is one the real ingest layer produced from bytes
the real signature check accepted
([ADR-0058](../../docs/adr/0058-the-simulator-emits-bytes.md)).

**It is a function of its seed.** No clock, no `randomUUID`, no filesystem. A failing build
hands back one integer that reproduces the exact bytes on any machine.

**Its ground truth is declared, not derived.** What each anomaly is, and what every account
balance must be to the kobo, is decided when it is planted. Truth computed by running the
engine is the engine agreeing with itself.

## The kobo salt

A payout is matched by finding the unique subset of promises summing to its gross, and the
matcher escalates when two subsets fit equally well. Amounts drawn naively collide — 5,000 +
15,000 and 8,000 + 12,000 are the same payout — so a seed that drew both would escalate a
payout that was going perfectly well.

Each promise is therefore a whole-hundred-naira base plus a distinct power-of-two kobo salt,
so a subset's total modulo 100 naira is the sum of its salts, which identifies the subset
uniquely for up to thirteen promises. Ambiguity is still tested on purpose, in its own
scenario, asserting that the matcher escalates
([ADR-0059](../../docs/adr/0059-kobo-salt-for-unambiguous-subsets.md)).

## Provider impersonation

This is the only code outside `packages/ingest` that branches on a provider's name, because
here it is being four remote systems: Paystack signs HMAC-SHA512 over the raw body in hex,
Flutterwave HMAC-SHA256 in base64, Nomba HMAC-SHA256 over a colon-joined canonical string
that does not cover the amount.

Nomba's canonical string is built with Nomba's own exported helpers rather than
reimplemented. A second implementation of a signing scheme is a second thing that can be
wrong, and a simulator whose signatures are wrong tests the 401 path and nothing else.

## Running it

Asserted:

    DATABASE_URL=postgres://recon:recon@localhost:5432/recon npm test

Watched:

    docker compose run --rm cli node apps/pipeline/dist/main.js simulate 42
    docker compose run --rm cli node apps/pipeline/dist/main.js simulate 42 --reverse

`--reverse` delivers the bank statements before the reports that explain them. Every finding
raised along the way has to close itself when the evidence lands, and the books have to end
in the same place.

Each run gets an empty schema of its own, named after the seed and rebuilt each time, because
every number it prints is an absolute claim
([ADR-0062](../../docs/adr/0062-simulate-runs-in-its-own-schema.md)). Open the books
afterwards:

    docker compose exec postgres psql -U recon -d recon \
      -c 'SET search_path = simulator_seed_42' -c 'SELECT * FROM entries'
