# @recon/ingest — Phase 2 ✅

**The anti-corruption boundary.** The outside world is impure and various. That variety is
quarantined here and converted, exactly once, into `@recon/canon` types, so the core never
sees a foreign shape.

**Depends on:** `@recon/canon`, `@pay-normalize/*`.
**Imported by:** `apps/*`.

It deliberately does **not** depend on `@recon/ledger-core`, and it has **no database**.
Ingest's job ends when it has produced a clean canonical event; deciding what to do with
that event, and remembering that it happened, belong to layers that are allowed to own
state. That missing edge is what keeps ingest a pure translator — bytes in, canonical
events out, no clock, no network, no I/O.

## This package is thin on purpose

`@pay-normalize/*` already contains the genuinely hard knowledge, and it is published, so
we import it rather than reimplement it:

| Already solved upstream | Added here |
|---|---|
| Four HMAC signature schemes, verified over raw bytes with `timingSafeEqual` | The last translation into `Money`/`CanonicalPayment`/`SettlementLine` |
| Five amount conventions → integer kobo, via string/BigInt math, never `parseFloat` | Widening their safe-integer kobo to our `bigint` |
| Per-provider timezone rules and status vocabularies | The **expected settlement window** per source |
| `STATUS_RANK`, making out-of-order delivery safe | The **expected fee** per source (a rate card) |
| Row-isolated settlement parsing that never throws on bad data | Dedupe as a pure function (Law 4) |

A stateless normalisation library deliberately has no opinion about *when money should
have arrived* or *what it should have cost*. Those two facts are what reconciliation runs
on, and they are this package's real contribution.

## Two halves

**The promise half** — [`webhook.ts`](src/webhook.ts). Verify the signature, *then* parse.
That order is a security property, not a preference: parsing before verifying means
running a parser over bytes any stranger on the internet can choose.

**The money half** — [`settlement/`](src/settlement/). One adapter per source, each
running the same fixed pipeline:

```
parse      bytes → structure          (JSON envelope, or a bare array of records)
validate   reject implausible rows at the boundary — including rows whose own
           gross/fee/net disagree, which no amount of matching can rescue
normalize  map onto canonical fields; convert to bigint kobo HERE and nowhere else
dedupe     drop what we have already seen (a separate, injectable step)
                          ↓
                   SettlementLine[]
```

## Per-source data, never per-source branching

[`sources.ts`](src/sources.ts) is how Law 7 survives contact with reality. Sources
genuinely do differ, and pretending otherwise just pushes the difference somewhere less
visible. So the difference is captured **as data**, at the boundary:

| Source | Webhooks | Settlement | Window | Rate card |
|---|---|---|---|---|
| `paystack` | ✅ | — *(see below)* | T+2 | 1.5% + ₦100, waived < ₦2,500, cap ₦2,000 |
| `flutterwave` | ✅ | ✅ settlements API v4 | T+2 | 1.4%, cap ₦2,000 |
| `nomba` | ✅ | ✅ transaction records | T+1 | `null` — priced per merchant |
| `monnify` | ✅ | ✅ transaction records | T+1 | 1.5%, cap ₦2,000 |

Downstream code asks a profile what the window is. It never asks which source this is.
Adding a source is one row in that table.

**The window is a deadline, not an expectation.** T+1 channels get a T+2 window because
the window marks the point at which silence becomes an exception a human is woken for —
set it to the expected arrival time and every weekend becomes an incident.

**`expectedFee` may be `null`**, and Nomba's is. It prices per merchant, so there is no
public card to encode, and `null` is the honest value — the reconciler will match on
reference and exact amount rather than pretend to predict a fee.

**Paystack has no settlement adapter.** Its connector refuses to parse settlement exports
until a sanitized real file pins the column layout, and inventing one here would produce a
parser that looks right and is wrong. `ingestSettlement('paystack', …)` throws
`NoSettlementAdapterError` and says so. Its promise half works fully in the meantime.

## The rate cards are checked against the provider's own arithmetic

Paystack states the fee it charged in its own webhook payload, so `fees.test.ts` checks
the model against Paystack rather than against our reading of their pricing page — on
three amounts that each land on a different branch of the card:

| Gross | Branch exercised | Predicted | Paystack charged |
|---|---|---|---|
| ₦100 | flat waived below ₦2,500 | ₦1.50 | ₦1.50 |
| ₦2,500 | exactly at the waiver threshold | ₦137.50 | ₦137.50 |
| ₦10,000 | percentage + flat | ₦250.00 | ₦250.00 |

Rate cards drift. When one does, it shows up as a rising `FEE_VARIANCE` count rather than
a wrong balance, because the fee actually charged always wins.

See [the bible, Phase 2](../../docs/RECONCILIATION-BIBLE.md#phase-2--the-ingest-layer-the-anti-corruption-boundary).
