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
T+0  authorized      psp_receivable   +gross     merchant_revenue  -gross
T+1  settled         bank_account     +net       fees_expense      +fee     psp_receivable  -gross
```

Revenue is booked at **gross** — what the customer actually paid. The fee is a **debit** to
`fees_expense`, booked only when the settlement file reveals the real fee.

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
