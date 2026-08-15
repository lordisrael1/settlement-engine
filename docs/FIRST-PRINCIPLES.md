# First Principles

*Why the design is what it is, derived from scratch. Read [RECONCILIATION-BIBLE.md](RECONCILIATION-BIBLE.md)
for what the system must be; read this for why.*

---

## What money-tracking really is

Strip away the software. A ledger exists to answer one question at any moment: **how much
value does each party hold, and how did it get there?** Every other feature is in service
of answering that question correctly and provably.

The naive way to track balances is a single number you increment and decrement:
`balance += 500`. This is how beginners build wallets, and it is catastrophically wrong
for money. The moment you have a bug, a race condition, or a dispute, you have a number
with no explanation. You cannot answer "why is this ₦3,200 here?" You cannot reconstruct
the past. You cannot detect that you are wrong, because there is nothing to check against.

So the first principle is: **a balance should never be stored as a fact. It should be a
derived consequence of an immutable history of events.** The balance is a view; the events
are the truth. This one idea is the foundation of everything below.

## Double-entry, derived from a conservation law

Double-entry bookkeeping is 500 years old and survives because it encodes a physical
intuition: **money is conserved.** It does not appear or vanish — it moves. If ₦500 left a
customer's card, it did not evaporate; it arrived somewhere (the PSP's settlement account,
minus a fee that arrived in the PSP's revenue account).

From that conservation law, the entire system falls out:

Every economic event is recorded as a set of entries against accounts, where **the sum of
all entries in the event is exactly zero.** Money debited from one place must be credited
to another. If an event does not sum to zero, you have claimed money appeared from
nowhere — which is definitionally a bug.

### The sign convention

We use signed integers, in kobo, where the sum across every line of a single transaction
is zero:

- **Positive (+) is a debit.** Value flowing *into* this account.
- **Negative (−) is a credit.** Value flowing *out of* this account.

Each account type has a **natural sign** — the direction it normally moves:

| Type | Natural sign | Accounts |
|---|---|---|
| Asset | `+1` (debit-natural) | `psp_receivable`, `bank_account`, `suspense` |
| Income | `−1` (credit-natural) | `merchant_revenue` |
| Expense | `+1` (debit-natural) | `fees_expense` |
| Contra-income | `+1` (debit-natural) | `reversals`, `chargebacks` |

Contra-income accounts are debit-natural precisely *because* they reduce income: a reversal
moves value back out of revenue, so it debits a contra account rather than editing the
original credit.

### A payment, end to end

A customer pays ₦10,000 through Paystack, who takes a 1.5% fee (₦150), settling ₦9,850 the
next day. This is **two transactions**, not one, because two things happen at two different
times — and the gap between them is the entire reason this system exists.

**T+0, the promise.** The webhook arrives in seconds. We know the customer paid ₦10,000 and
that Paystack now owes us. We do *not* yet know the exact fee — a rate card can change, a
cap can apply — so we book none of it.

```
Transaction PSK_abc123  (state: authorized)
  psp_receivable      +1_000_000 kobo   (debit: Paystack owes us ₦10,000)
  merchant_revenue    -1_000_000 kobo   (credit: we earned ₦10,000)
  ────────────────────────────────────
  SUM                          0   ✓
```

**T+1, the money.** The settlement file arrives. Now — and only now — the real fee is known,
and reconciliation books it.

```
Transaction PSK_abc123/settlement  (state: settled)
  bank_account          +985_000 kobo   (debit: real cash landed)
  fees_expense           +15_000 kobo   (debit: the fee cost us ₦150)
  psp_receivable      -1_000_000 kobo   (credit: the debt is discharged)
  ────────────────────────────────────
  SUM                          0   ✓
```

Read across the two: revenue is ₦10,000 (what the customer actually paid), the fee is a
₦150 expense (a real cost, debited like every other cost), the receivable opens at gross
and closes to zero, and ₦9,850 of cash exists. Every account ends where reality says it
should, and `psp_receivable` at any instant equals *exactly the money promised but not yet
paid* — which is the single most useful number in the business.

> **Note on the doctrine's worked example.** Part I of the bible sketches this as one
> transaction with `fees_expense −150`. That sums to zero but books the fee as a *credit*
> to an expense account and understates revenue to net. The two-transaction model above is
> what Phase 3 actually describes ("moving value from `psp_receivable` to `bank_account`
> and booking the fee") and is what the code implements. See
> [DECISIONS.md § D-004](DECISIONS.md).

The `SUM = 0` check is not bureaucracy. It is a runtime assertion that we have not lost
track of money. If any code path tries to write a transaction that does not balance, we
reject it. This single invariant catches an enormous class of bugs before they corrupt the
books.

### Two consequences that follow immediately

**You never delete entries.** If you made a mistake, you do not edit the past — you write a
new, compensating transaction that reverses it. The history is append-only. This is what
"immutable ledger" means and why it matters: an auditor (or you, at 2am during an incident)
must be able to replay every event from the beginning of time and arrive at exactly today's
balance. If entries can be edited, that guarantee is gone.

**Balances are computed, and may be cached but never trusted as primary.**
`balance(account) = SUM(all entries for that account)`. For performance you keep a running
total, but you must be able to recompute it from scratch and get the same number. If the
cached balance and the recomputed balance ever disagree, the cache is corrupt and the
entries win. This recompute-and-compare is itself a form of internal reconciliation —
the system reconciling against itself, continuously.

## What reconciliation is, from first principles

Here is the crux. **Reconciliation is what you do when two independent parties each keep
their own record of the same reality, and you need to prove the records agree — and find
out precisely where they do not.**

Our ledger says: *"Between Monday and Tuesday, 412 payments totalling ₦4.1m came in through
Paystack."* Paystack's settlement file says: *"We are paying you ₦4.05m for 409
transactions."*

These will not match, and the mismatches are **not always errors**. They encode real events
you did not otherwise know about:

- 3 transactions were reversed or refunded after you recorded them.
- Fees were slightly different from what you computed — a rate changed, or a cap applied.
- One transaction is in a T+1 settlement window: it happened Tuesday but settles Wednesday,
  so it is in your books but not yet in their file.
- A chargeback clawed back money from last week, appearing as a negative line now.
- FX or rounding differences on international cards.
- **A transaction exists in their file that you have no record of at all** — possibly fraud,
  possibly a webhook you dropped.

Reconciliation is the algorithm that takes two sets of records and partitions them into:

1. **Matched** — both sides agree.
2. **Explained mismatches** — they differ, but for a known reason (a fee, a reversal, a
   pending window).
3. **Unexplained exceptions** — the scary bucket: money that appears on one side and not
   the other with no explanation.

**The entire commercial value is in shrinking bucket 3 automatically**, so a human only
ever looks at a genuine anomaly.

## The matching problem is real algorithm design

This is where it stops being CRUD. You have two lists — internal ledger transactions and
external settlement lines — and you must pair them up. The hard part: they do not share a
clean common key, and it is not one-to-one.

The matching pipeline runs in **tiers, cheapest and most confident first**:

**Tier 1 — Exact reference match.** If both sides carry the same reference and the amounts
agree, match with high confidence. This clears 90%+ in the easy case.

**Tier 2 — Match with expected transformation.** Their amount = your amount − expected fee.
So you do not match on raw amount; you match on
`ourGross − feeModel(ourGross) == theirNet`. A "mismatch" in raw numbers becomes a match
once you model the fee. Getting `feeModel()` right for each PSP's rate card — percentage,
cap, flat component, international surcharge — is a large share of the real-world value.

**Tier 3 — Fuzzy / many-to-one matching.** Sometimes one settlement line is a batch of
several of your transactions, or references are mangled. Now you are solving a small
subset-sum / assignment problem: which combination of my unmatched transactions sums to
this one settlement amount, within a tolerance and a time window? This is genuinely
interesting algorithmically — bounded subset-sum, or bipartite matching with a cost
function.

**Tier 4 — Timing-aware deferral.** A transaction unmatched today is not necessarily an
error — it may settle tomorrow. So unmatched items carry a state and an age. Only after
they exceed the expected settlement window (T+1, T+2) do they escalate from
`pending_settlement` to `exception`.

**Everything a match discovers becomes a new ledger transaction.** When you confirm a
settlement, you write the transaction that moves money from `psp_receivable` to
`bank_account` and books the fee. Reconciliation and the ledger are not two systems —
**reconciliation feeds the ledger.** That is the elegant part, and it is why they share one
canonical language and one write path.

## Why these technology choices

**TypeScript / Node.** This is an I/O-and-correctness problem, not a raw-compute problem.
The stack is already in use for `pay-normalize`, and the type system is strong enough to
make the canonical language enforceable at compile time.

**PostgreSQL for the ledger.** We need real ACID transactions and real constraints, because
Law 1 must be enforced *inside the same database transaction as the write* — otherwise a
concurrent writer can persist an unbalanced transaction between the check and the insert.
Constraint enforcement is the whole reason for the store.

**`BIGINT` kobo, `bigint` in TypeScript — never floats.** Float rounding on money is its own
category of catastrophic bug, and avoiding it is itself a first principle. `0.1 + 0.2` is
not `0.3`, and a system that cannot represent ₦0.01 exactly cannot ever prove its books
balance. Conversion from a source's representation happens exactly once, in ingest, and
never again.

**Event sourcing.** Model the domain as events — `PaymentAuthorized`, `SettlementIngested`,
`TransactionMatched`, `ExceptionRaised`, `ReversalBooked` — append them to a log, and derive
both the ledger and the reconciliation state as projections. This gives the replay/audit
property for free, and it is the honest expression of the very first principle: the history
is the truth, and every number is a consequence of it.

## The demo that lands

Feed the engine a messy, real-ish settlement file with deliberate reversals, a fee change,
a T+1 straggler, and one phantom transaction — and show it auto-clearing ~95%, booking every
fee and reversal correctly, and surfacing **exactly the one phantom line** for review, with
a full audit trail behind every number.
