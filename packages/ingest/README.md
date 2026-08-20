# @recon/ingest

The anti-corruption boundary. Provider bytes in, `@recon/canon` types out, so the core never
sees a foreign shape.

**Depends on:** `@recon/canon`, `@recon/protect`, `@pay-normalize/*`. **Imported by:**
`@recon/policy`, `apps/*`.

It does not depend on `@recon/ledger-core` and owns no database. Ingest's job ends when it
has produced a clean canonical event; deciding what to do with that event, and remembering
it happened, belong to layers allowed to own state. No clock, no network, no I/O
([ADR-0020](../../docs/adr/0020-ingest-has-no-database.md)).

## This package is thin

`@pay-normalize/*` already contains the hard knowledge and is published, so it is imported
rather than reimplemented.

| Solved upstream | Added here |
|---|---|
| Four HMAC signature schemes, verified over raw bytes with `timingSafeEqual` | The translation into `Money`, `CanonicalPayment` and `SettlementLine` |
| Five amount conventions to integer kobo, via string and BigInt math | Widening upstream safe-integer kobo to `bigint` |
| Per-provider timezone rules and status vocabularies | The expected settlement deadline per source |
| `STATUS_RANK`, making out-of-order delivery safe | The expected fee per source |
| Row-isolated settlement parsing that never throws on bad data | Deduplication as a pure function |
| — | Refusing a payload that carries card data, before anything downstream sees it |

A stateless normalisation library has no opinion about when money should have arrived or
what it should have cost. Those two facts are what reconciliation runs on, and they are this
package's contribution ([ADR-0012](../../docs/adr/0012-pay-normalize-as-an-npm-dependency.md)).

## Two halves

**Webhooks** — [`webhook.ts`](src/webhook.ts). Verify the signature, then parse. That order
is a security property: parsing first means running a parser over bytes any stranger can
choose.

**Settlement** — [`settlement/`](src/settlement/). One adapter per source, each running the
same pipeline:

    parse      bytes -> structure (a JSON envelope, or a bare array of records)
    validate   reject implausible rows, including rows whose own gross/fee/net disagree
    normalize  map onto canonical fields; convert to bigint kobo here and nowhere else
    dedupe     drop what has already been seen (a separate, injectable step)
                          |
                          v
                   SettlementLine[]

## Per-source data, not per-source branching

[`sources.ts`](src/sources.ts) holds the differences as data, at the boundary. Downstream
code asks a profile what the deadline is; it never asks which source this is.

| Source | Webhooks | Settlement | Deadline | Rate card |
|---|---|---|---|---|
| `paystack` | yes | none | T+2 | 1.5% + 100, waived below 2,500, capped at 2,000 |
| `flutterwave` | yes | settlements API v4 | T+2 | 1.4%, capped at 2,000 |
| `nomba` | yes | transaction records | T+1 | none — priced per merchant |
| `monnify` | yes | transaction records | T+1 | 1.5%, capped at 2,000 |

Adding a source is one adapter and one row.

- **The window is a deadline, not an expectation.** T+1 channels get a T+2 window, because
  the window marks the point at which silence becomes an exception someone is alerted to.
- **`expectedFee` may be `null`,** and Nomba's is. It prices per merchant, so there is no
  published card to encode, and a guess would produce a permanent stream of false
  fee-variance findings ([ADR-0026](../../docs/adr/0026-deadline-windows-and-nullable-rate-cards.md)).
- **Paystack has no settlement adapter.** Its connector refuses to parse settlement exports
  until a sanitized real file pins the column layout, so `ingestSettlement('paystack', ...)`
  throws `NoSettlementAdapterError`. Its webhook half works fully
  ([ADR-0025](../../docs/adr/0025-no-paystack-settlement-adapter.md)).

## Rate cards are checked against the provider's own arithmetic

Paystack states the fee it charged in its webhook payload, so `fees.test.ts` checks the model
against Paystack rather than against a reading of their pricing page, on three amounts that
each land on a different branch of the card:

| Gross | Branch | Predicted | Charged |
|---|---|---|---|
| 100 | flat waived below 2,500 | 1.50 | 1.50 |
| 2,500 | exactly at the waiver threshold | 137.50 | 137.50 |
| 10,000 | percentage plus flat | 250.00 | 250.00 |

When a rate card drifts it shows up as a rising `FEE_VARIANCE` count rather than a wrong
balance, because the fee actually charged always wins.

## It refuses card data

A boundary that translates foreign payloads is also the boundary that decides what may enter
at all. `ingestWebhook` rejects a delivery carrying a Luhn-valid card number under a real
issuer prefix, or a field named as sensitive authentication data, and `ingestSettlement` and
`ingestBankStatement` throw before an evidence record exists — so there is never a row
anybody has to go and delete.

The scan itself lives in `@recon/protect`, because the service performs it again on the
request path, before the delivery is stored at all. That is the layer that can actually keep
the bytes out of the database; this one is the second line, for the paths that reach a parser
without passing the door
([ADR-0066](../../docs/adr/0066-pci-scope-and-evidence-access.md)).
