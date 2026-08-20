# @recon/reconciler

The matching engine. Three records arrive from three directions — a webhook says a customer
paid, a settlement report says a payout is coming, a bank statement says cash landed — and
this decides which of them concern the same money, names every difference, and writes the
ledger transaction that closes each one.

**Depends on:** `@recon/canon`, `@recon/ledger-core`.
**Imported by:** `@recon/policy`, `apps/api`, `apps/pipeline`.

Pure domain logic, deterministic, no HTTP and no clock: `asOf` is always passed in, so a run
can be replayed to the identical partition.

## Two stages, because money moves in two steps

    allocate()   the settlement report meets the ledger      books NOTHING
    confirm()    the bank statement meets the report         books the cash

A matcher that skipped the distinction would treat a provider's description of its own
future behaviour as money in the bank. Every payout reported and never sent, returned two
days later, credited twice, or credited short of a correspondent-bank charge would be
invisible to it ([ADR-0027](../../docs/adr/0027-three-way-reconciliation.md)).

The conclusions each stage can reach are listed in
[docs/DOMAIN-MODEL.md](../../docs/DOMAIN-MODEL.md#matching).

**Only a confirmation books.** In one transaction: cash to `bank_account`, every named
deduction to its own account, and the receivable closed. A booking that would need a plug to
balance is refused ([ADR-0029](../../docs/adr/0029-named-deductions-and-no-plug-entries.md)).

## It escalates ambiguity

Four situations: a batch with two valid subsets; a credit fitting two open inflows equally
well; a reference naming two promises; a shortfall larger than a bank charge could plausibly
be. All escalate rather than resolving, because a wrong match does not fail loudly — it
settles the wrong records and leaves the right ones to escalate later as inexplicable
absences ([ADR-0035](../../docs/adr/0035-the-matcher-escalates-ambiguity.md)).

## It never learns which source it is looking at

Everything per-source arrives as a `SourcePolicy`: a business calendar, a dated fee model, a
bank-charge allowance. There is no source name here to branch on. `@recon/policy` joins
`@recon/ingest`'s calendars to the contracts in the database and hands over a lookup.

## Storage

| Table | Holds |
|---|---|
| `evidence` | every file, content-addressed by SHA-256, with uploader, parser version and storage locator |
| `fee_contracts` | rate cards scoped by merchant, source, channel and currency, non-overlapping within a scope by exclusion constraint |
| `payouts` | what each provider says it is sending, with itemised deductions |
| `settlement_lines` | individual settled payments, for sources that list them |
| `bank_statement_lines` | the only evidence that can book cash |
| `expected_inflows` | reported and not yet confirmed |
| `inflow_allocations` | how much of each payment an inflow discharges, and its apportioned share of the deductions |
| `matches` | every conclusion, what it booked, and the fee contract that explained it |
| `exception_events` | the append-only exception lifecycle; current state is a view |
| `resolutions` | appended human decisions, with identity, approver, value and any compensating transaction |

All append-only. Three invariants live in the database rather than in code: a payment can
never be allocated beyond its receivable, one bank credit can confirm at most one inflow,
and nobody approves their own resolution.

## The exception queue

    pending_settlement  ->  overdue  ->  exception  ->  resolved
      within calendar     past deadline   no explanation
                          plus grace

Only `exception` items reach a person, each with the promise, the expected money, the
deadline missed, the evidence file, and the candidates the matcher rejected. Items
deduplicate across runs by a derived key and close themselves when evidence arrives
([ADR-0043](../../docs/adr/0043-exceptions-are-entities.md),
[ADR-0044](../../docs/adr/0044-the-queue-clears-itself.md)).
