# 68. The bank file is the trust boundary: identity is a contract, and provenance is a human control

Date: 2026-08-22

## Status

Accepted — amends ADR-0057, and narrows the claim ADR-0027 makes about bank evidence

## Context

ADR-0027 rests the whole design on one asymmetry: a webhook is the customer's bank telling
the PSP, a settlement report is the PSP telling us, and both are claims by parties with an
interest in the answer — while the bank statement is our own bank telling us about our own
account, and is therefore the only document whose word is final. Nothing books cash without
one.

That is the right architecture. What it did not say is that the *word of the bank* and *a
file somebody uploaded* are not the same thing, and this system only ever had the second.

Three specific weaknesses followed, and they compound.

**Identity is delegated to a converter that does not exist in this repository.** ADR-0057
deliberately leaves the per-bank conversion outside the boundary: every Nigerian bank exports
a different CSV, several change it without notice, and one canonical shape with the variety
absorbed by whoever knows the bank is the correct anti-corruption discipline. But the
canonical shape requires a per-row `id`, and most Nigerian bank exports do not have one. So
in practice somebody synthesises it, and the obvious synthesis is a hash of date, amount and
narration.

The day two customers pay the same ₦5,000 subscription with the same generic narration, that
synthesis produces one id for two credits. The parser accepted both; `recordBankLines` wrote
the first and dropped the second on `ON CONFLICT DO NOTHING`, which is exactly the behaviour
that makes re-uploading a file safe. Nothing distinguishes the two cases at the database
level: a redelivery and a collision are both a conflicting insert.

The consequence is the quietest failure the system had. The dropped credit's payout escalates
as `MISSING_SETTLEMENT`; a person investigates a payout the PSP definitely sent; the cash is
sitting in the real bank account where nobody will look for it, because the line that carried
it was deduplicated away. Every other dependency in this engine is guarded. This one was both
load-bearing and entirely unguarded.

**Dates were parsed by `new Date()`, which guesses.** `new Date("02/01/2026")` is the 1st of
February in every JavaScript engine; a Nigerian export written DD/MM means the 2nd of January.
A converter bug of that shape produces no error at all — it produces credits dated a month
away from where they belong, which pushes them outside the matching window and manufactures
`UNIDENTIFIED_CREDIT`s, or misclassifies what is overdue. The converter is *supposed* to hand
over ISO-8601; accepting anything means a failure to do so is silent.

**Nothing proves the bytes came from the bank.** `POST /ingest/bank` is behind an API key, and
that is the whole of the control. Anyone holding an ingest key can fabricate a statement that
confirms inflows and moves `psp_receivable` into `bank_account`. There is no signature on the
file, no feed, and — because this system has no direct line to the bank — no independent
balance to diverge from.

`verify` does not catch this and cannot. It proves internal conservation: every transaction
balances, the entries sum to zero, the cache agrees with the entries. A fabricated statement
that balances passes all of it trivially. "The books are internally consistent" and "the books
match reality" are different claims, and only the first was ever enforced.

## Decision

**The bank identity contract is stated, and both halves of it are checked.**

`id` must be unique within the account, forever. `ingestBankStatement` refuses a second row
claiming an id an earlier row in the same file already used — as a `colliding-identity`
rejection, not a `malformed` one, because nothing about the row is malformed — and raises a
`colliding_identity` ingest anomaly, whose `detail` is the format so that a converter with a
broken scheme produces one queue entry rather than a page of them.

`recordBankLines` makes the same check across files. Every conflicting insert is now *looked
at*: if the stored row says the same thing in direction, amount, balance, value date and
narration, the file has been ingested before and nothing happened. If it says something else,
two distinct credits are wearing one id, the arriving row is **not stored**, and it is
returned as a `BankLineCollision` — raised into the exception queue as `BANK_LINE_COLLISION`,
severity 3, alongside the other findings that mean cash is unaccounted for.

The recommended collision-safe synthesis is documented where a converter author will read it:
include the running balance, or a within-file sequence number. `${date}:${seq}` is enough.

`date` must be ISO-8601 — a bare `YYYY-MM-DD` read as UTC midnight, or a full timestamp.
Anything else is rejected with a message that names the DD/MM trap, and flagged as drift on
the `date` field so a wholesale format change is one queue entry rather than a thousand
rejected rows.

**Provenance is acknowledged as a human control, and made into a record.**

Two endpoints, and neither pretends to be a fix:

`GET /bank/position` compares `bank_account`, summed from `entries`, to the running balance on
the last statement line ingested. This is a real check the system can make with no human at
all, and it catches the ordinary failure — a half-ingested statement, a rejected credit, a
debit nobody modelled. It proves nothing about provenance: a fabricated file carries a
fabricated running balance and agrees with itself perfectly.

`POST /bank/attestations` records that a named person opened the bank's own portal and
compared. Append-only, with the ledger balance recomputed from `entries` rather than taken
from the caller or the balance cache — an attestation against one of our own projections is a
weaker claim than the one being made. `attestedBy` is the authenticated principal, never a
name the caller supplied.

A difference is *expected* rather than alarming, and the response says so: the real account
holds movements this system does not model — supplier payments, salaries, standing orders. The
question is not whether the difference is zero but whether anybody can say what it consists
of, which is what the attestation's note is for.

`/health` raises `bank_unattested` when no attestation has been recorded within
`RECON_ALERT_ATTESTATION_AGE_MS` (a week by default), checked only once a statement has
actually been ingested — a database nobody has used has no books to compare, and alerting
about it teaches whoever set this up to ignore the alert on their first afternoon.

## Consequences

A converter with a colliding id scheme now fails loudly on its first collision instead of
losing money silently. The failure is a refused row and a severity-3 queue entry naming both
sides and what differs between them, which is a fifteen-minute fix to the converter rather
than a week of not knowing anything is wrong.

Re-ingesting an unchanged file costs one primary-key lookup per conflicting row and reports
nothing, so the common case is unaffected.

A converter that has been emitting non-ISO dates stops working, immediately and visibly. That
is the intent: it was already producing wrong answers, and a rejection is strictly better than
a credit booked into the wrong month.

The trust boundary is now stated in the README, in the API reference, on the endpoint itself,
and in an alert that fires when the control lapses. It is still a human control, and this
record does not claim otherwise. The open-banking feed on the roadmap is what replaces it, and
ADR-0057 already says that a feed is an adapter behind the same boundary — so the shape of
this system does not change when it arrives, only the trustworthiness of what arrives on it.

Nothing here prevents a determined insider holding an ingest key from fabricating a statement.
It makes the fabrication survivable-for-a-week rather than indefinite, and it means the
question "when did somebody last check the books against the bank?" has an answer that is not
a shrug.
