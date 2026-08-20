# @recon/canon

The shared vocabulary. Type definitions and the constants that go with them, with almost no
behaviour.

**Depends on:** nothing. **Imported by:** every other package.

The leaf position is deliberate: a change to the canonical language is made once and
propagates everywhere, and there is exactly one definition of each domain concept.

## Contents

| File | Defines |
|---|---|
| [`money.ts`](src/money.ts) | Amounts: integer kobo, signed, never a float |
| [`accounts.ts`](src/accounts.ts) | The chart of accounts and natural signs |
| [`identifiers.ts`](src/identifiers.ts) | How events are named and deduplicated |
| [`ledger.ts`](src/ledger.ts) | The double-entry record: entries, transactions, lifecycle |
| [`payment.ts`](src/payment.ts) | `CanonicalPayment` — the promise, from a webhook |
| [`settlement.ts`](src/settlement.ts) | `SettlementLine` and `Payout` — the money |
| [`matching.ts`](src/matching.ts) | What reconciliation concluded, and why |

`PaymentStatus` and `STATUS_RANK` are spelled exactly as `@pay-normalize/core` spells them,
so no mapping table exists at the boundary to drift
([ADR-0013](../../docs/adr/0013-canonical-status-spelling.md)).

## The two shapes the system compares

    CanonicalPayment          SettlementLine
      the promise               the money
      arrives in seconds        arrives T+1, or near-instantly on NIP
      gross                     gross, fee, net

              -> MatchResult <-
        matched · explained · exception

## Rules for changing this package

- No behaviour that belongs elsewhere. A function needing a database, an HTTP client or
  knowledge of a specific provider does not belong here.
- No source-specific types. `SourceId` is an open `string`
  ([ADR-0005](../../docs/adr/0005-source-id-is-an-open-string.md)).
- No stored balances. A balance is derived, and nothing here describes one.
- Money is `bigint` kobo at every depth. There is no `number` amount anywhere.
