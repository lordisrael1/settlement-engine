# Decision Log

Every non-obvious choice, with its reasoning. Required by Phase 0.

Append new entries; do not edit old ones. If a decision is reversed, add a new entry that
supersedes it and say so — the same append-only discipline the ledger itself obeys.

Format: **ID · Date · Decision · Why · Alternatives rejected**.

---

## D-001 · 2026-08-15 · PostgreSQL is the ledger's system of record, not MongoDB

**Decision.** The ledger core stores transactions and entries in PostgreSQL, even though
`pay-normalize`'s reference implementation uses MongoDB.

**Why.** Law 1 must be enforced *inside the same database transaction as the write*. If the
sum-zero check runs outside the write's transaction, a concurrent writer can persist an
unbalanced transaction in the gap between check and insert — and the one invariant the whole
system rests on becomes advisory. That requires real ACID transactions and real constraints.

**Alternatives rejected.** MongoDB with application-level checks — correct for stateless
webhook normalisation, which is why `pay-normalize` uses it, but it puts the money invariant
in application code where it can be bypassed. Keep the ingest packages aligned with the
`pay-normalize` world; keep the store beneath the ledger on Postgres.

---

## D-002 · 2026-08-15 · npm workspaces + TypeScript project references, no build tool

**Decision.** The monorepo is plain npm workspaces with `tsc --build` and project
references. No Turborepo, no pnpm, no bundler.

**Why.** The build graph is five nodes deep-ish and entirely TypeScript. `tsc --build`
already knows how to order and cache the builds, and project references already express the
dependency graph — which doubles as a machine-checked assertion that no cycle exists. A
build tool would add configuration without removing any.

**Alternatives rejected.** Turborepo (adds caching we do not yet need); a bundler (the
deployable is a Node service, not a browser artifact — it can run the emitted JS directly).

**Revisit when.** Build times become noticeable, or a second deployable appears.

---

## D-003 · 2026-08-15 · Only `packages/canon` is a TypeScript project today

**Decision.** `ledger-core`, `ingest`, `reconciler`, and `apps/api` exist as directories
with a README stating their purpose, dependencies, and the phase that builds them — but no
`package.json`, `tsconfig.json`, or `src/`.

**Why.** An empty package that exports nothing is dead code that the build must carry and a
reviewer must read past. The layout and the dependency graph are the Phase 0 deliverable,
and a README delivers both without stubs. Each package gets its manifest in the phase that
gives it something to export.

**Alternatives rejected.** Stub packages with `export {}` — satisfies "the folder exists"
while violating the rule against speculative scaffolding, and makes `npm run build` do work
that proves nothing.

---

## D-004 · 2026-08-15 · A payment is two transactions, and the fee is booked at settlement

**Decision.** A payment is recorded as two ledger transactions, not one:

```
T+0        authorized   psp_receivable  +gross      merchant_revenue  -gross
T+1/T+2    settled      bank_account    +credited   psp_receivable    -Σ discharged
           on bank      fees_expense    +fee        taxes_withheld    +tax
           evidence     psp_reserve     +reserve    penalties         +penalty
```

Revenue is booked at **gross** — what the customer actually paid. The deductions are
**debits**, booked only when the money actually arrives and the amounts are known.

**Why.** Three reasons, in order of weight.

1. **At T+0 the fee is not yet known.** A rate card can change, a cap can apply, an
   international surcharge can land. Booking an estimated fee at authorization would put a
   guess in the books and require correcting it later — and corrections mean compensating
   transactions for something we never had to assert. Phase 3 already says the fee is booked
   on match: *"moving value from `psp_receivable` to `bank_account` and booking the fee."*
2. **`psp_receivable` becomes the single most useful number in the business** — at any
   instant it is exactly the money promised but not yet paid. That only holds if the
   receivable opens at gross and closes at gross.
3. **The signs are right.** An expense is debit-natural; a fee is a cost, so it is positive.

**Supersedes.** The worked example in Part I of the bible, which books this as one
transaction with `psp_receivable +10,000 / merchant_revenue −9,850 / fees_expense −150`.
That sums to zero, so it satisfies Law 1, but it credits an expense account and understates
revenue to net. It also conflates two events that happen at different times — and the gap
between those times is the entire reason this system exists. The bible's Phase 3 text
already describes the two-transaction model; the Part I sketch is the outlier.

**Amended 2026-08-16, by D-027 and D-031.** The count is unchanged and so is every reason
above: a payment is still **two ledger transactions**, revenue is still booked at gross, and
the deductions are still booked only when they are known. Two things in the sketch had
drifted from the code and are corrected there.

*What triggers the second transaction.* It is not the settlement file. Under the three-way
model a PSP's report books nothing at all — it produces an `expected_inflow` and its
allocations, which are reconciliation state, not ledger state. Only an independent bank
credit moves `bank_account`. So there are **three records and two transactions**, and the
gap between the second record and the second transaction is where a payout that was reported
and never sent now lives.

*What the second transaction contains.* Not `+net` and a single fee. It books `+credited` —
what the bank actually paid, which may differ from what the PSP promised — against every
*named* deduction: fee, tax, reserve, penalty, and a bank charge where one was levied. A
reserve is an asset, not an expense. If the named deductions and the credit do not account
for the receivable exactly, the booking is refused rather than plugged.

Documented in [FIRST-PRINCIPLES.md § A payment, end to end](FIRST-PRINCIPLES.md#a-payment-end-to-end).

---

## D-005 · 2026-08-15 · `SourceId` is an open `string`, not a union of known PSPs

**Decision.** `type SourceId = string`, not `type SourceId = 'paystack' | 'opay' | ...`.

**Why.** A closed union would mean adding a payment source requires editing the canonical
language — the one package everything depends on — and it would invite exhaustive `switch`
statements downstream, which is precisely the source-branching Law 7 forbids. The target
attribute is that a new source is *one adapter and nothing else*. Per-source variation
travels as **data** (a `SettlementWindow`, a fee model) attached to the source by its
adapter, never as a branch on its name.

**Cost accepted.** Typos in a source name are not caught by the compiler. They will be
caught at the ingest boundary, which is where unknown-source handling belongs anyway.

---

## D-006 · 2026-08-15 · `Money` is a `bigint` wrapper, not a bare `bigint`

**Decision.** `Money = { kobo: bigint, currency: 'NGN' }`, per Appendix A, rather than
passing `bigint` kobo directly.

**Why.** A bare `bigint` is structurally identical to a count, an ID, or a timestamp, so the
compiler cannot stop you adding a transaction count to an amount. The wrapper makes every
amount self-describing at the point of use and gives `FX_ROUNDING` — already in the reason
codes — somewhere to live when a second currency appears.

**Cost accepted.** Allocation per amount, and arithmetic through functions rather than
operators. Both are irrelevant at this system's volumes, and neither is a correctness risk.
`Currency` is a single-member union today; the mismatch guard in `add`/`subtract` is
unreachable now and deliberately kept, because it is an invariant assertion, not a
compatibility shim.

---

## D-007 · 2026-08-15 · Timestamps are `Date`, and "now" is always passed in

**Decision.** Canonical types carry `Date`, and every function whose answer depends on the
current time takes an explicit `asOf: Date` — see `isWithinWindow`. No function in the core
ever calls `new Date()`.

**Why.** Law 5. If a reconciliation run reads the wall clock, the same inputs produce
different partitions on different days and replay proves nothing. Passing the clock in makes
time an input like any other, which is also what makes settlement-window logic testable
without waiting a day.

**Alternatives rejected.** ISO-8601 strings — immutable and JSON-clean, but every window
calculation would parse them back to a `Date` anyway, moving the cost without removing it.
JSON serialisation of `Date` (and of `bigint`) is the API layer's problem, at the boundary,
which is where representation concerns belong.

---

## D-008 · 2026-08-15 · `SettlementWindow` models only a deadline

**Decision.** `SettlementWindow = { deadlineMinutes: number }` — an upper bound only, though
the bible describes windows as ranges ("T+1..T+2").

**Why.** Every use of the window is the same question: *is this promise overdue yet?* Money
arriving earlier than expected is still money, and matching it early is never an error, so a
lower bound would be a field nothing reads.

**Revisit when.** Suspiciously-early settlement becomes a signal worth raising — at which
point the lower bound arrives with a reason code and a consumer, not before.

---

## D-009 · 2026-08-15 · `STATUS_RANK` is defined here and must be reconciled with `pay-normalize` in Phase 2

**Decision.** `packages/canon/src/payment.ts` defines
`pending(0) < failed(1) < success(2) < reversed(3)`, with a higher rank superseding a lower
one.

**Why.** Out-of-order webhook delivery must resolve to the same final status regardless of
arrival order (Law 5), so the ordering is part of the canonical language rather than an
ingest implementation detail. `reversed` outranks `success` because a reversal is always
later news than the success it undoes. `success` outranks `failed` because a success
notification for a reference we thought had failed is a real outcome, while a late failure
notice for a reference that succeeded is stale.

**Open.** `pay-normalize` has its own `STATUS_RANK` table, which has not been read here.
Phase 2 must diff the two and collapse them to one definition — two ranking tables that can
disagree is a determinism bug waiting to happen. If they differ, `pay-normalize`'s
production-tested ordering wins and this entry is superseded.

---

## D-010 · 2026-08-15 · `reasonHints` are retained verbatim and never parsed for decisions

**Decision.** `SettlementLine.reasonHints` keeps whatever narration a source attached, as
free text. It is shown in exception context and kept as evidence for a match. No matching
decision may be made by parsing it.

**Why.** Parsing narration means writing source-specific string patterns, and those patterns
would live downstream of the ingest boundary — Law 7 violated in spirit even without an
`if (source === ...)`. Anything a hint *means* must be lifted into a typed canonical field
by the adapter that understands that source.

---

## D-011 · 2026-08-15 · No test harness in Phase 0

*Superseded by D-023 — Phase 1 established the harness, as planned.*

**Decision.** `packages/canon` ships with no tests.

**Why.** Phase 0 delivers a vocabulary; the compiler is its test, and the exit criterion is
that it compiles and reads clearly. Phase 1 is where behaviour worth asserting appears, and
it establishes the harness — including the property test that Laws 1 and 6 hold across
thousands of random transactions.

**Revisit.** Phase 1, immediately.

---

# Phase 1 and Phase 2

## D-012 · 2026-08-15 · `pay-normalize` is a published npm dependency, and it does more than the bible assumed

**Decision.** `packages/ingest` depends on `@pay-normalize/core`, `/paystack`,
`/flutterwave`, `/nomba` and `/monnify`, from npm.

**Why.** They are published under a scope — the unscoped name `pay-normalize` does not
exist, which is what made the first lookup fail. A registry dependency keeps the Docker
build context self-contained; vendoring tarballs or a `file:../pay-normalize` link would
have put the sibling repo outside the build context and broken the image.

Reading the library changed the shape of Phase 2 substantially. The bible frames settlement
ingestion as entirely new work; in fact `@pay-normalize/core` already defines a `Connector`
interface including `parseSettlementFile`, and Flutterwave, Nomba and Monnify ship working
settlement and transaction-record parsers. It also already owns kobo conversion,
`STATUS_RANK`, dedupe-key composition, and four signature schemes. Following AGENTS.md —
*lean on the dependencies already in the project; do not assume a library lacks a
capability without checking* — Phase 2 became a thin translation layer plus the two things
a deliberately stateless library will never have: an expected settlement window and an
expected fee.

**Note.** The bible names OPay as a source. The published connectors are Paystack,
Flutterwave, Nomba and **Monnify**. Built against what exists.

---

## D-013 · 2026-08-15 · Canon adopts `pay-normalize`'s status spelling

**Decision.** `PaymentStatus` is `PENDING | FAILED | SUCCESSFUL | REVERSED`, character for
character identical to `TransactionStatus` in `@pay-normalize/core`.

**Why.** D-009 guessed the *ordering* and guessed right — pending < failed < successful <
reversed — now confirmed by reading their `STATUS_RANK` and the reasoning attached to it.
But it used lowercase names, which would have required a mapping table at the boundary.
Two vocabularies for one concept is exactly what `canon` exists to prevent, and a mapping
table is a thing that can drift. Adopting the upstream spelling deletes the table.

**Supersedes.** The naming half of D-009. The ordering half stands, now verified rather
than assumed.

---

## D-014 · 2026-08-15 · A transaction's id *is* the causing event's idempotency key

**Decision.** `ledger_transactions.transaction_id` is the primary key and holds the
idempotency key. There is no separate `idempotency_key` column, and
`LedgerTransaction.idempotencyKey` was removed from canon.

**Why.** A transaction is the record of exactly one event, so giving it a second identity
means maintaining two uniqueness constraints that can disagree. With the equality, Law 4 is
enforced by the primary key itself: `INSERT … ON CONFLICT DO NOTHING` resolves a redelivery
*in the database*, with no read-then-write window for two concurrent workers to both pass.
Derived transactions follow the same rule — a reversal is `${original}#reversal`, so
reversing twice collides on the key instead of refunding twice.

**Consequence.** Ids are derived, never generated. There is no `randomUUID()` in any write
path, so replaying the same events produces a byte-identical database (Law 5).

---

## D-015 · 2026-08-15 · Law 1 is a deferred constraint trigger; Law 2 is a mutation-rejecting trigger

**Decision.** Both laws are enforced in Postgres, not in TypeScript. Law 1 is a
`CONSTRAINT TRIGGER … DEFERRABLE INITIALLY DEFERRED` on `entries`; Law 2 is a
`BEFORE UPDATE OR DELETE` trigger on the three history tables.

**Why.** A check that lives only in application code is a check that a migration script, a
`psql` session, or a second service can walk straight past. The application keeps a
fail-fast check too, but only so humans get an error naming the missing money — the
database has the final say.

**Deferred specifically**, because entries are inserted row by row: an immediate check
would fire on the first row and reject every balanced transaction ever written. Deferring
to `COMMIT` lets the trigger see the whole set while still running inside the committing
transaction, so concurrency cannot slip an unbalanced transaction through.

The demo and the test suite both prove this by writing entries with raw SQL, bypassing
every line of our code, and letting `COMMIT` be the thing that refuses.

**Cost accepted.** `account_balances` is exempt from the append-only triggers, because a
cache that cannot be updated is not a cache. Law 6 is what keeps it honest.

---

## D-016 · 2026-08-15 · Lifecycle state is derived, not stored

**Decision.** `ledger_transactions` has no `state` column. Transitions are appended to
`transaction_state_changes`, and the current state is a `DISTINCT ON` view.

**Why.** A mutable state column means an `UPDATE`, and `UPDATE`s are how history gets
quietly rewritten. Ordering is by the change sequence rather than by timestamp, so the
answer never depends on a clock (Law 5). `transition()` takes a row lock, because two
workers reacting to the same settlement file would otherwise both read `authorized` and
both append — recording one event twice.

`settled` and `reversed` are terminal; `exception` is not, because an exception is a
question, and questions get answered by a late settlement file.

---

## D-017 · 2026-08-15 · Idempotency keys take the connector's `dedupeKey` whole

**Decision.** `idempotencyKey(rail, dedupeKey)` prefixes the rail onto the key the
connector produced, rather than recomposing it from `${source}:${reference}`.

**Why.** Connectors may legitimately override `dedupeKey` when a provider's reference is
not one-to-one with a transaction. **This is not hypothetical: Paystack does it**,
producing `paystack:charge:PSK_…`. A first-draft test asserted the recomposed form and
failed — the code was right and the test was wrong. Recomposing would have silently
discarded the connector's knowledge and collided two distinct events onto one key, which
under D-014 means one of them would be dropped as a duplicate.

The rail prefix exists because a promise and a settlement for the same reference are
different events and must not collide.

---

## D-018 · 2026-08-15 · Their kobo is a `number`; ours is a `bigint`

**Decision.** `toMoney()` in `packages/ingest/src/kobo.ts` is the single place a connector
amount becomes canonical `Money`.

**Why.** `@pay-normalize/core` represents kobo as a branded `number` guarded against
exceeding `MAX_SAFE_INTEGER`; we store `BIGINT` and would rather carry no ceiling at all.
Widening a safe integer to `bigint` is exact, so nothing can be lost. The hard part — never
letting a float touch money — is already done upstream with string and BigInt parsing, so
this is a representation change guarded by one assertion that catches a non-integer
escaping the library's guarantees.

---

## D-019 · 2026-08-15 · `SettlementLine.settledAt` is nullable

**Decision.** `Date | null`, mirroring `settlementDate` upstream.

**Why.** Not every source discloses when the money moved. Both alternatives are worse:
defaulting to the transaction's own timestamp fabricates a settlement date that reads as
authoritative, and rejecting the row discards real money over a missing field. `null`
states the truth — "this source told us money moved, but not when" — and forces the matcher
to reason with the promise's timestamp instead.

---

## D-020 · 2026-08-15 · Ingest has no database; dedupe takes an injected predicate

**Decision.** `dedupe(items, alreadySeen)` is a pure function over a set passed in. There is
no `settlement_lines` table anywhere yet.

**Why.** The dependency graph says ingest depends on `canon` and `pay-normalize` and
nothing else, which makes it exhaustively testable with no I/O. Persisting settlement lines
is genuinely the **reconciler's** concern — it is the component that reads them — so Phase 3
is where that table belongs. Creating it in `apps/pipeline` now would mean building it in
the wrong place with a planned relocation, which is the stopgap AGENTS.md forbids.

**Consequence, stated plainly.** Webhook idempotency is durable: the ledger's primary key
enforces it across restarts. Settlement-line idempotency is currently enforced only within
a run. Phase 3 makes it durable when it gives settlement lines their permanent home.

`dedupe` also drops duplicates *within* one batch — an overlapping re-export, or a provider
listing a record twice on one page. That half is easy to forget and does identical damage.

---

## D-021 · 2026-08-15 · Chart-of-accounts policy lives in `ledger-core`, not in the app

**Decision.** `bookAuthorizedPayment()` is in `packages/ledger-core/src/bookings.ts`.

**Why.** `postTransaction` is the *mechanism* — it writes any balanced set of entries.
Which accounts a given economic event touches is *policy*, and policy about our chart of
accounts is exactly what the ledger is the authority on. Putting it in the app would put
business logic in the layer the bible says must contain none, and would make every future
deployable reimplement it.

It takes a `CanonicalPayment`, which is canonical language from `canon`, not a foreign
shape. Law 7 forbids branching on the source; it does not forbid knowing that payments
exist. Phase 3's `bookSettlement` gets a natural home next to it.

**It refuses to book a non-`SUCCESSFUL` payment**, because booking a pending or failed
payment as a promise would put cash in the books that nobody ever agreed to send.

---

## D-022 · 2026-08-15 · `apps/pipeline` exists so Phase 7 has something to run

**Decision.** A CLI deployable — `migrate`, `demo`, `balances`, `verify`,
`ingest-settlement` — built now, out of the bible's order.

**Why.** Containerisation was requested alongside Phases 1 and 2, and a container needs a
program. Phase 6's Fastify service is not built, and building half of it would be worse
than building a small honest thing. The CLI is the smallest deployable that exercises
Phases 1 and 2 end to end, and it respects the library/deployable split.

**Not a stopgap.** When `apps/api` arrives it *joins* this one rather than replacing it — a
service and a CLI over the same libraries is exactly the reuse that split exists to allow.
Nothing inside `packages/` changes when it does.

---

## D-023 · 2026-08-15 · Plain SQL migrations with a checksum-verifying runner

**Decision.** Numbered `.sql` files and a small runner, rather than a migration framework.
Each file runs once, in its own transaction, and its SHA-256 is recorded.

**Why.** A framework would add a CLI, a config file and a second file format to buy
ordering and once-only semantics — which is what the runner does in one function. The
checksum earns its place: editing an applied migration becomes a loud error instead of a
silent no-op, so the schema in front of you is always the schema that was built.

`runMigrations` takes a list of directories, so each package can own its migrations without
a shared numbering authority; colliding filenames are rejected with an explanation.

**Related.** `syncAccounts` re-seeds the `accounts` table from `CHART_OF_ACCOUNTS` on every
run, making the TypeScript constant the source of truth and the table a projection of it.
Two copies of anything can disagree; this makes the code win by construction.

**Supersedes D-011.** The test harness arrived with Phase 1, as planned: `node --test` with
no runner dependency, plus `fast-check` for the property test.

---

## D-024 · 2026-08-15 · `reverse()` is an exact negation, and nothing more

**Decision.** It negates every entry of the original. It does not touch the `reversals`
contra-income account.

**Why.** This is the mechanical Law 2 primitive, and it must be provably correct without
knowing what kind of business event caused it. Booking a refund as contra-income — so that
gross revenue reporting survives the refund — is a *domain* decision about which account
should absorb it, and that judgement belongs to the reconciler, which composes it from
`postTransaction` directly.

**Consequence.** `reversals` and `chargebacks` are unused until Phase 3. That is correct:
they are vocabulary the domain needs, and Phase 3 is what needs them.

---

## D-025 · 2026-08-15 · No Paystack settlement adapter

**Decision.** `sourceProfile('paystack').settlement` is `null`;
`ingestSettlement('paystack', …)` throws `NoSettlementAdapterError`.

**Why.** Paystack's own connector refuses to parse settlement exports until a sanitized
real file pins the column layout, and that refusal is right. Inventing a column mapping
from documentation would produce a parser that looks correct and is wrong — and a wrong
settlement parser does not fail loudly, it quietly books the wrong amounts. Honest
unsupported beats silently wrong.

Phase 2's exit criterion — two different foreign shapes becoming identically shaped lines —
is met by Flutterwave (a JSON envelope with a nested data array) and Nomba (a bare array of
records), which are genuinely different shapes.

**To enable it.** Donate a sanitized export upstream, or write the adapter here against a
real file. One entry in the source table changes.

---

## D-026 · 2026-08-15 · The window models a deadline, and a rate card may be `null`

**Decision.** T+1 sources are given a T+2 window. `expectedFee` is `null` for Nomba.

**Why (window).** The window marks the point at which silence becomes an exception a human
is woken for — not the point at which money is expected. Setting it to the expected arrival
time makes every weekend and public holiday an incident, and an alert that cries wolf is
worse than no alert.

**Why (`null`).** Nomba prices per merchant, so there is no public card to encode. A
guessed rate card would generate a permanent stream of false `FEE_VARIANCE` findings, which
is worse than admitting we cannot predict the fee: the matcher falls back to reference and
exact amount, and reports the fee it observed.

**Validation.** Paystack states the fee it charged in its own webhook payload, so the rate
card is checked against Paystack's own arithmetic rather than against our reading of their
pricing page — on three amounts that each exercise a different branch (flat waived, exactly
at the waiver threshold, percentage plus flat). All three agree to the kobo.

---

# Phase 3 — the three-way redesign

## D-027 · 2026-08-16 · Reconciliation is three-way: webhook, PSP report, bank statement

**Decision.** The webhook, the PSP's settlement report and the bank statement are three
independent records. **Only bank evidence may increase `bank_account`.** A PSP report is
recorded as a `Payout` with status `reported`, matched to the payments it covers, and
books *nothing*.

**Why.** A settlement report is a party with an interest in the answer describing its own
future behaviour. Treating it as cash makes four ordinary events invisible: a payout that
is reported and never sent, one the bank returns two days later, one credited short of a
correspondent-bank charge, and one credited twice. Each of those is a real Tuesday, and
each is undetectable by a system whose books already say the money arrived.

**Consequence, stated plainly.** The first version of Phase 3 booked
`bank_account +net / fees_expense +fee / psp_receivable −gross` the moment a settlement
line matched a promise. That was internally consistent and wrong about the world. It is
gone; `bookSettlement` no longer exists, and `bookBankConfirmedSettlement` replaces it.

**Alternatives rejected.** A `psp_payout_expected` clearing account moved between the two
stages. It reads well and buys nothing here: the reported-not-received state is a
reconciliation fact with a lifecycle, not a balance, and it lives in `expected_inflows`
where it can carry a value date, a source and an evidence id. Adding a ledger account for
it would put a second, weaker copy of that state in the books.

---

## D-028 · 2026-08-16 · The payout is a first-class entity, and inflows unify the two source shapes

**Decision.** `Payout` carries a `payoutReference`, its own itemised deductions and an
`expectedNet`. Settlement lines belong to one. Both shapes normalise into an internal
`ExpectedInflow`, which is the only thing stage three matches against.

**Why.** Sources fall into two camps and flattening them loses the distinction that makes
matching tractable. Flutterwave names the movement — one reference, one fee breakdown,
`charge_count` charges it does not enumerate. Nomba and Monnify list transactions and
leave the movement implicit. A named payout is *strictly better information*: the PSP has
told us the grouping, so arithmetic only has to confirm it rather than discover it.

Writing the bank matcher twice, once per shape, would be two chances to get it subtly
differently wrong. `ExpectedInflow` carries what stage three actually needs — how much,
when, from whom, which promises, what was deducted — and a `derived` flag, because an
inflow the PSP told us about and one we grouped ourselves deserve different treatment in
an exception queue.

**Cost accepted.** Derived inflows are keyed by source and settlement date, which is a
grouping we invented. It is labelled as such, and a bank credit that does not match it
escalates rather than being forced onto it.

---

## D-029 · 2026-08-16 · Deductions are named, and a booking that needs a plug is refused

**Decision.** `AdjustmentKind` is `fee | tax | reserve | reserve_release | penalty |
refund | chargeback`, each mapped to its own account. `bookBankConfirmedSettlement`
throws unless `Σ discharged = credited + Σ named deductions`.

**Why.** "The payout is ₦4,200 short" is not a fact anybody can act on. "₦4,200 is a
rolling reserve you get back in 90 days" is. A reserve is an **asset** — the PSP is
holding our money, not keeping it — and booking it as a cost understates what we are owed
by exactly the amount we are owed. Tax is an expense but not the PSP's, so it gets
`taxes_withheld` rather than inflating what looks like PSP pricing.

The refusal to plug is the load-bearing half. Forcing the difference into `fees_expense`
always balances and always lies: an unexplained ₦40,000 shortfall becomes an unusually
expensive Tuesday nobody investigates. A transaction that will not balance without a plug
is one whose story we do not know, and escalating is the honest response.

**Related.** `payoutArithmetic` checks the PSP's report against *itself* before any
matching. A file whose declared net does not equal its gross less its own itemised
deductions raises `PAYOUT_UNBALANCED`, because otherwise every downstream discrepancy
gets blamed on the payments rather than on the file.

---

## D-030 · 2026-08-16 · Fee contracts are versioned data, not a function

**Decision.** `FeeContract` carries `effectiveFrom`/`effectiveTo`, a merchant, a VAT rate
and an approver. `FeeModel` is `(gross, at) => FeeBreakdown | null`. Contracts live in
`fee_contracts` with a `btree_gist` exclusion constraint forbidding overlap.

**Supersedes** the `expectedFee: FeeModel | null` field on `SourceProfile` from D-026, and
the single-rate `feeModel(card)` from Phase 2.

**Why.** Three things a constant cannot do. **Reconciling last quarter must use last
quarter's rates** — applying today's renegotiated card to March invents a fee variance on
every March payment, and history does not change because a contract did. **VAT is its own
deduction**, bound for the tax authority rather than the PSP, and a model returning one
number cannot separate them. **A rate is an assertion somebody approved**, so "why did we
expect 1.4%?" has an answer with a name and a date on it.

Overlap is a database constraint rather than a read-time tie-break because two contracts
in force at once makes fee expectations non-deterministic, which is a Law 5 problem
wearing a data-entry costume.

**Cost accepted.** Contract administration and an approval workflow. The published rate
cards remain as seeds, with `approvedBy: 'published-rate-card'` — a list price we read,
not an agreement anyone signed, and the queue can tell the difference.

---

## D-031 · 2026-08-16 · Deadlines are business days and cut-offs, not fixed minutes

**Decision.** `BusinessCalendar` replaces `SettlementWindow`: a cut-off time, a count of
business days, weekends, Nigerian public holidays, and a grace period.

**Supersedes D-008 and the window half of D-026.** `deadlineMinutes` is gone.

**Why.** T+1 is a business rule. A card payment taken at 6pm on the Friday of a long
weekend is not overdue on Saturday evening, and a system that says so raises an exception
every single weekend until the people reading the queue stop reading it. An alert that
cries wolf is worse than no alert, which was already D-026's argument — this is the same
argument taken seriously enough to model the calendar.

Cut-off and grace are separated deliberately: the deadline is when money was *expected*,
grace is how long its absence is tolerated. Conflating them is what made the old fixed
window need padding to T+2 to avoid false alerts, which in turn made genuinely late money
invisible for an extra day.

**Cost accepted.** Holiday tables go stale, and two Nigerian holidays move with the lunar
calendar and are announced days ahead. The failure is visible and mild: a settlement that
was never late gets flagged, which is a false alert rather than a silent miss.

---

## D-032 · 2026-08-16 · Allocation is an amount, so settlement can be partial and split

**Decision.** `inflow_allocations` links a promise to an inflow with an **amount**. A
deferred constraint trigger enforces that a payment is never allocated beyond its
receivable. A partly-discharged promise keeps its `authorized` state.

**Why.** A PSP can settle half a payment now and half when a dispute hold lifts, and one
payout covers many payments. Modelling the link as a quantity is what lets both be true at
once. Under the previous flag-shaped design a half-settled payment had no representation,
so it was reported as a mismatch — escalating something that was going perfectly well.

The over-allocation trigger is in the database because without it two payouts could each
claim the whole of one payment and the ledger would discharge the same receivable twice.
That is a check no application-level guard should be trusted with.

**Partial matching refuses to guess.** Taking part of a promise is a stronger claim than
taking all of one, because the leftover stays open and gets matched again later. So a
payout smaller than any single receivable is allocated only when exactly one candidate
could absorb it.

---

## D-033 · 2026-08-16 · Evidence is content-addressed and kept; narration is tokenised, never interpreted

**Decision.** Every canonical record carries an `evidenceId` — the SHA-256 of the file it
came from. `evidence` stores the bytes, the uploader, the receipt time and the parser
version, and is append-only. Bank narration is parsed into `narrationTokens` (candidates),
never into a resolved reference.

**Why.** Six months later, "the system matched it" is not an answer. *Which file? Who
uploaded it? Which parser read it?* are the questions actually asked, and a system that
cannot answer them has produced numbers nobody can defend. Content-addressing makes
re-uploading a file a no-op by construction, and makes "is this the file you used?"
answerable by anyone holding the file.

`parserVersion` earns its place because a parser is part of the reasoning: when an adapter
is corrected, every conclusion the old one reached is suspect, and findable.

**On narration.** It is the only thing linking a credit to a payout for most Nigerian
banks, and it is truncated, inconsistent and often useless. A parser that picked a
reference out of it would be guessing invisibly, and its guess would be indistinguishable
from a reference the bank actually supplied. So the parser extracts candidates and the
matcher resolves them against payouts it actually holds. This is D-010's rule — narration
is evidence, never a decision — applied to the bank side.

**Cost accepted.** Storage, retention and sensitive-data controls. `evidence.raw` is
nullable so a deployment can truncate on a schedule and keep the hash forever.

---

## D-034 · 2026-08-16 · Human resolutions are appended, never applied

**Decision.** `resolutions` is append-only: subject, action, reason, a named person, a
timestamp, optional supporting evidence and an optional approver. There is no
`updateResolution`.

**Why.** Law 2, extended from the ledger to the judgements made about it. A reviewer does
not edit a match, change an amount or clear an exception — they state what they concluded
and why. A wrong decision is corrected by a second resolution, so both stay visible and so
does the fact that somebody changed their mind. `resolvedBy` is a person, not a role and
not a service account, because "operations" cannot be asked what it was thinking.

Approval is all-or-nothing by constraint: a half-recorded approval is worse than none,
because it looks like oversight happened.

**Cost accepted.** An operational UI and workflow, which is Phase 6's problem. The
vocabulary and the table exist now so that Phase 4's exception queue has somewhere honest
to write.

---

## D-035 · 2026-08-16 · The matcher refuses to guess, in four distinct places

**Decision.** Ambiguity escalates rather than resolving. Specifically: a batch with two
valid subsets; a bank credit fitting two open inflows equally well; a reference naming two
promises; a shortfall larger than the source's declared bank-charge allowance.

**Why.** These all share one shape. A wrong match does not fail loudly — it silently
settles the wrong records and leaves the right ones to escalate later as inexplicable
absences, long after anybody can reconstruct what happened. Escalating an ambiguous payout
costs a human five minutes; guessing costs them a week of not knowing anything is wrong.

The bank-charge allowance is the one deliberate tolerance in the system, and it is
per-source data rather than a constant: correspondent banks take small charges nobody
announces, so a credit ₦52.50 short is ordinary and one ₦52,000 short is not. The only
thing separating them is a number somebody chose on purpose.

**Note on tolerance generally.** Tier-3 batching remains exact-sum. In integer kobo with a
dated fee contract there is nothing to be tolerant *of*, and a tolerance is how wrong
matches get made. `FX_ROUNDING` exists for the day a second currency appears.

---

## D-036 · 2026-08-16 · `AMOUNT_MISMATCH` and six other reason codes join Appendix C

**Decision.** Added: `PAYOUT_MATCH`, `BANK_CONFIRMED`, `AWAITING_BANK_CREDIT`,
`PARTIAL_SETTLEMENT`, `RESERVE_WITHHELD`, `TAX_WITHHELD`, `PENALTY`, `BANK_CHARGE`,
`AMOUNT_MISMATCH`, `DUPLICATE_BANK_CREDIT`, `RETURNED_PAYOUT`, `UNIDENTIFIED_CREDIT`,
`PAYOUT_UNBALANCED`. `REASON_KIND` groups every code as a match, an explanation or an
exception.

**Why.** The doctrine says a difference with no reason code is not allowed to exist. The
three-way model creates differences the original taxonomy could not name — chiefly
"reported but not banked", which is neither matched nor missing and is the most common
real state in Nigerian settlement. `AMOUNT_MISMATCH` closes the older gap: two records
naming the same reference and disagreeing about the amount, with no fee contract able to
explain it, previously had to masquerade as a phantom credit plus a missing settlement.

The grouping lives in `canon` because it is a statement about what a code *means*, and a
second copy of it in the matcher could disagree with this one.

---

## D-037 · 2026-08-16 · Fee contracts are scoped by channel and currency, and specificity breaks the one allowed overlap

**Decision.** A `FeeContract`'s scope is `(source, merchantId, channel, currency)`. `channel`
is a value, not a nullable field, and `'*'` means a blended contract covering every channel.
The exclusion constraint forbids overlap *within* a scope; a channel-specific contract
beside a `'*'` one is a deliberate overlap resolved by `contractAt` in favour of the more
specific.

**Why.** Nigerian PSPs price a bank transfer at ten naira flat and a card at 1.5% capped.
One rate per merchant predicts ₦7,500 on a ₦500,000 transfer that actually cost ₦10. That
never produces a wrong balance — the fee charged always wins — but it produces a
`FEE_VARIANCE` on every transfer for ever, which is an exception queue nobody reads, which
is the same as having no fee model at all, only noisier.

Currency is in the scope for the same reason at a larger scale: a rate quoted in naira says
nothing about a payment in dollars, and stretching it to cover one would invent a variance
denominated in a currency the contract never mentioned.

**On `'*'` rather than `NULL`.** A nullable wildcard reads as a bug the first time somebody
adds a channel-specific contract beside it, and an exclusion constraint cannot express
"overlaps unless one side is a wildcard" anyway. Making it a value keeps the constraint
exact and states the precedence rule in exactly one place.

**On the unknown channel.** `'unknown'` is a legitimate value — several sources do not
disclose the rail, and a payout report names a movement rather than a channel. It finds a
blended contract or nothing. It is never silently priced as a card, which would be inferring
a rate from an absence.

**Cost accepted.** Two seeded contracts per source instead of one, and a channel that has to
travel with the payment — hence `ledger_transactions.channel`, which is descriptive metadata
about the causing event exactly as `source` and `reference` already are. USSD and POS
collections are left unpriced on purpose rather than given a made-up card rate.

---

## D-038 · 2026-08-16 · Calendars name a time zone; holiday tables are versioned and their coverage is explicit

**Decision.** `BusinessCalendar` carries `timeZone` (IANA) and `cutOffMinutes` in *local*
time, replacing `cutOffMinutesUtc`. Holidays arrive as `HolidayCalendar` editions with a
`calendarId`, a `revision` and explicit coverage bounds; the highest revision covering a day
wins, and `isCovered` answers whether we hold any table at all.

**Why.** The old model got Nigeria right by hand-arithmetic — WAT is UTC+1 with no daylight
saving, so a 5pm cut-off was `16 * 60` and a human had done the subtraction. That is correct
until the first rail in a zone that observes daylight saving, where it is wrong for half the
year, silently, in the direction of false alerts. A cut-off is a wall-clock time in a named
place; the conversion belongs to the platform's IANA data, not to a subtraction somebody
remembered to do.

**On revisions.** Eid al-Fitr and Eid al-Adha are lunar and are announced by the federal
government days beforehand, often with an extra day declared beside them. The table for a
year genuinely changes *during* that year. Without a revision, a run before the correction
and a replay after it disagree about whether a payment was late and nothing in the record
says why — Law 5 failing quietly. With one, the correction is a citable fact and the
superseded edition still exists to explain what it decided. `deadlineProvenance` returns the
editions consulted, so a conclusion can name them.

**On coverage.** A year we hold no table for is not a year with no holidays. The deadline
still computes — a missing table can only make a settlement that was never late look late,
which is mild and visible — but the gap is askable rather than silent.

**Cost accepted.** `Intl.DateTimeFormat` on the path, cached per zone; a two-pass offset
resolution for the wall-clock-to-instant direction; and holiday tables somebody maintains
per jurisdiction and year.

---

## D-039 · 2026-08-16 · A canonical record traces to a row, and evidence carries a storage locator

**Decision.** Every canonical record carries `lineage: { rowNumber, path }` beside its
`evidenceId`, recorded by the parser. `Evidence` gains `storageLocation`.

**Why.** "Which file?" was already answerable. In a five-thousand-row export that is not the
question — reproducing a conclusion means finding the row again, and "somewhere in this
file" is not finding it. The path is a locator in the artifact's own idiom (`$[3]`,
`$.data[3]`), because a locator that names the wrong container is worse than none.

`storageLocation` exists for the deployment `evidence.raw` cannot serve: statements run to
hundreds of megabytes and retention policy eventually says delete the payload and keep the
record. When `raw` is truncated it is the only thing between a hash and an unanswerable
question. It is recorded at ingest and never resolved there, which keeps the ingest layer
free of a network.

**Cost accepted.** Three more columns on three tables, and a parser that has to count.

---

## D-040 · 2026-08-16 · Batch deductions are apportioned pro rata by gross, by largest remainder, ties broken by transaction id

**Decision.** Each allocation stores its share of every deduction and the resulting net. The
rule is pro rata by gross allocated, resolved by largest remainder, with equal remainders
broken by transaction id, applied per account independently.

**Why the question has to be answered at all.** Gross allocation says which receivables a
payout closed. It does not say what *this* payment cost — the number behind per-payment
margin, per-merchant profitability, and every fee dispute anyone has ever had with a PSP.

**Why this rule.** Pro rata by gross, because Nigerian PSP pricing is overwhelmingly
percentage-driven and a payment twice the size did attract roughly twice the fee. Largest
remainder, because integer kobo do not divide evenly and the shares must add back to the
total *exactly*: a rounding rule that loses a kobo makes the apportioned deductions disagree
with the deduction actually booked, which is a plug entry arriving one kobo at a time. Ties
by transaction id, because somebody has to get the spare kobo and "whichever the map
iterated first" is not reproducible (Law 5). Per account independently, because apportioning
the aggregate and splitting it afterwards rounds twice and reconciles to neither.

**What it is not.** It is not a claim about what the PSP would have charged had each payment
settled alone — a flat component or a cap makes that a different number. It is a defensible
split of a real charge, recorded with the rule that produced it.

**Why stored rather than recomputed.** The rule is a choice, and choices change. A stored
answer stays reproducible after the choice changes; a derived one silently becomes a
different answer.

**One deliberate limit.** Only the PSP’s deductions are apportioned. A correspondent-bank
charge is discovered at stage three, is levied on the credit rather than on any payment, and
arrives after the allocations are written — which are append-only. It books to
`bank_charges` on the confirming transaction and is visible there; it is not attributed to
individual payments, because nothing in the evidence says which payment attracted it.

---

## D-041 · 2026-08-16 · The contract that explained a decision is stored with the decision

**Decision.** `MatchResult.explainedBy` carries one `FeeExplanation` per promise — contract
id, scope, expected fee, expected VAT, observed fee — and `matches.fee_explanations`
persists it.

**Why.** Effective-dated contracts make March reconcile at March's rates. They do not, on
their own, make a March *decision* reproducible: rates are renegotiated, scopes are added,
and a rate card typo gets corrected. Recomputing an old conclusion against today's table can
therefore reach a different answer than the one we acted on — the exact failure the dating
was meant to prevent, moved one level up. So the answer is written down at the moment we
act, and "why did we accept a ₦165 fee in March?" is answered by a stored contract id rather
than by a re-derivation that may no longer reproduce.

**On nulls.** `contractId: null` records "we matched this on amounts alone", which is a
conclusion. A conclusion left unwritten is indistinguishable later from one nobody reached.

---

## D-042 · 2026-08-16 · A resolution is keyed, valued, maker-checked, and may post a compensating entry — never to `bank_account`

**Decision.** `Resolution` gains `resolutionKey` (its natural key, and the id of the
transaction it posts) and `amount`. `recordResolution` enforces an `ApprovalPolicy`, posts
the compensating journal in the same database transaction as the decision, and refuses any
entry touching `bank_account`. Self-approval is refused by the application *and* by a
database constraint.

**Why maker-checker.** The person who noticed a discrepancy is the person best placed to
make it disappear. They are usually acting in good faith and occasionally they are not, and
a second *named* person is the cheapest control that distinguishes the two — costing nothing
on the decisions that do not need it. `approveAnyBooking` means anything that moves value
needs one, whatever its size.

**Why the entry and the decision are one write.** A compensating entry whose justification
failed to save is money moved for no recorded reason, which is indistinguishable from money
moved for no reason.

**Why `bank_account` is forbidden.** This is the three-way design in one refusal. Cash moves
on bank evidence, and a human's conclusion is not bank evidence. An operator who believes
the bank balance is wrong has found either a statement line we have not ingested — in which
case ingest it — or a genuine bank error, which is resolved with the bank and arrives back
as a statement line. Neither is fixed by typing a number, and the moment this is allowed
"once, carefully", the whole three-way model is decoration.

**On correcting rather than editing.** A reclassification does not touch the original
booking. That booking recorded what we knew; that we were wrong about it is a second fact,
not a reason to erase the first. An auditor sees the mistake and the correction, which is
strictly more than seeing neither.

**Cost accepted.** Identities, permissions and an approval UI, which remain Phase 6's
problem. The rule, the key and the posting path exist now so that Phase 4's exception queue
has somewhere honest to write.

---

## D-043 · 2026-08-17 · An exception is an entity with an appended lifecycle and a derived key

**Decision.** Findings that reach `exception` become rows in `exception_events` — append-only
— with the current state derived by a view taking the newest event per key. The key is
`(subject, subjectId, reason)`, derived rather than generated. States are
`open → acknowledged → resolved`.

**Why an entity.** Phase 3 could say what was wrong *now*. It could not say that the same
thing had been wrong since Tuesday, that somebody was already looking at it, or that it had
quietly fixed itself. Every run started from nothing and reported everything, which is a
report and not a queue.

**Why a derived key.** Without it the queue grows by the number of runs rather than the
number of problems, and nobody opens it by Thursday. Derivation is also what lets a replay
reach the same keys as the run it replays (Law 5).

**Why events and a view rather than a `state` column.** A mutable state column is an
`UPDATE`, and `UPDATE`s are how history gets quietly rewritten. The ledger refuses that for
its own transactions — `transaction_state_changes` plus the `transaction_states` view — and
there is no argument for allowing it for the judgements *about* those transactions. The
shape here is deliberately the same one, so anybody who has read the ledger already knows
how to read this.

**On reopening.** An exception that resolved and is found again appends a reopening rather
than being treated as never having closed. A difference that comes back is not the same
event as one that never went away, and flattening the two would hide the most useful signal
the table holds: which problems recur.

**Cost accepted.** A view rather than a table on the read path, and a state machine somebody
has to keep in their head. `severityOf` sorts the queue by what the problem *is* rather than
when it arrived, because a queue sorted by arrival buries the alarming things under a week
of routine ones.

---

## D-044 · 2026-08-17 · The queue clears itself, by diffing each run's findings against what is open

**Decision.** After each run, exceptions the run no longer finds are resolved with cause
`evidence_arrived`. Scoped by subject kind, so a run that had nothing to say about a subject
does not close its problems.

**Why.** This is the doctrine's own exit criterion for Phase 4: a T+1 straggler sits as
pending, escalates when its window passes, and clears itself when the settlement file lands —
with nobody woken for any of it. Without the diff, the queue only ever grows, which is the
same as not having one.

**Why the cause is mandatory.** `exception_events` refuses a resolution with no cause, by
constraint. That single field is what lets the table answer the question it exists for: *how
much of this queue clears itself?* A queue where that number is high is one whose calendar is
tuned correctly; where it is low, either the calendar is wrong or something real is
happening. Recording closure without cause makes both indistinguishable.

**Why machine and human closure are different causes.** `evidence_arrived` and
`resolved_by_human` are the same outcome reached two ways, and conflating them would hide
how much human time the queue actually costs.

**On scoping.** Treating silence as "resolved" would close problems that are still entirely
real. Every run currently reads all three records and so may speak to all four subjects; a
future partial run must narrow the scope, and the parameter exists so that it can.

---

## D-045 · 2026-08-17 · The matcher keeps the candidates it rejected

**Decision.** `MatchResult.considered` carries up to four near-misses, each with the amount
it was out by and why it lost — `amount_differs`, `outside_window`, `already_claimed`,
`ambiguous`, `wrong_state`. It is persisted with the exception.

**Why.** The doctrine asks for exceptions surfaced with "the candidate explanations the
matcher considered and rejected", and the reason is practical. "₦12,000 credited, matches
nothing" is a mystery an operator has to reconstruct from scratch. "The nearest was PO-91 at
₦11,950 — ₦50 out — and PO-88 fits exactly but is already claimed by another credit" is a
decision they can make now. The matcher has already done that work; throwing it away and
making a human redo it by hand is the expensive part of an exception queue.

**Why bounded.** A list of every open inflow is not an explanation, it is a haystack with a
note attached. Four is a judgement: enough to show the shape of the near-miss, few enough
that a queue entry stays readable at a glance.

**Cost accepted.** A little more work on the failure path, and a JSONB column. Both are paid
only when something is already wrong.

---

## D-046 · 2026-08-17 · `RETURNED_PAYOUT` and `DUPLICATE_BANK_CREDIT` are produced, not merely declared

**Decision.** Stage three no longer filters the statement down to credits. A debit matching a
banked payout books an exact negation of the confirming transaction and marks the payout
`returned`; a second credit for money already banked is reported as a duplicate rather than
as unidentified. `confirm` takes the already-confirmed inflows as evidence for both.

**Why.** Both reason codes existed from Phase 3 and neither was reachable, as were
`bookReturnedPayout` and `markPayoutReturned`. A returned payout is the most alarming thing
a bank statement can say — we booked the money, told everyone the payment had settled, and
it bounced — and it arrives as a *debit*, which a credits-only stage three cannot see at all.

**On the duplicate.** Both outcomes refuse to book, so no money moves either way; the
difference is entirely in what the human is told. "We appear to have been paid this twice,
here is the first credit" is a morning's work. "Money we cannot identify" files the most
consequential bank event in the system beside a stray ₦42 credit.

**On exactness.** A return must match the credited amount exactly, and unnamed returns are
taken only when exactly one banked payout fits. A partial return is not a thing that happens,
and unwinding a settlement on an approximate match would be worse than escalating.

---

## D-047 · 2026-08-17 · The event log is written beside the ledger, not instead of it

**Decision.** An append-only `events` table records every domain happening, written **in the
same database transaction** as the state change that causes it. `replay` folds it from event
zero and asserts the projections match; `rebuildBalancesFromEvents` discards the balance
cache and rebuilds it from the fold. The ledger remains the write path.

**Why this deviates from the doctrine, deliberately.** The bible says the log becomes the
true system of record and the ledger becomes a projection folded from it. Taken literally
that inverts Phase 1 and moves Law 1 out of the database: today an unbalanced transaction is
refused by a deferred constraint trigger at `COMMIT`, which a rogue script, a migration, or a
second service cannot walk past. Under a log-first design the primary write is an event
insert and "balanced" becomes something application code promises. For a financial ledger
that trades a database-enforced invariant for an application-enforced one, which is strictly
worse — and the whole reason the Laws live in Postgres rather than in TypeScript.

**What is gained instead.** Everything the doctrine actually wanted: one ordered narrative
from genesis, replayable, with the balances rebuildable from it. And one thing a log-first
design cannot have. When the log is the only writer, replaying it can only reproduce itself —
the fold agrees with the projection because the projection came from the fold, and a bug in
the writer is invisible. Here the entries and the log are written by different code in the
same transaction, so agreement is *evidence*: two bugs would have to agree exactly to escape
notice. `replay` therefore checks three independent records — the entries, the balance cache,
and the log — and reports which pair disagrees, which localises a fault rather than merely
announcing one.

**Cost accepted.** Every booking now carries its entries twice, in two shapes. That is real
duplication, and it is the price of the cross-check being meaningful.

**On what must not drift.** A transaction posted with no event is invisible to the fold, so
the fold notices: the entry-level check catches exactly that, and there is a test for it. The
same discipline applies to any booking function added later.

---

## D-048 · 2026-08-17 · The log opens with a genesis event

**Decision.** Migration `0006` writes one `LedgerOpened` event carrying the per-account
position as it stood at adoption, and one `ExceptionRaised` per exception open at that
moment. On a fresh database neither is written.

**Why.** A log that begins today cannot explain a ledger that began last year. Every
transaction written before the migration exists in `entries` and nowhere in `events`, so a
replay would fold to zero and report every account as drifted — correctly, and uselessly. An
opening balance is what any other set of books does with the same problem, and saying "this
is where the narrative starts, and here is what was already true" is more honest than a tool
that only works on databases with no history.

**Cost accepted.** The first event is not derived from anything the log itself contains, so
the period before adoption is attested rather than reconstructed. That is unavoidable and is
stated in the event's own `detail` rather than left for somebody to infer.

---

# Phase 6 — the service, and the rails that reach it

## D-049 · 2026-08-18 · The product database is not a fourth record

**Decision.** Three rails enter this system and the company's own user/order database is
none of them. A webhook is the PSP's assertion that a customer paid; a settlement report is
the PSP's assertion that a payout is coming; a bank statement is our own bank's assertion
that cash arrived. The product database contributes exactly one thing — the stable mapping
between an internal payment id, the PSP's reference and the merchant — and it travels as
`reference` and `merchantId` on records we already hold. No customer, order, email, phone or
subscription row is copied here.

**Why.** Two reasons, and the first is about correctness rather than privacy.

A reconciliation is an argument between records produced by *different* parties about the
same money. The product database did not touch the money: it recorded an intention before
the payment and knows nothing about what settled. Admitting it as a fourth record would add
a fourth opinion held by the one participant with no independent knowledge — and every
disagreement it produced would be a disagreement about our own bookkeeping, dressed as a
reconciliation finding. The reference is enough to answer "which order was this?", which is
the only question the product side can actually answer.

The second is that a system whose whole job is proving money movement should hold as little
else as possible. `evidence.raw` already stores whole settlement exports and bank statements;
adding a PII mirror beside it multiplies the consequences of one leak and the scope of every
retention question, in exchange for a join the application can already do on a reference.

**Consequence, stated plainly.** "Customer A bought Service X" is a question for the product
database, answered by joining on the reference this system stores. "Did we get paid, when,
how much, less what, and can you prove it" is this system's question, and it is answerable
here without a single customer record.

---

## D-050 · 2026-08-18 · A webhook is accepted durably, and understood afterwards

**Decision.** `POST /webhooks/:source` verifies the signature over the raw bytes, writes one
row to `webhook_inbox`, and answers 200. A worker — `drain` in the new `@recon/inbox`
package — claims deliveries with `FOR UPDATE SKIP LOCKED`, one database transaction per
delivery, normalises them through `@recon/ingest` and posts through `@recon/ledger-core`. The
delivery id is the SHA-256 of the source and the bytes.

**Why.** The promise being made to a provider is *"we safely received this event"*, and it is
a different promise from *"we completed every downstream financial operation before
replying"*. Only the first can be kept in a couple of milliseconds, and only the first stays
true when the matcher is busy, a balance row is locked, or a settlement file is being parsed.
Conflating them means any of those makes a provider believe a payment was never delivered —
so it redelivers, and a queue that was merely slow becomes a queue that is growing.

At a thousand deliveries a second the arithmetic stops being an opinion: 86 million events a
day, and the response path must be one insert or it is not a response path. But the argument
does not depend on the volume. At ten deliveries a minute, a webhook handler that books,
matches and notifies before replying still loses a payment every time the ledger is briefly
unreachable, and loses it silently, because the provider's retries eventually stop.

**Why content-addressed.** The idempotency key of the *event* is inside the payload, and
reading it means parsing bytes a stranger chose, before we have decided the delivery is worth
parsing. The hash of the bytes needs no parser, is computable by anyone holding the same
delivery, and makes a redelivery collide on the primary key. The event's own key still does
its work one layer down: the ledger transaction id *is* that key (D-014), so a provider that
resends the same event with different bytes produces two inbox rows and one transaction. Two
independent refusals, neither of which anybody has to remember.

**Why a throw means retry.** `ignored` and `rejected` are terminal — a provider event we have
no use for, or a payload our parser cannot read — because retrying either produces the same
answer every hour for three days. A handler that *throws* is saying something else: not "this
delivery is wrong" but "I could not do my job just now". That is the only retryable case,
capped at `maxAttempts`, after which the delivery is `failed` and a person looks. A poison
payload retried forever is an infinite loop with a log file.

**Cost accepted.** One table that is deliberately mutable, in a system whose discipline is
append-only. `state`, `attempts` and `last_error` are updated as a delivery is worked, so
`webhook_inbox` carries no append-only trigger — the same exemption `account_balances` has,
for the same reason: a queue that cannot be updated is not a queue. The evidence half of the
row is never written after the insert, and the financial record stays append-only where it
belongs, in `entries`.

**Also accepted.** A payment is now visible in the books a fraction of a second after the
webhook rather than during it. That window is bounded by the drain interval, is visible in
`/health` as the pending depth, and is the price of the delivery never being lost.

---

## D-051 · 2026-08-18 · The upload rails parse inside the request, and that is a different decision

**Decision.** `POST /ingest/settlement/:source` and `POST /ingest/bank` take the file as raw
bytes, parse it, and store the evidence and the normalised rows before answering. They do not
enqueue, and they do not reconcile — matching is `POST /reconcile/runs`.

**Why not the inbox treatment.** The webhook rail is asynchronous because of *who is
waiting*: a remote system on a retry timer that will resend if we are slow. Nobody is on that
timer here. Whoever posts the file — an operator today, a scheduled fetcher when one is
written — can wait for the work the upload actually implies, and making them wait produces
something
better in return: the response says how many payouts and lines were stored, how many were
duplicates, and which rows were refused and why. An accepted-and-queued upload answers with a
receipt and moves the same information into a log nobody reads.

**Why the parse is safe to run in a request.** It is row-isolated: a bad row is rejected and
reported, not thrown, so a five-thousand-row export with three broken lines stores 4,997. And
the evidence id is the SHA-256 of the bytes, so re-uploading after any failure is free and
idempotent by construction. The bound is a body limit, not a promise about parser speed.

**When this changes, and why the contract does not.** Statements run to hundreds of
megabytes; past that the parse belongs behind a worker reading the stored bytes. The response
already carries only the evidence id and counts, so moving the work does not change what a
client sees — it changes when the counts are final. That is a deployment decision the evidence
table already supports, not a redesign.

**On the ordering that does matter.** Uploading is not reconciling. A statement landing at
04:00 and three PSP reports arriving through the morning are reconciled once, at 09:00,
against each other — not three times, each against whatever had turned up so far. Keeping the
rails separate from the matcher is what makes that possible.

---

## D-052 · 2026-08-18 · Two rails of authenticity: a signature for the PSP, a key for the operator

**Decision.** Webhook endpoints authenticate by the provider's signature over the raw bytes
and by nothing else. Every management endpoint requires a static `X-API-Key`, compared in
constant time. The service refuses to start without one.

**Why the asymmetry.** A PSP holds no credential of ours and never will — asking one to
present an API key means either handing our management credential to four external companies
or maintaining four more secrets to no benefit. What it does hold is a shared signing secret,
and a signature over the exact bytes proves both origin and integrity, which is strictly more
than a bearer token proves. Conversely, an operator's request has no payload anybody signed,
so a key is what there is.

**Why the raw bytes are load-bearing.** A signature is computed over bytes. `JSON.parse`
followed by re-serialising produces different ones — reordered keys, different whitespace,
different unicode escaping — so a JSON body parser anywhere upstream of the verification
rejects perfectly valid payloads and, worse, does so intermittently. Fastify scopes content
type parsers to the plugin that declares them, so the webhook and upload plugins replace the
parser with one that keeps the `Buffer` while the management routes go on receiving parsed
JSON.

**Why the process refuses to start without a key.** A service that quietly serves balances,
accepts statement uploads and books resolutions because an environment variable was missing
is a worse failure than one that does not come up, and it is the failure nobody notices.

**Cost accepted.** One static key cannot tell two operators apart, so evidence records the
uploader as a *claim* (`X-Recon-Operator`) rather than as a verified identity, and says so.
Real identities are one hook and one column away; pretending we have them today would put a
name on an audit record that nothing checked.

---

## D-053 · 2026-08-18 · What a thousand deliveries a second actually requires, and which half of it is built

**Decision.** The parts of high-volume operation that are *architecture* are built now; the
parts that are *capacity* are named here and deliberately deferred until there is traffic to
measure.

**Built, because they are structural and cannot be retrofitted honestly.** Durable acceptance
separated from interpretation (D-050). Idempotency at every entry point, keyed by content or
by the event's own id, so retries and redeliveries are free. Claim-and-work with `SKIP
LOCKED`, so adding a worker is starting a process and requires no coordination, partitioning
or leader election. Stateless request handling — every route reads its state from Postgres, so
the service scales by replica count. A bounded reconciliation run, because subset-sum batching
over an unbounded set of open promises is how a matcher stops returning.

**Named and deferred, because they are tuning against a workload nobody has measured.**
Time-based partitioning of `entries`, `events` and `webhook_inbox`. Indexes shaped to the
queries a real dashboard turns out to run. Connection-pool sizing and a pooler in front of
Postgres. Load tests with realistic duplicate, delayed and out-of-order traffic — which is
Phase 8's subject and belongs there.

**The one warning worth writing down.** `account_balances` holds one row per account, and
every posting updates it. At high write rates that row is a lock hotspot: `bank_account` would
serialise every settlement booking in the system. The escape route is already built rather
than merely available — the balance table is a **projection**, Law 6 checks it against the
entries, and `rebuildBalancesFromEvents` discards and rebuilds it from the log (D-047). So the
fix, when it is needed, is to stop updating it synchronously and rebuild it on a schedule, and
nothing about the ledger changes: the append-only entries remain the financial truth and the
cache remains a convenience that can be thrown away.

**Why deferring is not a stopgap.** The AGENTS rule forbids a design meant to be replaced, not
a design with headroom. Every deferred item above is a change to *one* thing — a table's
storage, an index, a pool size, when a projection is refreshed — and none of them touches a
Law, a canonical type, or an interface between packages. Building them now would mean tuning
against imagined traffic, which is how systems acquire complexity that survives long after the
guess is disproved.

---

## D-054 · 2026-08-18 · Two things nearly leaked into the API, and where they went instead

**Decision.** `summarize()` lives in `@recon/reconciler`, not in a route. `resolveException()`
— the decision, its compensating entry, and the closing of the queue item, in one database
transaction — lives there too. The API layer keeps only the mapping from HTTP to those calls,
the serialisation of the answers, and the mapping from a domain refusal to a status code.

**Why the summary.** A period summary is "matched / explained / exceptions", and which bucket
a reason code falls into is `reasonKind` in `canon` (D-036). Writing that grouping as a `CASE`
in a route's SQL would create a second copy of the taxonomy that could disagree with the first
— and the copy in the route is the one nobody would think to update.

**Why resolving is one call.** Resolving is genuinely three writes. Sequencing them in an HTTP
handler would put the atomicity of a financial correction in the transport layer, where a
thrown error between the second and the third leaves an entry posted whose justification never
saved, or a queue item closed pointing at a resolution that does not exist. Both look,
afterwards, exactly like money moved for no reason.

**What the API does own, and it is not nothing.** That `bigint` crosses as a decimal string
and never as a JSON number (Law 3 at the boundary — a JSON number is a double). That
`UnknownSourceError` is 404, `NoSettlementAdapterError` is 501, and every "the engine refused
this on the merits" is 422 carrying the engine's own message, because "422 Unprocessable
Entity" teaches an operator nothing and "this booking would need a ₦4,200 plug to balance"
teaches them the rule. That an unmapped error is a 500 and a log line rather than a stack
trace on the wire.

**The test that this held.** Every handler is three lines — parse, call one package function,
serialise. If a status code here ever needs a condition on an account or a source, a Law has
begun leaking upward.

---

## D-055 · 2026-08-18 · The policy join is a package, because two deployables now need it

**Decision.** `buildPolicy` moved from `apps/pipeline/src/policy.ts` to a new `@recon/policy`
package, imported by both deployables. It is the only package that imports both `ingest` and
`reconciler`.

**Why it exists at all.** The matcher needs a business calendar and a fee model per source.
The calendar is declared by ingest beside the adapter that knows the rail; the contracts are
administered data in the database. The reconciler may import neither — the moment it can reach
a source table it can branch on a source name (Law 7), and that missing edge is load-bearing.
So something has to join them, and the joiner is allowed to import both precisely because it
decides nothing: it fetches, it joins, it hands over a lookup.

**Why it stopped being a file in an app.** It was correct as one while the CLI was the only
deployable. Two copies of the join that decides how long to wait before calling money late is
two copies that can disagree — the API and the CLI reconciling the same database to different
answers, which is a Law 5 failure with no single line of code that is wrong.

**Cost accepted.** A package for one function, and a package whose dependency shape — imports
everything, imported only by apps — is otherwise the signature of an app. That shape is stated
in its README so the next reader does not mistake it for a mistake.

---

## D-056 · 2026-08-18 · The service migrates on boot, under an advisory lock

**Decision.** `apps/api` runs the migrations at startup, holding
`pg_advisory_lock(776155301)` while it does.

**Why on boot.** Phase 7's exit criterion is that a fresh machine with a container runtime
brings the whole system up with one command. A service that starts, finds a schema it does not
recognise and fails is not that, and a separate migration step somebody must remember is the
same problem with more documentation.

**Why the lock.** Two replicas starting together would both find migration `0007` unapplied
and both try to create the table; one would crash-loop on a duplicate-object error at exactly
the moment you are deploying. The checksum runner makes an *edited* migration a loud error
(D-023) but says nothing about two processes racing on an unapplied one. An advisory lock is
held on a connection and released when it closes, so a replica that dies mid-migration does not
wedge the next one.

**Cost accepted.** Boot is serialised across replicas by however long the slowest migration
takes. That is paid once per deploy, and the alternative — a deployment step whose omission is
discovered by a running service — is paid at the worst possible moment.

---

## D-057 · 2026-08-18 · Bank evidence arrives as an uploaded statement, and a feed is an adapter behind the same boundary

**Decision.** The only bank rail built is `POST /ingest/bank`, taking a statement export as
bytes. No direct corporate-bank integration and no open-banking aggregator is wired in. When
one is, it goes behind exactly the boundary the upload uses today: bytes or records in, an
`Evidence` record with a hash and a parser version out, canonical `BankStatementLine`s
after that, and nothing downstream learning where they came from.

**Why upload first.** It is the capability that works at every Nigerian bank on the first
day, needs no consent flow, no vendor and no per-bank certification, and it produces the
same canonical records a feed would. Nigeria has an open-banking standard and a regulatory
framework, but coverage, freshness and field completeness are integration-specific facts
about a particular bank and a particular provider — and they are facts you learn by trying,
not by reading. Building the feed first would mean discovering, in production, that a
statement we already know how to parse would have answered the question sooner.

**What a feed must model, and why it is not free.** An aggregator does not return "the
transactions"; it returns transactions *and a data-availability state* — Mono, for example,
reports states such as `PARTIAL` and `UNAVAILABLE`. A reconciler handed a partial day and
told nothing would conclude that money we were paid never arrived, raise
`MISSING_SETTLEMENT` against payouts that are perfectly fine, and — worse — would let
`clearVanished` close real exceptions because the credits explaining them were simply not in
the window it was given (D-044). So the adapter must carry the state through as data, and
a run over incomplete evidence must be *scoped* rather than treated as a run over
everything. That is a real piece of design, and it is the reason this is a decision rather
than a to-do.

**Consequence for the merchant model.** In a multi-merchant deployment it is each merchant's
own finance admin who links their corporate account, once. The paying customers never do,
and never see it — their bank is the PSP's problem, not ours. Nothing about the three-record
model changes: the account being read is *our* account, which is what makes its statement
the only evidence that may book cash (D-027).

**Cost accepted.** Somebody exports a statement and uploads it, daily. It is idempotent by
content address, so a double upload is free and a re-upload after a parser fix is free too —
but it is a human step, and it is the step a feed removes.
