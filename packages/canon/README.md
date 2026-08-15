# @recon/canon

**The shared language.** Pure type definitions and the constants that go with them.
Almost no behaviour — just the vocabulary every other package speaks.

This package depends on nothing internal, and everything depends on it. That leaf position
is deliberate: it means a change to the canonical language is made once and propagates
everywhere, and it is **Law 7** (the canonical boundary) expressed as code structure —
there is literally one place the language lives.

Phase 0's exit criterion is that a reviewer can read this package and understand the entire
domain vocabulary without reading any other code. Read the files in this order:

| File | What it defines | Law |
|---|---|---|
| [`money.ts`](src/money.ts) | What an amount is: integer kobo, signed, never a float | Law 3 |
| [`accounts.ts`](src/accounts.ts) | Where value can sit — the chart of accounts and natural signs | — |
| [`identifiers.ts`](src/identifiers.ts) | How events are named and deduplicated | Law 4 |
| [`ledger.ts`](src/ledger.ts) | The double-entry record: entries, transactions, lifecycle | Laws 1, 2 |
| [`payment.ts`](src/payment.ts) | The **promise** — fast information from a webhook | Law 5 |
| [`settlement.ts`](src/settlement.ts) | The **money** — slow cash, and each source's settlement window | — |
| [`matching.ts`](src/matching.ts) | What reconciliation concluded, and why — the reason codes | — |

## The two shapes the whole system exists to compare

```
CanonicalPayment          SettlementLine
  the promise               the money
  arrives in seconds        arrives T+1 (card) or near-instantly (NIP)
  gross                     gross, fee, net
  occurredAt                settledAt
        \                       /
         \                     /
          →   MatchResult   ←
       matched · explained · exception
```

## Rules for changing this package

- **No behaviour that belongs elsewhere.** If a function needs a database, an HTTP client,
  or knowledge of a specific PSP, it does not belong here.
- **No source-specific types.** `SourceId` is an open `string` on purpose. A closed union of
  PSP names would force downstream `switch` statements — the branching Law 7 forbids.
- **No stored balances.** A balance is a consequence, not a fact. Nothing in this package
  describes one.
- **Money is `bigint` kobo, always.** There is no `number` amount anywhere, at any depth.
