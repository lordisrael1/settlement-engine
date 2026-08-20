# Domain model

## The problem

A payment produces two things at two different times. Information arrives in seconds, as a
webhook. Money arrives later — T+1 for card and provider-aggregated channels, near-instant
for direct NIP transfers and virtual-account credits. Reconciliation exists because of that
gap, and the lifecycle of every transaction is the story of it.

Three independent records describe the same money:

1. **The webhook** — the provider's assertion that a customer paid.
2. **The settlement report** — the provider's assertion that a payout is coming, less its
   own named deductions.
3. **The bank statement** — our own bank's assertion that cash arrived.

Only the third can increase `bank_account`. A settlement report is a party with an interest
in the answer describing its own future behaviour; booking cash on it hides four ordinary
events — a payout reported and never sent, one the bank returns, one credited short of a
correspondent-bank charge, and one credited twice. See
[ADR-0027](adr/0027-three-way-reconciliation.md).

## The ledger

A balance is never stored as a fact. It is derived by summing an immutable history of
entries, and may be cached only because the cache is checked against the recomputation.

Every economic event is a set of entries whose signed amounts sum to exactly zero. Amounts
are signed integers in kobo:

- **Positive is a debit** — value flowing into the account.
- **Negative is a credit** — value flowing out of it.

| Account type | Natural sign | Accounts |
|---|---|---|
| Asset | `+1` debit-natural | `psp_receivable`, `bank_account`, `psp_reserve`, `suspense` |
| Income | `-1` credit-natural | `merchant_revenue` |
| Expense | `+1` debit-natural | `fees_expense`, `taxes_withheld`, `penalties`, `bank_charges` |
| Contra-income | `+1` debit-natural | `reversals`, `chargebacks` |

Contra-income accounts are debit-natural because they reduce income: a reversal moves value
back out of revenue rather than editing the original credit.

## A payment, end to end

A customer pays 10,000 naira through a provider that charges 1.5% (150 naira) and settles the
next day. This is two transactions, because two things happen at two different times.

**T+0 — the promise.** The webhook arrives. The fee is not yet knowable, so none is booked.

    Transaction PSK_abc123                   state: authorized
      psp_receivable      +1_000_000 kobo    debit: the provider owes us
      merchant_revenue    -1_000_000 kobo    credit: we earned it
      ------------------------------------
      sum                          0

**T+1 — the report.** The settlement file arrives. It produces a `Payout` with named
deductions and allocations against the promises it covers. **It books nothing.**

**T+2 — the money.** An independent bank credit confirms the payout. Only now:

    Transaction PSK_abc123/settlement        state: settled
      bank_account          +985_000 kobo    debit: cash landed
      fees_expense           +15_000 kobo    debit: the fee cost us
      psp_receivable      -1_000_000 kobo    credit: the debt is discharged
      ------------------------------------
      sum                          0

Read across the two: revenue is what the customer paid, the fee is an expense, the receivable
opens and closes at gross, and `psp_receivable` at any instant is exactly the money promised
but not yet paid.

Mistakes are corrected by a new compensating transaction, never by an update or a delete.
See [ADR-0004](adr/0004-two-transactions-per-payment.md).

## Three legs, and the PSP appears twice

Reconciliation is an argument between records produced by different parties about the same
money. There are three, they arrive at different times, and two of them come from the party
that owes you the money.

                        ┌─ leg 1: webhook      "a customer paid"     T+0   a promise
       the PSP ─────────┤
                        └─ leg 2: settlement   "I'm sending ₦9,850"  T+1   a claim

       your bank ─────── leg 3: statement      "₦9,850 arrived"      T+2   the proof

Follow one ₦10,000 card payment through all three.

**T+0, the promise.** The PSP authorises the card and posts a webhook. The signature is
verified, the bytes are stored, and a worker books:

    debit  psp_receivable   ₦10,000     the PSP owes us this
    credit merchant_revenue ₦10,000

Revenue is earned and no cash exists anywhere.

**T+1, the claim.** The PSP aggregates the day, subtracts its fees, and initiates a bank
transfer. Its settlement report — gross ₦10,000, fee ₦150, net ₦9,850, payout reference
`stm_7QpLd2Rk9x` — reaches us as a dashboard export or from a settlements API on a cron;
either way it arrives at `POST /ingest/settlement/:source` as bytes. It creates `payouts`,
`settlement_lines` and `expected_inflows`, and **books nothing at all**.

Nothing, because it is a statement by the party that owes us money about money it has not
sent. Treating it as cash makes every payout reported-and-never-sent, sent-and-returned,
credited-twice, or credited-short-of-a-correspondent-charge invisible
([ADR-0027](adr/0027-three-way-reconciliation.md)).

**T+2, the proof.** The bank credits the account. Somebody exports the statement and posts it
to `POST /ingest/bank`. This creates `bank_statement_lines` and still books nothing by itself.

**The run.** `POST /reconcile/runs` allocates promises to the payout — booking nothing — and
then confirms the payout against the bank credit, which is the only step that books cash:

    debit  bank_account     ₦9,850
    debit  fees_expense       ₦150     apportioned pro rata across the batch
    credit psp_receivable  ₦10,000     closed

### What joins leg 2 to leg 3

There is no foreign key. The bank has never heard of a payout id. What arrives is a narration:

    "TRF/FLUTTERWAVE SETTLEMENT stm_7QpLd2Rk9x/NGN"
                                └──────────────┘
                                sometimes. sometimes truncated. sometimes absent.

So the matcher reasons from **three signals** — the tokens parsed out of the narration, the
amount, and the value date — and the narration rule is the one worth stating precisely: it is
parsed into *candidates* and never resolved to a reference at ingest time. The matcher does
the resolving, against payouts it actually holds, so a guess is never indistinguishable from a
reference the bank supplied ([ADR-0033](adr/0033-content-addressed-evidence.md)).

When the three signals point at one payout, that is `BANK_CONFIRMED`. When they point at two
equally well, that is an exception. There is deliberately no tie-break.

### The bank leg is bytes, not a bank integration

`POST /ingest/bank` takes a statement export as bytes, because a statement export works at
every Nigerian bank on the first day with no consent flow, vendor or per-bank certification.
A feed — open banking, a corporate API, MT940 — goes behind the same boundary later, and must
carry data-availability state as data: a reconciler handed a partial day and told nothing will
conclude that money we were paid never arrived
([ADR-0057](adr/0057-bank-evidence-arrives-as-an-upload.md)).

The canonical statement shape is one flat JSON array, and **amounts are decimal-string naira**
rather than kobo, because that is what every bank export actually contains. Conversion to
integer kobo happens exactly once, inside `packages/ingest`, with string and BigInt math and
never a float. Demanding kobo at the boundary would not remove the conversion — it would move
it out to whoever writes the per-bank converter, which is the least tested code in the
estate.

Converting a particular bank's CSV into that shape is deliberately outside this system. Every
Nigerian bank exports a different CSV and several change it without notice, so the per-bank
knowledge stays where per-bank knowledge belongs.

## Matching

Reconciliation partitions differences into three buckets: **matched**, **explained** and
**exception**. The value is in shrinking the third automatically, so a person only sees a
genuine anomaly. `REASON_KIND` in `canon` says which bucket a reason code belongs to.

### Stage one — allocation

The provider's report meets the ledger. Nothing is booked.

| Evidence | Conclusion |
|---|---|
| The provider named the payout, and the arithmetic confirms which payments it covers | `PAYOUT_MATCH` |
| Same reference on both sides, same gross | `EXACT_MATCH` |
| Same reference, but the fee is not what the contract predicted | `FEE_VARIANCE` |
| Same reference, and a dated fee contract explains the whole difference | `FEE_ADJUSTED_MATCH` |
| No shared reference, and exactly one combination of promises sums to the movement | `BATCH_MATCH` |
| Only part of a payment is covered | `PARTIAL_SETTLEMENT` |
| Nothing matched, and the business-day deadline has not passed | `PENDING_T_PLUS_N` |

### Stage two — bank confirmation

The bank statement meets the report. This is the only stage that books cash.

| Evidence | Conclusion |
|---|---|
| A credit whose narration carries the payout's own reference | `BANK_CONFIRMED` |
| A credit whose amount and date fit exactly one open inflow | `BANK_CONFIRMED`, lower confidence |
| The same, less a shortfall inside the source's bank-charge allowance | `BANK_CHARGE` |
| Reported, and the bank has not seen it yet | `AWAITING_BANK_CREDIT` |
| A second credit for a payout already confirmed | `DUPLICATE_BANK_CREDIT` |
| A debit matching a banked payout | `RETURNED_PAYOUT` |
| A credit that identifies nothing and matches nothing | `UNIDENTIFIED_CREDIT` |

A confirmation books in one transaction: cash to `bank_account`, every named deduction to its
own account, and the receivable closed. If the credit and the named deductions do not account
for the receivable exactly, the booking is refused rather than plugged
([ADR-0029](adr/0029-named-deductions-and-no-plug-entries.md)).

### The matcher does not guess

Four situations escalate instead of resolving: a batch with two valid subsets, a credit
fitting two open inflows equally well, a reference naming two promises, and a shortfall
larger than the source's bank-charge allowance. A wrong match does not fail loudly — it
settles the wrong records and leaves the right ones to escalate later as inexplicable
absences ([ADR-0035](adr/0035-the-matcher-escalates-ambiguity.md)).

## When many payments become one movement

A payout is usually one bank transfer covering many charges, so "which promises does this
₦2,000 cover?" is the ordinary case rather than an edge case. The answer is arithmetic:
`uniqueSubsetSummingTo` looks for **exactly one** combination of open promises that sums to
the movement, and the word *exactly* is the whole design.

Real outcomes, from the matcher itself:

| Open promises | Payout | Outcome |
|---|---|---|
| ₦1,000, ₦1,000 | ₦2,000 | `unique` — both, one allocation each |
| ₦1,000, ₦1,000 | ₦1,000 | **`undecidable`** — which one? |
| ₦1,000, ₦1,000, ₦500, ₦1,500 | ₦2,000 | **`undecidable`** — two subsets fit |
| ₦1,000.01, ₦1,000.02 | ₦2,000.03 | `unique` — both |
| ₦1,000.01, ₦1,000.02 | ₦1,000.01 | `unique` — the kobo tells them apart |
| ₦1,000, ₦2,000 | ₦5,000 | `none` — nothing fits |

The second row is the surprising one and the most instructive: two identical promises and a
payout covering one of them is genuinely ambiguous, because discharging the wrong receivable
leaves the right one open to escalate later as a mystery. Sub-naira digits are what usually
break the tie in real data, which is also why the simulator salts its generated amounts
([ADR-0059](adr/0059-kobo-salt-for-unambiguous-subsets.md)).

An `undecidable` result becomes an exception carrying the near-misses the matcher considered,
so the person resolving it does not have to rediscover them. Escalating an ambiguous payout
costs somebody five minutes; guessing costs them a week of not knowing anything is wrong.

The search is bounded — twenty-four candidates, twelve per subset, two hundred thousand steps
— because subset-sum is exponential and a settlement file is attacker-adjacent input. Running
out of budget escalates, which is the safe direction.

**The mirror case is not supported, on purpose.** One bank credit confirms at most one
expected inflow — a partial unique index in the database says so. A single ₦2,000 credit that
the bank merged from two separate ₦1,000 payouts matches neither by amount and becomes an
`UNIDENTIFIED_CREDIT` for a human, rather than being split across two payouts by inference.
Splitting a credit is a guess about the bank's behaviour, and this system does not make those
([ADR-0035](adr/0035-the-matcher-escalates-ambiguity.md)).

## Midday, end of day, or every five minutes

Reconciliation has no cadence of its own, and that is a deliberate property rather than an
omission. Three facts make the schedule an operational choice:

**A run is idempotent.** Running it twice concludes the same things and books nothing extra.
Every conclusion is keyed by an idempotency key that is the primary key, so a second run
collides rather than duplicates.

**Arrival order does not change the answer.** A statement exported before the report that
explains it reaches the same balances and the same queue as the other order
([ADR-0060](adr/0060-arrival-order-independence.md)).

**The queue clears itself.** Each run diffs its conclusions against what is currently open, so
an exception raised at midday because the settlement report had not arrived is closed by the
16:00 run that ingests it — with no human touching it
([ADR-0044](adr/0044-the-queue-clears-itself.md)).

So a midday run and an end-of-day run are the same operation over more evidence. What
separates "not here yet" from "late" is not the clock the run happens on but the source's
business calendar: a payout inside its settlement window is `PENDING_T_PLUS_N`, and only past
the deadline plus grace does it become an exception anybody is shown
([ADR-0031](adr/0031-business-day-deadlines.md)). Running more often surfaces money sooner and
never manufactures a false alarm.

A reasonable shape for a day:

    every 5 min    the inbox worker drains itself            automatic, no cron
    hourly         POST /reconcile/runs                       cheap, bounded, idempotent
    on arrival     POST /ingest/settlement/:source            when the PSP export lands
    daily          POST /ingest/bank                          after the statement export
    daily          pipeline replay                            read-only proof of the books
    weekly         pipeline evidence-retention --apply        destroys what is due

## Per-source data, never per-source branching

Sources differ in fees, settlement timing and file format. That variation travels as data,
attached to the source at the ingest boundary, and is handed to the matcher as a
`SourcePolicy`. There is no source name downstream of `packages/ingest` to branch on.

| Source | Webhooks | Settlement | Deadline | Rate card |
|---|---|---|---|---|
| `paystack` | yes | none — see [ADR-0025](adr/0025-no-paystack-settlement-adapter.md) | T+2 | 1.5% + 100 naira, waived below 2,500, capped at 2,000 |
| `flutterwave` | yes | settlements API v4 | T+2 | 1.4%, capped at 2,000 |
| `nomba` | yes | transaction records | T+1 | none — priced per merchant |
| `monnify` | yes | transaction records | T+1 | 1.5%, capped at 2,000 |

Fee expectations come from dated contracts scoped by merchant, source, channel and currency
([ADR-0030](adr/0030-versioned-fee-contracts.md),
[ADR-0037](adr/0037-fee-contract-scoping.md)). Deadlines come from a business calendar with a
named time zone, cut-offs, weekends and versioned holiday tables
([ADR-0031](adr/0031-business-day-deadlines.md),
[ADR-0038](adr/0038-time-zones-and-versioned-holiday-tables.md)).

## Exceptions

    pending_settlement  ->  overdue  ->  exception  ->  resolved
      within calendar     past deadline   no explanation
                          plus grace

Only `exception` items reach a person, each carrying the promise, the expected money, the
deadline it missed, the evidence file it came from, and the candidate explanations the
matcher rejected.

Exceptions are append-only events with a derived key of `(subject, subjectId, reason)`, so
the queue grows by the number of problems rather than the number of runs. Each run diffs its
findings against what is open and closes what it no longer finds, with the cause recorded —
`evidence_arrived` for a self-clearing item, `resolved_by_human` for a decision somebody
made. See [ADR-0043](adr/0043-exceptions-are-entities.md) and
[ADR-0044](adr/0044-the-queue-clears-itself.md).

A human resolution is appended, never applied: it is a named decision, maker-checked, posting
its own compensating entry in the same database transaction, and it may never touch
`bank_account` ([ADR-0042](adr/0042-maker-checker-on-resolutions.md)).

## Evidence and lineage

Every canonical record carries the SHA-256 of the file it came from and the row inside it.
The `evidence` table keeps the bytes, the uploader, the receipt time, the parser version and
a storage locator. Content-addressing makes re-uploading a file a no-op by construction. See
[ADR-0033](adr/0033-content-addressed-evidence.md) and
[ADR-0039](adr/0039-record-lineage-and-storage-locators.md).
