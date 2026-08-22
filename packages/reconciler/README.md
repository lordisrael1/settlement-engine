# @recon/reconciler

The matching engine. Three records arrive from three directions — a webhook says a customer
paid, a settlement report says a payout is coming, a bank statement says cash landed — and
this decides which of them concern the same money, names every difference, and writes the
ledger transaction that closes each one.

**Depends on:** `@recon/canon`, `@recon/ledger-core`, `@recon/protect`.
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

**And it distinguishes "nothing fitted" from "we did not look."** The subset search is bounded
at 24 candidates by default, which is a *small-batch* bound — a busy merchant's payout
routinely covers 50–500 charges. It used to truncate the pool and search the prefix, so a
payout too large came back as `PHANTOM_CREDIT`: an assertion that no combination of your
promises adds up, with `amount_differs` beside near-misses nothing had compared. It now refuses,
and the finding is `BATCH_TOO_LARGE` with every candidate marked `not_attempted`
([ADR-0070](../../docs/adr/0070-arithmetic-matching-is-a-small-batch-feature.md)).

**One narrowing, and it is narrow.** Where several credits and the same number of inflows all
carry one amount and none is named, the *set* has a single pairing up to ordering — and since
every member carries the same amount, each booking's entries are identical whichever way it
falls. Without it a fixed-price business escalates two visually obvious credits every day and
the queue's depth tracks transaction volume
([ADR-0072](../../docs/adr/0072-same-amount-credits-are-paired-as-a-set.md)).

## It never learns which source it is looking at

Everything per-source arrives as a `SourcePolicy`: a business calendar, a dated fee model, a
bank-charge allowance. There is no source name here to branch on. `@recon/policy` joins
`@recon/ingest`'s calendars to the contracts in the database and hands over a lookup.

## Storage

| Table | Holds |
|---|---|
| `evidence` | every file, content-addressed by SHA-256, with uploader, parser version and storage locator. **The bytes are not here.** |
| `evidence_blobs` | those bytes, encrypted per record, versioned `original` or `redacted`, with an expiry |
| `evidence_access` | who read which document, when, why, and under whose approval |
| `evidence_exports` | copies taken out of the system, sealed under a key we do not keep |
| `fee_contracts` | rate cards scoped by merchant, source, channel and currency, non-overlapping within a scope by exclusion constraint |
| `payouts` | what each provider says it is sending, with itemised deductions |
| `settlement_lines` | individual settled payments, for sources that list them |
| `bank_statement_lines` | the only evidence that can book cash |
| `expected_inflows` | reported and not yet confirmed |
| `inflow_allocations` | how much of each payment an inflow discharges, and its apportioned share of the deductions |
| `matches` | every conclusion, what it booked, and the fee contract that explained it |
| `reserve_holds`, `reserve_releases` | what a PSP withheld, when it is due back, and what has come back. The position is a view over the two, never a decremented column |
| `bank_attestations` | a named person compared our books to the bank's own portal, and what each said |
| `exception_events` | the append-only exception lifecycle; current state is a view |
| `resolutions` | appended human decisions, with identity, approver, value and any compensating transaction |

All append-only except the last three. `evidence_blobs` is mutable by design, for the same
reason `account_balances` is: a table that cannot be updated cannot expire, and **append-only
and "delete this on a schedule" are opposite requirements** that no single table satisfies.
Splitting them is what makes retention runnable at all — ADR-0033 described a path the
append-only trigger had always refused
([ADR-0065](../../docs/adr/0065-evidence-retention-schedule.md)).

Five invariants live in the database rather than in code: a payment can never be allocated
beyond its receivable, one bank credit can confirm at most one inflow, nobody approves their
own resolution, an original export cannot be recorded without a second named approver, and a
purged blob cannot hold ciphertext.

## Evidence has a body, an expiry and a visitors' book

    recordEvidence      seals the bytes; there is no unencrypted path to forget
    readEvidenceBytes   decrypts through the key ring, or says the bytes are gone
    recordAccess        who looked, and why — the gap every other control here leaves open
    runRetention        redact, then purge; a dry run unless asked twice
    issueExport         maker-checked for originals, sealed under a key nobody stores

`runRetention` is driven by `pipeline evidence-retention`, not by a thread inside the
service: a deletion of financial evidence should be something somebody scheduled, with an
output somebody reads. Every destruction appends an `EvidencePurged` event in the same
transaction, so it is part of the same narrative as everything else that happened to the
money.

## The exception queue

    pending_settlement  ->  overdue  ->  exception  ->  resolved
      within calendar     past deadline   no explanation
                          plus grace

Only `exception` items reach a person, each with the promise, the expected money, the
deadline missed, the evidence file, and the candidates the matcher rejected. Items
deduplicate across runs by a derived key and close themselves when evidence arrives
([ADR-0043](../../docs/adr/0043-exceptions-are-entities.md),
[ADR-0044](../../docs/adr/0044-the-queue-clears-itself.md)).

Self-clearing has two limits, because the mechanism that keeps the queue small is also the one
that could silently empty it
([ADR-0075](../../docs/adr/0075-clearing-is-bounded-by-what-the-run-saw.md)):

**A run clears only within the window it loaded.** Every loader stops at `limit`. Past that
bound nothing is compared, so nothing is concluded, so the subject is absent from the findings
— and absence used to mean resolved. A run now reports how far it saw, and `queue.withheld`
counts what it declined to close.

**A run never closes what a person has taken.** Only `open` items clear automatically; an
`acknowledged` one is somebody's current work.

## Reserves, and the one finding that comes from the books

A rolling reserve is an asset — the PSP holds our money rather than keeping it — and an asset
with no deadline is unfalsifiable: a source returning reserves on schedule and one returning
none produce identical balances, identical matches and an identical empty queue. So a
withholding becomes a dated obligation in the same transaction as the booking that withheld
it, a `reserve_release` clears it oldest-first, and one past its date is raised as
`RESERVE_UNRELEASED` through the ordinary queue machinery — which means it also clears itself
when the money finally comes back
([ADR-0071](../../docs/adr/0071-reserves-carry-a-deadline.md)).

## The trust boundary

Cash books from an uploaded file and nothing here proves the file came from the bank.
`bankPosition` compares our `bank_account` to the running balance on the last statement line
ingested — free, automatic, and no evidence of provenance whatsoever, since a fabricated file
carries a fabricated running balance. `attestBankBalance` records a named person comparing
against the bank's own portal, append-only. Neither is a fix; the second is the honest control
until an open-banking feed exists
([ADR-0068](../../docs/adr/0068-the-bank-file-is-the-trust-boundary.md)).
