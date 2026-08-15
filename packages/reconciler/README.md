# @recon/reconciler — Phases 3 and 4 (not yet built)

**The engine that explains the difference.** Where the promise meets the money. It takes
authorized ledger transactions and ingested `SettlementLine`s and partitions them into
matched, explained, and unexplained. This is the intellectual core.

**Depends on:** `@recon/canon`, `@recon/ledger-core`.
**Imported by:** `apps/api`, which triggers reconciliation runs.

Pure domain logic. Deterministic. No HTTP, no clock — `asOf` is always passed in, so a run
can be replayed and produce the identical partition (Law 5).

## The tiered matcher (Phase 3)

Cheapest and most confident first. Each tier emits `MatchResult`s carrying a confidence and
a reason code.

| Tier | Match on | Reason code |
|---|---|---|
| 1 | Same reference, amounts agree | `EXACT_MATCH` |
| 2 | `ourGross − expectedFee(ourGross) == theirNet` | `FEE_ADJUSTED_MATCH` |
| 3 | Bounded subset-sum: which combination of unmatched transactions sums to this line, within tolerance and time window | `BATCH_MATCH` |
| 4 | Still unmatched but inside its settlement window — deferred, not failed | `PENDING_T_PLUS_N` |

**Every confirmed match writes a new ledger transaction** through `@recon/ledger-core`,
moving value from `psp_receivable` to `bank_account` and booking the fee. Reconciliation
feeds the ledger; they are one system, not two.

## The exception state machine (Phase 4)

```
pending_settlement  →  overdue  →  exception  →  resolved
   (within window)   (past window)  (no explanation)
```

Only `exception` items reach a human, and each arrives with full context: the promise, the
expected money, the window it missed, and the candidate explanations the matcher considered
and rejected.

**Exit criteria.** Phase 3: a ledger plus a settlement file with deliberate fees and a
batched multi-transaction payout auto-matches through tiers 1–3, books the settlement and
fee transactions correctly, and leaves only the genuinely unexplainable — the same way every
run. Phase 4: a T+1 straggler sits as `pending_settlement` and auto-clears when its file
arrives, while a `PHANTOM_CREDIT` lands in the exception queue immediately with full
diagnostic context.

See the bible, [Phase 3](../../docs/RECONCILIATION-BIBLE.md#phase-3--the-reconciliation-engine-the-matching-pipeline)
and [Phase 4](../../docs/RECONCILIATION-BIBLE.md#phase-4--exceptions-lifecycle-and-settlement-windows).
