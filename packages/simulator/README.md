# @recon/simulator

The adversary.

Everything else in this repository is written to be correct. This package is written to find
out whether it is — by generating the files a bad Tuesday actually produces, and declaring in
advance what every one of them means.

```ts
import { generate, arrivals } from '@recon/simulator';

const scenario = generate({ seed: 42, calendarFor, secrets });
// scenario.deliveries   signed webhooks, ready for ingestWebhook
// scenario.settlements  provider-format settlement exports, as bytes
// scenario.statements   bank statements, as bytes
// scenario.truth        what each planted anomaly is, and where the books must land
```

## What one scenario contains

| Planted | What it must do |
|---|---|
| A fee renegotiation, with payments on both sides | Each payment priced by the contract in force **at its own moment** — no variance either side |
| A reversal, on a rail that never names its payouts | Recognised from the row's own status, booked to `reversals`, waits for no bank credit |
| A chargeback, folded in beside the fees | Booked to `chargebacks`, not absorbed into `fees_expense` |
| A correspondent-bank charge nobody announced | Explained as `BANK_CHARGE` within the source's allowance |
| A payout reported and not yet credited | `AWAITING_BANK_CREDIT` — pending, **not** in the queue |
| Exactly one credit that belongs to nobody | `UNIDENTIFIED_CREDIT`, and the only thing a human is shown |

Everything except the last must be explained without a person. That is the claim, and this
package is what makes it falsifiable.

## Three commitments

**It produces bytes, not records.** A simulator that handed the matcher a `Payout` object
would exercise the matcher and skip the boundary — and the boundary is where a real
settlement export goes wrong. Every record downstream of this package is one the real ingest
layer produced from bytes the real signature check accepted, so the suite covers Phase 2 as
well as Phase 3.

**It is a function of its seed.** No clock, no `randomUUID`, no filesystem. A red build hands
you one integer that reproduces the exact bytes on any machine, forever (Law 5). An
adversarial suite you cannot reproduce has not found a bug; it has produced a rumour.

**Its ground truth is declared, not derived.** What each planted anomaly *is* — and what
every account balance must be, to the kobo — is decided at the moment it is planted. Truth
computed by running the engine is the engine agreeing with itself, which it will do just as
cheerfully when it is wrong.

## The kobo salt

The one piece of arithmetic here that exists for the matcher's benefit rather than for
realism, and it is load-bearing. See D-059.

A payout is matched by finding the *unique* subset of promises summing to its gross, and the
matcher escalates when two subsets fit equally well. Amounts drawn naively collide —
₦5,000 + ₦15,000 and ₦8,000 + ₦12,000 are the same payout — so a seed that drew both would
escalate a payout going perfectly well, and the suite would be red for a reason that is not a
defect.

So each promise is a whole-hundred-naira base plus a distinct power-of-two **kobo** salt. A
subset's total modulo ₦100 is then the sum of its salts, which identifies the subset
uniquely, for up to thirteen promises. The amounts stay entirely ordinary-looking, because
odd kobo is what real Nigerian payment amounts contain.

Ambiguity is not being hidden. It is tested *on purpose*, in its own scenario, with the
assertion that the matcher escalates rather than picking one.

## Impersonation

This is the only file outside `packages/ingest` allowed to branch on a provider's name,
because here we are *being* four remote systems that have no reason to agree with each other:
Paystack signs HMAC-SHA512 over the raw body in hex, Flutterwave HMAC-SHA256 in base64, Nomba
HMAC-SHA256 over a colon-joined canonical string that does not cover the amount.

Nomba's canonical string is built with Nomba's own exported helpers rather than reimplemented
here. A second implementation of a signing scheme is a second thing that can be wrong, and a
simulator whose signatures are wrong tests the 401 path very thoroughly and nothing else.

## Running it

Asserted:

```bash
DATABASE_URL=postgres://recon:recon@localhost:5432/recon npm test
```

Watched:

```bash
docker compose run --rm cli node apps/pipeline/dist/main.js simulate 42
docker compose run --rm cli node apps/pipeline/dist/main.js simulate 42 --reverse
```

`--reverse` delivers the bank statements before the reports that explain them. Every finding
that raises along the way has to close itself when the evidence lands, and the books have to
end up in exactly the same place.

Each run gets an empty ledger of its own, named after the seed and rebuilt each time — every
number it prints is an absolute claim, and that is only a claim about books nobody else wrote
to (D-062). Open them afterwards:

```bash
docker compose exec postgres psql -U recon -d recon \
  -c 'SET search_path = simulator_seed_42' -c 'SELECT * FROM entries'
```
