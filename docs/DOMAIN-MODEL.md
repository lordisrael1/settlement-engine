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
