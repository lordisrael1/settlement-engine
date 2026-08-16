# @recon/reconciler — Phase 3 (built), Phase 4 (not yet)

**The engine that explains the difference.** Three records arrive from three directions —
a webhook says a customer paid, a PSP report says a payout is coming, a bank statement says
cash landed — and this decides which of them are about the same money, names every
difference between them, and writes the ledger transaction that closes each one.

**Depends on:** `@recon/canon`, `@recon/ledger-core`.
**Imported by:** `apps/pipeline` today, `apps/api` in Phase 6.

Pure domain logic. Deterministic. No HTTP, no clock — `asOf` is always passed in, so a run
can be replayed and produce the identical partition (Law 5).

## Two stages, because money moves in two steps

```
stage 2   allocate()   the PSP's report meets the ledger      → books NOTHING
stage 3   confirm()    the bank statement meets the report    → books the cash
```

A matcher that skipped the distinction would be asserting that a PSP's description of its
own future behaviour is money in the bank. Every payout that is reported and never sent,
returned two days later, credited twice, or credited short of a correspondent-bank charge
is invisible to such a system — and every one of those is a real Tuesday.

### Stage 2 — allocation

| Evidence | Conclusion |
|---|---|
| The PSP named the payout; the arithmetic confirms which payments it covers | `PAYOUT_MATCH` |
| Same reference on both sides, same gross | `EXACT_MATCH` |
| …but the fee is not what the contract predicted | `FEE_VARIANCE` |
| Same reference; a dated fee contract explains the whole difference | `FEE_ADJUSTED_MATCH` |
| No shared reference; exactly one combination of promises sums to the movement | `BATCH_MATCH` |
| Only part of a payment is covered | `PARTIAL_SETTLEMENT` |
| Nothing matched, but the business-day deadline has not passed | `PENDING_T_PLUS_N` |

### Stage 3 — bank confirmation

| Evidence | Conclusion |
|---|---|
| A credit whose narration carries the payout's own reference | `BANK_CONFIRMED` (1.0) |
| A credit whose amount and date fit exactly one open inflow | `BANK_CONFIRMED` (0.85) |
| …less a shortfall inside the source's bank-charge allowance | `BANK_CHARGE` (0.75) |
| Reported, and the bank has not seen it yet | `AWAITING_BANK_CREDIT` |
| A second credit for a payout already confirmed | `DUPLICATE_BANK_CREDIT` |
| A credit that identifies nothing and matches nothing | `UNIDENTIFIED_CREDIT` |

**Only a confirmation books.** In one transaction: cash to `bank_account`, every named
deduction to its own account, and the receivable closed.

## It refuses to guess

Four places, one shape. A batch with two valid subsets; a credit fitting two open inflows
equally well; a reference naming two promises; a shortfall larger than a bank charge could
plausibly be. All escalate.

A wrong match does not fail loudly — it silently settles the wrong records and leaves the
right ones to escalate later as inexplicable absences, long after anybody can reconstruct
what happened. Escalating costs a human five minutes. Guessing costs them a week of not
knowing anything is wrong.

## It never learns which source it is looking at

Everything per-source arrives as a `SourcePolicy`: a business calendar, a dated fee model,
a bank-charge allowance. There is no source name in here to branch on, so Law 7 is not a
rule anyone has to remember. The deployable joins `@recon/ingest`'s calendars to the
contracts in the database and hands over a lookup.

## What is stored

| Table | Holds |
|---|---|
| `evidence` | every file, content-addressed by SHA-256, with uploader, parser version and storage locator |
| `fee_contracts` | rate cards scoped by merchant, source, channel and currency, non-overlapping within a scope by exclusion constraint |
| `payouts` | what each PSP says it is sending, with itemised deductions |
| `settlement_lines` | individual settled payments, for sources that list them |
| `bank_statement_lines` | the only evidence that can book cash |
| `expected_inflows` | reported and not yet confirmed — neither matched nor missing |
| `inflow_allocations` | how much of each payment an inflow discharges, and its apportioned share of the deductions |
| `matches` | every conclusion, what it booked (usually nothing), and the fee contract that explained it |
| `resolutions` | appended human decisions, with identity, approver, value and any compensating transaction |

All append-only. Three invariants live in the database rather than in code: a payment can
never be allocated beyond its receivable, one bank credit can confirm at most one inflow,
and nobody approves their own resolution.

## The exception state machine (Phase 4)

```
pending_settlement  →  overdue  →  exception  →  resolved
  (within calendar)  (past deadline + grace)  (no explanation)
```

Only `exception` items reach a human, each with full context: the promise, the expected
money, the deadline it missed, the evidence file it came from, and the candidate
explanations the matcher considered and rejected.

**Exit criteria.** Phase 3 (met): a PSP report matched to payments books nothing; an
independent bank credit books the cash and every named deduction; a reported-but-uncredited
payout sits as `AWAITING_BANK_CREDIT`; duplicated, short and unidentifiable credits
escalate — the same way every run. Phase 4: a T+1 straggler sits as `pending_settlement`
and auto-clears, while a `PHANTOM_CREDIT` reaches the queue immediately.

See the bible, [Phase 3](../../docs/RECONCILIATION-BIBLE.md#phase-3--the-reconciliation-engine-the-matching-pipeline)
and [Phase 4](../../docs/RECONCILIATION-BIBLE.md#phase-4--exceptions-lifecycle-and-settlement-windows),
and [DECISIONS.md](../../docs/DECISIONS.md) § D-027 to § D-036.
