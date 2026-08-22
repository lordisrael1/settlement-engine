# Performance

Measured, not estimated. Every number here is produced by `npm run bench` against the real
code paths — `ingestSettlement`, `postTransaction`, `uniqueSubsetSummingTo` — and can be
reproduced with the command shown beside it.

```bash
npm run build
node apps/pipeline/dist/main.js bench                    # all three
node apps/pipeline/dist/main.js bench subset --samples=300
DATABASE_URL=postgres://recon:recon@localhost:5432/recon \
  node apps/pipeline/dist/main.js bench ledger
```

The workload is a function of `--seed`, so a number that moves is a change in the system
rather than a change in the dice.

**Environment for the figures below:** Node v22.17.1, Windows 11, Postgres 16 in Docker
Desktop. The parsing numbers are CPU-bound and should travel. The ledger numbers are
round-trip-bound and are the pessimistic case — Docker Desktop's network path is slower than
a Linux host talking to a local socket, so treat ~110 txn/s as a floor rather than a
characteristic.

---

## The short answer

**Throughput is not the constraint.** A day of 10,000 payouts is roughly three minutes of
sequential ledger writing and under a second of parsing. Nothing here needs to get faster to
handle a mid-sized Nigerian merchant.

**Coverage is the constraint**, and it lives in one place: tier-3 batch matching. Past about
24 candidate promises or about 8 promises per batch, subset-sum stops being able to identify
the batch. It never guesses — it escalates — but it stops contributing, and the exception
queue absorbs the difference. That is the number worth knowing before deploying this, and it
is discussed in full below.

---

## 1. Tier-3 batch matching

The matcher's third tier answers "which promises does this payout cover?" when the PSP does
not say. It is bounded on purpose (`DEFAULT_SUBSET_LIMITS`: `maxCandidates=24`,
`maxSubsetSize=12`, `maxSteps=200,000`), because subset-sum is exponential and a settlement
file is attacker-adjacent input.

The interesting question is not how fast it is — it is bounded, so it is fast. The question
is what those bounds cost in *answers*.

`node apps/pipeline/dist/main.js bench subset --samples=300`

| pool | batch | median | p95 | solved | when not solved |
|-----:|------:|-------:|----:|-------:|-----------------|
| 12 | 3 | 0.03ms | 0.12ms | **100%** | |
| 12 | 8 | 0.03ms | 0.07ms | **100%** | |
| 12 | 12 | 0.01ms | 0.01ms | **100%** | |
| 24 | 3 | 0.55ms | 3.96ms | **96%** | 4% ambiguous |
| 24 | 8 | 5.54ms | 6.20ms | 1% | 99% ambiguous |
| 24 | 12 | 6.11ms | 9.67ms | 0% | 100% ambiguous |
| 40 | 3 | 0.56ms | 5.38ms | 19% | 76% none, 5% ambiguous |
| 40 | 8 | 5.70ms | 7.27ms | 0% | 2% none, 98% ambiguous |
| 40 | 12 | 6.29ms | 7.93ms | 0% | 1% none, 99% ambiguous |
| 80 | 3 | 0.56ms | 5.52ms | 3% | 90% none, 7% ambiguous |
| 80 | 8 | 7.19ms | 9.71ms | 0% | 1% none, 99% ambiguous |
| 80 | 12 | 6.20ms | 8.94ms | 0% | 4% none, 96% ambiguous |

Two different failures hide behind those zeros, and they have different cures.

**Truncation → `none`.** `uniqueSubsetSummingTo` takes `items.slice(0, maxCandidates)`. Past
24 candidates the rest of the pool is not searched slowly, it is *not searched*, so a batch
whose members fall outside the cut cannot be found. This is the `none` column, and it grows
with pool size: 76% at 40 candidates, 90% at 80.

**Ambiguity → `undecidable`.** With 24 candidates there are 735,471 possible 8-subsets, and
coincidental sums are common. More than one combination hits the target, so the engine
refuses to pick. This is the `ambiguous` column, and it grows with *batch* size regardless of
pool: 99% at 8 per batch even when the pool is only 24.

Both escalate to a human. Neither ever produces a wrong match — which is the design working
exactly as intended, since a wrong batch match silently moves the wrong promises to `settled`
and costs a week of not knowing. But the practical reading is:

> Tier 3 earns its place for **small batches from small pools**. It is close to fully
> effective at ≤12 candidates, still good for pairs and triples at 24, and contributes
> essentially nothing beyond that.

### What this means at volume

The candidate pool is filtered only by the settlement window before the search
(`solveAgainst` in `match.ts` calls `withinReach`, then hands the survivors to
`uniqueSubsetSummingTo`). For a merchant taking 10,000 payments a day on a T+2 rail, the
promises open inside that window number in the tens of thousands — far past 24.

**What happens past the bound changed, and it matters more than the number.** The search used
to `.slice()` the pool down to 24 and search the prefix — so the 24 that got searched were
simply the first 24 the store returned, in no particular relation to the payout being solved,
and a truncated search that found nothing reported `none`. `none` is the answer that produces
`PHANTOM_CREDIT`: a queue entry asserting that no combination of your promises adds up to this
payout, with `amount_differs` beside each near-miss. Every word of that was a claim about
arithmetic nobody performed.

The search now **refuses rather than truncates**. A pool larger than `maxCandidates` returns
`not_attempted`, which the matcher escalates as `BATCH_TOO_LARGE` with every candidate marked
`not_attempted` (ADR-0070). The queue entry says "we did not look", which is a different
sentence from "we looked and nothing fitted" and sends a person somewhere different.

So at volume, on the sources that do not name their payouts (Nomba, Monnify), tier 3 should be
expected to *decline* rather than match. Tiers 1 and 2 — reference match and payout match —
are unaffected, and they are what carries Flutterwave, which reports the payout explicitly.

The bound is now configuration: `RECON_SUBSET_MAX_CANDIDATES`, `RECON_SUBSET_MAX_SIZE`,
`RECON_SUBSET_MAX_STEPS`. Raising the first without the third buys `undecidable` rather than
answers, because `maxSteps` is what actually stops the search — and the ambiguity column above
is the reason raising it at all mostly produces more ambiguity.

The honest framing: **this is a reconciliation core whose automatic batch-matching is
calibrated for small-batch reality.** Raising the ceiling is not a matter of a bigger
constant — the ambiguity column shows that searching more candidates would mostly produce
more ambiguity, not more answers. It needs a narrower candidate set (ordering by amount
proximity, restricting by channel or merchant) before a larger bound would help.

---

## 2. Parsing

The only stage that sees a whole file at once. Includes the card-data scan and the SHA-256
evidence hash; excludes signature verification, which is per-delivery rather than per-file.

`node apps/pipeline/dist/main.js bench ingest --samples=100`

| rows | bytes | median | p95 | throughput | |
|-----:|------:|-------:|----:|-----------:|---|
| 100 | 29 KiB | 6.28ms | 14.96ms | 15,912/s | PSP settlement |
| 1,000 | 291 KiB | 22.09ms | 33.92ms | 45,270/s | PSP settlement |
| 10,000 | 2,920 KiB | 213.54ms | 246.02ms | 46,829/s | PSP settlement |
| 100 | 16 KiB | 0.71ms | 1.88ms | 140,390/s | bank statement |
| 1,000 | 167 KiB | 6.66ms | 8.35ms | 150,101/s | bank statement |
| 10,000 | 1,700 KiB | 80.18ms | 105.54ms | 124,718/s | bank statement |

Linear in rows, as it should be. The PSP path is ~3× slower per row than the bank path
because each payout carries an itemised fee array that is walked and classified.

A 10,000-row settlement export parses in about a fifth of a second, well inside the
`RECON_UPLOAD_BYTES` limit of 32 MB and nowhere near a request timeout. Upload rails parse
synchronously (ADR-0051) and this is why that is affordable.

---

## 3. Ledger posting

The only stage that writes. Runs against real Postgres with the invariant triggers live —
balance-zero is enforced by a deferred constraint trigger (ADR-0015), so every insert pays
for a check the application could have skipped. Measuring without them would measure a system
nobody runs.

`DATABASE_URL=… node apps/pipeline/dist/main.js bench ledger`

| txns | total | per txn | throughput |
|-----:|------:|--------:|-----------:|
| 100 | 898.75ms | 8.99ms | 111/s |
| 1,000 | 9,078.98ms | 9.08ms | 110/s |

Flat per-transaction cost from 100 to 1,000, so nothing degrades with table size at this
scale. One round trip per transaction, no batching and no pipelining — a single sequential
writer, which is the floor rather than the ceiling.

### The 10,000-payouts-a-day question

Two ledger transactions per payment (ADR-0004), so 10,000 payouts is ~20,000 posts:

| stage | cost |
|---|---|
| Parse the settlement export (10k rows) | 0.21s |
| Parse the bank statement (10k rows) | 0.08s |
| Post 20,000 ledger transactions | ~182s |
| **Total** | **~3 minutes** |

Three minutes of a single-threaded sequential writer on the slowest available database path.
There is a lot of headroom, and the obvious lever — batching or pipelining the posts — has not
been needed and so has not been built (ADR-0053).

---

## What is not measured

Stated so the gaps are not mistaken for claims.

- **No end-to-end reconcile-run benchmark.** The stages are measured individually; a full
  `reconcile` over a large seeded corpus is not, because building a realistic corpus at that
  size is itself a piece of work.
- **No concurrency.** Every number is one writer, one reader, one process. Nothing here says
  what happens with eight workers competing for the same rows — and there is a known
  structural answer waiting to be measured: every booking for a merchant contends on the
  `psp_receivable` row of `account_balances`, so `FOR UPDATE SKIP LOCKED` lets workers claim
  different inbox rows in parallel and then serialises them on that one upsert. Adding workers
  should stop raising throughput at that point. Lock *ordering* is no longer a factor —
  `postTransaction` sorts its per-account upserts, which removes the deadlock class entirely
  (ADR-0073) — so what remains is contention, which costs latency rather than failed
  transactions. Fixing it is per-account sharding or dropping the cache to a
  periodically-materialised view, and both are deferred until there is traffic to measure
  (ADR-0053).
- **No sustained-load or memory profile.** These are short runs, not soak tests, and say
  nothing about behaviour over hours.
- **Bank-format conversion is out of scope entirely** — per-bank CSV to the canonical
  statement shape happens upstream of this system, so its cost is not represented here. Note
  that ingest now checks two clauses of that hand-off (unique ids, ISO-8601 dates), which adds
  a `Set` insert per row and one primary-key lookup per *conflicting* row in
  `recordBankLines`. Re-ingesting an unchanged five-thousand-row file therefore costs five
  thousand extra index lookups and reports nothing; that is the price of being able to tell a
  redelivery from a collision, and a collision is a credit that would otherwise have
  disappeared (ADR-0068).
