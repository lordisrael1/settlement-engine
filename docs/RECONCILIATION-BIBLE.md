# The Reconciliation Bible

*A first-principles design and build doctrine for a Nigerian fintech reconciliation engine, built on `pay-normalize`.*

---

## How to read this document

This is not a tutorial and not a backlog. It is a **doctrine** — the set of beliefs, laws, and target properties the system must obey, followed by the **phases** that bring it into existence in the correct order. Every phase states *why it exists*, *what it delivers*, *which laws it enforces*, and *when it is done*. Build the phases in order. Each one stands on the correctness of the one before it. If you are ever unsure whether a design choice is right, return to Part I — the laws decide.

The single sentence the whole system serves:

> **Record the fast promise, wait for the slow money, and explain — provably — every difference between them.**

Everything below is in service of that sentence.

---

# Part I — The Doctrine

## 1. The core beliefs

**A balance is never a fact. It is a consequence.**
We never store "this account has ₦3,200" as a primary truth. We store an immutable history of events, and the balance is *derived* by summing them. The history is the truth; the balance is a view. This is the belief from which every other law follows, because it is the only design under which we can ever answer *"why is this number what it is?"* — the question the entire domain exists to answer.

**Money is conserved. It moves; it never appears or vanishes.**
Every economic event moves value from somewhere to somewhere. If our record of an event does not conserve value — if it does not sum to zero — we have claimed money came from nowhere, which is definitionally a bug, not a business case.

**Information and money travel on different rails at different speeds.**
A payment notification arrives in seconds. The settled cash arrives later — T+1 for card and PSP-aggregated channels, near-instant for direct NIP transfers and virtual-account credits. Reconciliation exists *only because of this gap*. If the two arrived together and never diverged, this system would be unnecessary. We therefore model time-of-information and time-of-money as distinct, and the lifecycle of every transaction *is* the story of the gap between them.

**The outside world is impure. Contain it at the boundary.**
Every source speaks its own dialect. We translate each dialect into one canonical language exactly once, at the edge, and let the entire core speak only that language. Variety is quarantined at the boundary so the core stays simple forever.

**Reconciliation is the reconciliation of two independent records of one reality.**
Our ledger is record #1 (the promise). The settlement source is record #2 (the money). Reconciliation partitions the difference into *matched*, *explained*, and *unexplained*. All value is in shrinking the unexplained bucket automatically until a human only ever looks at a genuine anomaly.

## 2. The Laws (non-negotiable invariants)

These are enforced in code, ideally at the database level, and never suspended "just this once."

**Law 1 — Balance-zero.** Every ledger transaction is a set of entries whose signed amounts sum to exactly zero. A transaction that does not balance is rejected at write time. This is a runtime assertion that we have not lost track of money.

**Law 2 — Append-only.** Entries and transactions are never updated or deleted. A mistake is corrected by writing a new, compensating transaction that reverses it. History is permanent so that any past state can be replayed and audited.

**Law 3 — Money is integer minor units.** All amounts are stored as integer **kobo** (`BIGINT`), never floats, never decimals-as-numbers. Float arithmetic on money is its own category of catastrophic bug. Conversion from a source's representation happens once, in the ingest layer, and never again.

**Law 4 — Idempotency.** The same real-world event entering the system twice must have the effect of entering it once. Every inbound event carries a natural idempotency key (`source` + source-unique reference); duplicates are recognised and dropped. This is forced directly by the law of conservation — a double-applied credit invents money.

**Law 5 — Determinism.** Given the same ordered sequence of events, the system always derives the same balances and the same reconciliation state. No wall-clock, no randomness, no ordering ambiguity may influence a derived number. Determinism is what makes replay and audit meaningful.

**Law 6 — Derived-equals-recomputed.** A cached balance must always equal the balance recomputed from entries. If they ever disagree, the cache is wrong and the entries win. This equality is itself an internal reconciliation and is asserted continuously.

**Law 7 — The canonical boundary.** No downstream component may ever branch on which source data came from. If `if (source === 'paystack')` appears anywhere past the ingest layer, an architectural law has been broken.

## 3. The attributes we are trying to achieve

These are the qualities by which the finished system is judged. Each phase should visibly advance one or more.

- **Correctness of money.** Books always balance; no value is ever created or destroyed by the system itself. This is the prime attribute; everything yields to it.
- **Auditability.** Any number, at any time, can be traced to the exact events that produced it, and the full history can be replayed from genesis to today.
- **Explainability.** Every difference between promise and money is either automatically explained by a reason (fee, reversal, pending settlement, FX, rounding) or escalated as a named exception. No silent discrepancies.
- **Idempotency and resilience.** Redelivered webhooks, re-uploaded files, and retried operations never corrupt state.
- **Source-agnosticism.** New payment sources are added by writing one adapter, with zero changes to the core.
- **Timing-awareness.** The system distinguishes "normally pending settlement" from "genuinely missing," per source, using each source's expected settlement window.
- **Determinism and testability.** The core is pure enough to be tested exhaustively with property-based and replay tests.
- **Operational reproducibility.** The whole system — service and database — starts identically anywhere with one command.

## 4. Relationship to `pay-normalize`

`pay-normalize` already solves the hardest part of the *inbound information* problem: it normalises Paystack, OPay, Nomba, and Flutterwave webhooks across five amount conventions and four HMAC signature schemes, and it handles out-of-order delivery via `STATUS_RANK`. In this system, `pay-normalize` **is the webhook half of the ingest layer** — it feeds the *left side* of the ledger (the promise). This bible extends it with the missing half: **settlement ingestion** (the *money* side) and the **matching engine** that reconciles the two.

One deliberate divergence: `pay-normalize`'s reference implementation uses Fastify + MongoDB, which is correct for stateless webhook normalisation. The **ledger core here requires a transactional, constraint-enforcing store**, so its system of record is **PostgreSQL** — we need real ACID transactions and DB-level constraints to enforce Laws 1–3. The service framework can remain Fastify for continuity; the *store beneath the ledger* is Postgres, not Mongo. Keep the ingest packages aligned with the `pay-normalize` world; keep the ledger on Postgres.

---

# Part II — The Phases

Each phase below is a self-contained unit of work with an exit criterion. Do not begin a phase until the previous phase's exit criterion is met.

## Phase 0 — Foundations and the canonical model

**Why it exists.** Nothing can be built correctly until the one true language is defined. Every later phase speaks it. Getting the canonical types right is the highest-leverage decision in the project; getting them wrong poisons everything downstream.

**What it delivers.**
- A monorepo (continuing the `pay-normalize` convention): `packages/ledger-core`, `packages/ingest`, `packages/reconciler`, `apps/api`, plus a shared `packages/canon` for the canonical types.
- The canonical types, money-as-kobo throughout: `Money` (integer kobo + currency), `CanonicalPayment` (the normalised promise from a webhook), `SettlementLine` (the normalised money record from a settlement source), `Account`, `Entry`, `LedgerTransaction`, and the enums for status and reason codes (see Appendix A).
- The chart of accounts (Appendix B) — the fixed set of accounts and their natural signs.
- A decision log file where every non-obvious choice is recorded with its reasoning.

**Laws enforced.** Law 3 (money type), Law 7 (the canonical boundary is defined here).

**Done when.** The canonical types compile, are documented, and a reviewer can read `packages/canon` and understand the entire domain vocabulary without reading any other code.

## Phase 1 — The ledger core (the double-entry engine)

**Why it exists.** This is the beating heart: the pure, source-agnostic engine that records balanced transactions and derives balances. It must be correct in complete isolation, with no knowledge of HTTP, PSPs, or files.

**What it delivers.**
- An append-only `transactions` table and `entries` table in Postgres, with money as `BIGINT` kobo.
- A `postTransaction(entries[])` function that **atomically** (a) asserts the entries sum to zero, (b) writes them, and rejects the whole transaction otherwise. The balance-zero check runs inside the same DB transaction as the write, so a non-balancing transaction can never be persisted even under concurrency.
- `balance(accountId)` computed as `SUM(entries)`, plus an optional cached running balance that is continuously checked against the recompute (Law 6).
- A reversal primitive: `reverse(transactionId)` that writes a new compensating transaction rather than mutating the original (Law 2).
- The transaction *lifecycle state* field: `authorized → settled`, or `authorized → reversed`, or `→ exception`. State transitions are themselves recorded, never overwritten in place.

**Laws enforced.** Law 1 (balance-zero, at the DB layer), Law 2 (append-only, no UPDATE/DELETE on entries), Law 3, Law 6.

**Done when.** You can, from a test harness alone, post balanced transactions, be rejected for unbalanced ones, reverse a transaction, and recompute any balance from entries — and a property test confirms that across thousands of random valid transactions, every account's cached balance equals its recomputed balance.

## Phase 2 — The ingest layer (the anti-corruption boundary)

**Why it exists.** To turn the messy outside world into clean canonical events, once, at the edge — so the core built in Phase 1 never sees a foreign shape. This phase has two halves: the **promise half** (webhooks, via `pay-normalize`) and the **money half** (settlement files/APIs, new here).

**What it delivers.**
- **Webhook ingestion** wired to `pay-normalize`: an inbound Paystack/OPay/Nomba/Flutterwave webhook is signature-verified, normalised into a `CanonicalPayment`, deduped on its idempotency key, and posted to the ledger as an `authorized` transaction. `STATUS_RANK` governs out-of-order updates.
- **Settlement ingestion** — the new work: a `SettlementSource` interface and one adapter per source (`PaystackSettlementAdapter`, `FlutterwaveSettlementAdapter`, `NibssSettlementAdapter`). Each adapter runs the fixed pipeline: **parse → validate → normalize → dedupe**, emitting `SettlementLine[]`.
  - *Parse*: bytes → structure (CSV rows, JSON objects, fixed-width records).
  - *Validate*: reject malformed or implausible lines at the boundary, before they can reach the ledger.
  - *Normalize*: map foreign fields onto canonical ones; convert amounts to integer kobo here and nowhere else.
  - *Dedupe*: drop lines already ingested (Law 4).
- **Per-source metadata**: each adapter declares its **expected settlement window** (e.g. card/PSP-aggregated = T+1..T+2; NIP/virtual-account = near-instant). This metadata is consumed by Phase 4.
- A fee model per source: `expectedFee(gross)` capturing percentage, cap, flat, and international-surcharge components, so that "their net = our gross − fee" can be checked.

**Laws enforced.** Law 3 (conversion happens here, once), Law 4 (dedup), Law 7 (variation contained; downstream never learns the source).

**Done when.** A raw Paystack settlement CSV and a raw Flutterwave settlement payload both become identical-shaped `SettlementLine[]`, malformed rows are cleanly rejected with reasons, re-ingesting the same file is a no-op, and no downstream code can tell which source produced a line.

> **Extended by Phase 3.** The boundary now has a **third half**: bank statements. There is
> no `pay-normalize` for them and there could not be one — every Nigerian bank exports a
> different CSV — so the layer defines one canonical statement shape and owns the two things
> that matter: narration is *tokenised into candidates*, never resolved to a reference
> (§ D-033), and debits are kept, because a returned payout and a chargeback both arrive as
> debits. Every record produced by any of the three halves now carries the SHA-256 of the
> file it came from, the uploader, the receipt time and the parser version.

> **As built.** This phase turned out much thinner than written, because `@pay-normalize/core` already defines `parseSettlementFile` on its `Connector` interface and three connectors already implement it. The exit criterion is met with **Flutterwave** (a JSON envelope with a nested data array) and **Nomba** (a bare array of records) — two genuinely different foreign shapes. The Paystack settlement adapter is deliberately absent: its connector refuses to parse exports until a sanitized real file pins the column layout, and inventing one would produce a parser that looks right and is wrong. See [DECISIONS.md](DECISIONS.md) § D-012 and § D-025.

## Phase 3 — The reconciliation engine (the matching pipeline)

> **Revised after the first build.** The phase as originally written is two-way: the
> ledger's promise against the PSP's settlement report, booking cash on the match. That is
> internally consistent and wrong about the world — a PSP's report is a claim by an
> interested party about its own future behaviour, not money. The phase is now **three-way**,
> and the section below is the current specification. See [DECISIONS.md](DECISIONS.md)
> § D-027 through § D-036.

**The three records.** Reconciliation compares three independent accounts of the same money:

| | Record | Arrives | What it proves |
|---|---|---|---|
| T+0 | **Webhook** | seconds | a customer paid; the PSP owes us |
| T+1 | **PSP settlement report** | next business day | the PSP *intends* to send a payout, less named deductions |
| T+1/T+2 | **Bank statement** | when the money moves | cash is actually in our account |

Only the third books cash:

```
T+0  Webhook — the promise
     psp_receivable  +₦10,000
     merchant_revenue −₦10,000

T+1  PSP settlement report — a claim, not cash
     Payout PO-1: gross ₦10,000, fee ₦150, VAT ₦11.25, payout ₦9,838.75
     Match the payments to the payout, name every deduction.
     NOTHING IS BOOKED.

T+2  Bank statement — the only proof
     Credit of ₦9,838.75 confirms PO-1
     bank_account    +₦9,838.75
     fees_expense    +₦150.00
     taxes_withheld  +₦11.25
     psp_receivable  −₦10,000.00
```

**Why it exists.** This is where the promise meets the money — and, crucially, where it is
kept apart from the *claim* of money. It partitions everything into matched, explained, and
unexplained. This is the intellectual core and the differentiator.

**What it delivers.** A tiered matcher, cheapest and most confident first, each tier producing `MatchResult`s that carry a confidence and a reason code:

1. **Exact reference match.** Same reference on both sides, amounts agree → high-confidence match. Clears the easy majority.
2. **Transformation-aware match.** Match on `ourGross − expectedFee(ourGross) == theirNet`. A raw-number "mismatch" becomes a match once the fee model is applied. Correct fee modelling per source is a large share of real-world value.
3. **Fuzzy / many-to-one match.** One settlement line batches several ledger transactions, or references are mangled. Solve as a bounded subset-sum / assignment problem: which combination of unmatched transactions sums to this line within tolerance and time window?
4. **Timing-aware deferral.** An unmatched item within its source's settlement window is *not* an error — it is `pending settlement`. Only items past their window escalate (handed to Phase 4).

**Stage three — the bank confirms it.** A bank credit is matched to a reported payout, by
the payout's own reference where the narration carries it, otherwise by a unique amount and
date. Only this stage **writes a ledger transaction** — cash to `bank_account`, every named
deduction to its own account, and the receivable closed. Reconciliation *feeds* the ledger;
they are one system, not two.

- **Payouts are first-class.** A `Payout` has its own reference and its own itemised
  deductions; settlement lines belong to one. Sources that name the movement give strictly
  better information than sources that only list transactions.
- **Deductions are named, never residual.** Fees, VAT and stamp duty, rolling reserves,
  dispute holds, penalties, refunds and chargebacks each book to their own account. A
  reserve is an *asset* — the PSP is holding our money, not keeping it.
- **Allocation is an amount**, so one payment can be settled across two payouts and one
  payout can cover many payments. Partial settlement is a state, not a mismatch.
- **Fee expectations come from dated contracts**, per merchant, per source, with VAT and an
  approver — so reconciling March uses March's rates.
- **Deadlines come from a business calendar**: cut-off times, business days, weekends and
  Nigerian public holidays, plus a grace period.
- **A booking that will not balance without a plug entry is refused.** Forcing the
  difference into `fees_expense` always works and always lies.

**Laws enforced.** Law 1 and Law 5 (matching is deterministic — same inputs, same partition), Law 7.

**Done when.** Given a ledger, a PSP settlement report with deliberate fees, taxes and
reserves, and a bank statement, the engine: matches payments to the reported payout without
booking anything; books the cash, the fees and every named deduction only when an
independent bank credit confirms it; leaves a reported-but-uncredited payout sitting as
`AWAITING_BANK_CREDIT`; and escalates duplicated, returned, short or unidentifiable credits
— deterministically, the same way every run.

## Phase 4 — Exceptions, lifecycle, and settlement windows

**Why it exists.** To turn "unmatched" into a disciplined, time-aware state machine, so that humans are shown *only* true anomalies and everything else resolves itself.

**What it delivers.**
- The unmatched-item state machine: `pending_settlement` (within window) → `overdue` (past window) → `exception` (past window with no explanation), plus resolution states.
- The **exception queue**: every item that reaches `exception`, surfaced with full context — the promise, the expected money, the window it missed, the evidence file it came from, and the candidate explanations the matcher considered and rejected.
- Reason-code taxonomy (Appendix C), grouped by `REASON_KIND` into match / explanation / exception.
- Deadline logic driven by each source's **business calendar** from Phase 3: cut-off times, business days, weekends and public holidays. A card transaction unmatched after 2 hours is normal; the same after 3 business days is an exception. A virtual-account credit unmatched after minutes is already suspicious.
- **Bank-side exceptions**, which only exist once the bank is a separate record: a duplicated credit, a returned payout, a credit short by more than a bank charge, and a credit whose narration identifies nothing.
- **Human resolution as an append-only trail.** A reviewer never edits a match; they append a resolution carrying their identity, the action, the reason, the supporting evidence, and — above a threshold — an approver. A change of mind is a second resolution, not a correction of the first. The `resolutions` table and its vocabulary land in Phase 3; the workflow and the reviewer UI are Phase 6's.

**Attributes advanced.** Explainability, timing-awareness.

**Done when.** A T+1 straggler correctly sits as `pending_settlement` and auto-clears when its settlement file arrives, while a `PHANTOM_CREDIT` (a settlement line with no matching ledger promise) lands in the exception queue immediately with full diagnostic context.

## Phase 5 — Event sourcing, audit, and projections

**Why it exists.** To make the whole system replayable and auditable from genesis, satisfying auditability as a first-class attribute rather than an afterthought.

**What it delivers.**
- An append-only **event log** as the true system of record: `PaymentAuthorized`, `SettlementIngested`, `TransactionMatched`, `SettlementBooked`, `ReversalBooked`, `ExceptionRaised`, `ExceptionResolved`.
- The ledger balances and the reconciliation state become **projections** derived by folding the event log. Both can be rebuilt from scratch and must reproduce the current state exactly (Law 5).
- A replay tool: rebuild all projections from event zero and assert they equal the live state — a powerful, continuous correctness proof and the ultimate expression of Law 6 at system scale.

**Laws enforced.** Law 2 and Law 5 at the whole-system level.

**Done when.** Deleting all projections and replaying the event log reproduces byte-identical balances and reconciliation state.

## Phase 6 — The API and the service

**Why it exists.** To expose the engine's capabilities to the outside world over a contract, while hiding all internals — and to receive inbound webhooks over HTTP. This is the outward-facing edge, distinct in direction and concern from the ingest layer.

**What it delivers.**
- A long-lived Fastify service exposing a deliberate, minimal contract: record/query balances, upload/ingest a settlement source, fetch a reconciliation summary per period, list and resolve exceptions.
- Inbound webhook endpoints that own transport concerns only — authenticity (signature), well-formedness, auth — then hand the raw payload to the ingest layer for meaning. The API owns *"it arrived over HTTP and is authentic"*; ingest owns *"turn this shape into a canonical event."* Neither reaches into the other's concern.
- Clear separation: the API delegates all thinking to the core and only translates requests↔responses and errors↔status codes.

**Attributes advanced.** Source-agnosticism (the API never branches on source), correctness (the API cannot bypass Law 1 — all writes go through the ledger core).

**Done when.** Every capability is reachable via `curl` with correct status codes and auth, a real (or simulated) webhook flows end-to-end into an `authorized` transaction, and no business logic lives in the API layer.

## Phase 7 — Containerisation and deployment

**Why it exists.** To make the system reproducible: the same sealed artifact runs identically on a laptop and in the cloud, eliminating "works on my machine."

**What it delivers.**
- A `Dockerfile` producing the service image (the modern deliverable — an image, not an `.exe`).
- A `docker-compose.yml` bringing up service + Postgres as one unit with `docker compose up`.
- Config via environment; secrets never baked into the image.

**Attributes advanced.** Operational reproducibility.

**Done when.** A fresh machine with only a container runtime can start the entire system — service and database — with one command, and it behaves identically to the dev box.

## Phase 8 — Testing, correctness, and chaos

**Why it exists.** Anyone can write the happy path. The proof that the system is *correct about money* is that it survives adversarial and property-based testing. This phase is where the project earns its credibility.

**What it delivers.**
- **Property-based tests** on the ledger: across thousands of random valid transactions, books always balance and cached equals recomputed (Laws 1, 6).
- **Replay tests**: projections rebuilt from the event log always equal live state (Law 5).
- **Idempotency tests**: redelivering webhooks and re-uploading files never changes state (Law 4).
- **Reconciliation fixtures**: a settlement simulator generating realistic files with deliberate fee changes, reversals, a chargeback, a T+1 straggler, and one phantom credit — asserting the engine auto-clears the explainable and surfaces exactly the phantom.
- **Out-of-order and duplicate settlement** injection to confirm deterministic partitioning regardless of arrival order.

**Attributes advanced.** Correctness, determinism, resilience — all made *demonstrable*.

**Done when.** The full adversarial suite passes deterministically, and the simulator's one phantom credit is the only item a human is ever shown.

## Phase 9 — The dashboard and the demo

**Why it exists.** To make the correctness *visible* and to land the "this person understands Nigerian payments" signal. The dashboard is a client of the API, never a dependency of the core.

**What it delivers.**
- A small React dashboard: current balances, a per-period reconciliation summary (matched / explained / exceptions), and the exceptions queue with drill-down context.
- The scripted demo: feed a deliberately messy settlement file — reversals, a fee change, a T+1 straggler, one phantom credit — and show the engine auto-clearing ~95%, booking every fee and reversal correctly, and surfacing exactly the one phantom line with a full audit trail behind every number.

**Attributes advanced.** All of them, made legible to a viewer in ninety seconds.

**Done when.** A non-expert watching the demo understands, without explanation, that the system recorded fast promises, waited for slow money, and explained every difference — with the single true anomaly isolated for a human.

---

# Part III — Appendices

## Appendix A — Canonical types (sketch)

- `Money` — `{ kobo: bigint, currency: 'NGN' }`. Integer minor units only (Law 3).
- `CanonicalPayment` — the normalised promise from a webhook: reference, source, `Money` gross, status, event time, idempotency key.
- `SettlementLine` — the normalised money record: reference, source, `Money` gross/fee/net, settlement date, status, reason hints, idempotency key.
- `Account` — id, type, natural sign.
- `Entry` — account id, signed `Money`, transaction id.
- `LedgerTransaction` — id, entries[] (sum to zero), lifecycle state, timestamps.
- `MatchResult` — internal ref, external ref(s), confidence, reason code.

> Implemented in [`packages/canon`](../packages/canon). Where the implementation refines
> this sketch, the reasoning is in [DECISIONS.md](DECISIONS.md).

## Appendix B — Chart of accounts (starting set)

| Account | Type | Meaning |
|---|---|---|
| `psp_receivable` | Asset | Money a PSP owes us after a promise, before settlement |
| `bank_account` | Asset | Real settled cash, confirmed by a bank statement |
| `merchant_revenue` | Income | Earned income from a payment |
| `fees_expense` | Expense | Cost of PSP fees |
| `taxes_withheld` | Expense | VAT, stamp duty or withholding tax deducted at source |
| `penalties` | Expense | Fines a PSP or bank deducted from a payout |
| `bank_charges` | Expense | Charges the bank levied on a credit, invisible to the PSP |
| `psp_reserve` | Asset | Rolling reserve or dispute hold — still owed, just later |
| `reversals` | Contra-income | Refunds/reversals of previously recorded payments |
| `chargebacks` | Contra-income | Clawbacks initiated after settlement |
| `suspense` | Holding | Phantom credits / unidentified money pending investigation |

> Added in Phase 3's three-way redesign: `taxes_withheld`, `penalties`, `bank_charges` and
> `psp_reserve`. They exist so that the gap between what we were owed and what arrived is
> always a **named** thing rather than a residue swept into fees. See § D-029.

## Appendix C — Reason codes

**Matches** — the difference is fully accounted for.
`EXACT_MATCH` · `FEE_ADJUSTED_MATCH` · `BATCH_MATCH` · `PAYOUT_MATCH` · `BANK_CONFIRMED`

**Explanations** — the difference is real but understood.
`FEE_VARIANCE` · `AWAITING_BANK_CREDIT` · `PARTIAL_SETTLEMENT` · `RESERVE_WITHHELD` ·
`TAX_WITHHELD` · `PENALTY` · `BANK_CHARGE` · `REVERSAL` · `CHARGEBACK` ·
`PENDING_T_PLUS_N` · `FX_ROUNDING`

**Exceptions** — the difference is real and unexplained. A human sees these.
`PHANTOM_CREDIT` · `MISSING_SETTLEMENT` · `AMOUNT_MISMATCH` · `DUPLICATE_BANK_CREDIT` ·
`RETURNED_PAYOUT` · `UNIDENTIFIED_CREDIT` · `PAYOUT_UNBALANCED`

The grouping is machine-readable as `REASON_KIND` in `packages/canon`, so the three-way
partition is a property of the vocabulary rather than a convention the matcher remembers.

## Appendix D — Glossary

- **Promise** — the fast information that a payment succeeded (a webhook). Recorded immediately as an `authorized` transaction.
- **Payout** — one money movement a PSP says it is making, with its own reference and its own itemised deductions, covering many payments. A *claim*, not cash.
- **Money** — cash confirmed by a bank statement. Nothing else is money.
- **Expected inflow** — a payout we are waiting on the bank to confirm. `derived` when we inferred the grouping ourselves rather than being told it.
- **Adjustment** — a named deduction from a payout: fee, tax, reserve, reserve release, penalty, refund, chargeback. Never a residue.
- **Allocation** — how much of one payment a given inflow discharges. An amount, so settlement can be partial or split.
- **Fee contract** — a rate card with effective dates, a merchant, a VAT rate and an approver. Historical reconciliation uses the contract that was in force at the time.
- **Business calendar** — cut-off time, business days, weekends and public holidays, per source. What makes T+1 a business rule rather than 24 hours.
- **Evidence** — the file a record came from, identified by the SHA-256 of its bytes, with its uploader, receipt time and parser version.
- **Resolution** — a human's appended decision about something the machine escalated. Never an edit.
- **Ingest-canon** — the inbound boundary that translates foreign source data into canonical events.
- **API** — the outbound boundary that exposes capabilities and receives requests over a protocol.
- **Exception** — an unmatched item past its settlement window with no automatic explanation; the only thing a human should ever see.

---

*Build the phases in order. Let the Laws decide. Shrink the unexplained bucket to one line.*
