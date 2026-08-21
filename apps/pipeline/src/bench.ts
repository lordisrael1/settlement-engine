import { performance } from 'node:perf_hooks';

import { INBOX_MIGRATIONS_DIR } from '@recon/inbox';
import { ingestBankStatement, ingestSettlement } from '@recon/ingest';
import {
  LEDGER_MIGRATIONS_DIR,
  createPool,
  postTransaction,
  runMigrations,
} from '@recon/ledger-core';
import {
  DEFAULT_SUBSET_LIMITS,
  RECONCILER_MIGRATIONS_DIR,
  uniqueSubsetSummingTo,
} from '@recon/reconciler';
import { random } from '@recon/simulator';

/**
 * What this system does under load, measured rather than asserted.
 *
 * The test suite proves the engine is *correct*: balanced books, a matcher that refuses to
 * guess, a replay that reaches the same balances. None of that says what happens at ten
 * thousand payouts a day, and a system whose entire pitch is correctness under adversarial
 * input should not have to answer that question with an opinion.
 *
 * Three things are measured, and only things that are actually run:
 *
 *   `subset`   the matcher's tier-3 engine, characterised against its own bounds. This is
 *              the one that matters most, because its limits are not a performance
 *              question but a *coverage* one — past a certain batch size the engine stops
 *              being able to answer at all, and what it does then is the whole story.
 *   `ingest`   parsing, which is the only stage that sees a whole file at once.
 *   `ledger`   posting, which is the only stage that writes.
 *
 * Every number this prints comes from the real code path — `ingestSettlement`,
 * `postTransaction`, `uniqueSubsetSummingTo` — never a reimplementation. A benchmark of a
 * copy of the thing measures the copy.
 *
 * Deterministic, like everything else here: the same seed produces the same workload, so a
 * number that moves is a change in the system rather than a change in the dice.
 */

export type Benchmark = 'subset' | 'ingest' | 'ledger';

export const BENCHMARKS: readonly Benchmark[] = ['subset', 'ingest', 'ledger'];

export interface BenchOptions {
  readonly seed: number;
  /** Repetitions per data point. More is steadier and slower. */
  readonly samples: number;
  /** Where to write, so this file never owns a `console`. */
  readonly line: (text: string) => void;
  /** Absent means the ledger benchmark is skipped rather than faked. */
  readonly databaseUrl?: string | undefined;
}

// ── The clock ───────────────────────────────────────────────────────────────

/**
 * Milliseconds for one call, reported as median and p95 rather than as a mean.
 *
 * A mean over a run that includes one garbage collection describes a run that never
 * happened. The median says what a typical call costs and the p95 says what the unlucky one
 * costs, and for a system that processes a file of five thousand rows the second number is
 * the one that decides whether a request times out.
 */
function timed(samples: number, work: () => void): { median: number; p95: number } {
  const timings: number[] = [];
  for (let i = 0; i < samples; i += 1) {
    const started = performance.now();
    work();
    timings.push(performance.now() - started);
  }
  timings.sort((a, b) => a - b);
  return {
    median: timings[Math.floor(timings.length / 2)] ?? 0,
    p95: timings[Math.min(timings.length - 1, Math.floor(timings.length * 0.95))] ?? 0,
  };
}

const rate = (count: number, ms: number): string =>
  ms <= 0 ? '—' : `${Math.round(count / (ms / 1000)).toLocaleString('en-US')}/s`;

const ms = (value: number): string => `${value.toFixed(2)}ms`;

// ── 1. The matcher's tier-3 engine ──────────────────────────────────────────

/**
 * How many promises a payout may batch before the engine stops being able to say.
 *
 * The honest framing of this benchmark is not "how fast is subset-sum" — it is bounded, so
 * it is fast by construction. The question is what those bounds *cost in answers*, and the
 * answer is discontinuous rather than gradual.
 *
 * `uniqueSubsetSummingTo` takes `items.slice(0, maxCandidates)`. Past twenty-four candidates
 * the rest of the pool is not searched slowly — it is not searched at all, so a batch whose
 * members sit beyond that cut returns `none`. `none` escalates to a human, which is the safe
 * failure and emphatically not a wrong one. But it means the ceiling is a limit on what can
 * be matched automatically, and a deployment where payouts routinely batch thirty charges
 * would find tier 3 quietly contributing nothing while the exception queue fills.
 *
 * So this measures both: the time, and the share of batches the engine can still identify.
 */
function benchSubset(options: BenchOptions): void {
  const { line, samples } = options;

  line('');
  line('  Tier-3 batch matching (subset-sum), by candidate pool size');
  line(`  limits: maxCandidates=${DEFAULT_SUBSET_LIMITS.maxCandidates} ` +
       `maxSubsetSize=${DEFAULT_SUBSET_LIMITS.maxSubsetSize} ` +
       `maxSteps=${DEFAULT_SUBSET_LIMITS.maxSteps.toLocaleString('en-US')}`);
  line('');
  line('    pool  batch     median      p95    solved   outcome when not solved');
  line('    ────  ─────  ─────────  ───────  ────────  ─────────────────────────');

  for (const poolSize of [12, 24, 40, 80]) {
    for (const batchSize of [3, 8, 12]) {
      let solved = 0;
      let none = 0;
      let undecidable = 0;
      let sample = 0;

      const timings = timed(samples, () => {
        // A different draw every sample. Seeding this once per data point rather than once
        // per sample would run the identical arrangement two hundred times and report a
        // coin-flip as a percentage — the share below would only ever read 0% or 100%.
        const dice = random(options.seed + poolSize * 100_000 + batchSize * 1_000 + sample);
        sample += 1;
        const pool = Array.from({ length: poolSize }, (_, i) => ({
          id: i,
          // Amounts spread widely enough that collisions are possible but not the norm —
          // which is the realistic case. A pool of identical amounts is trivially
          // undecidable and a pool of wildly distinct ones is trivially solvable, and
          // neither describes a day's payments.
          kobo: BigInt(dice.int(50_000, 5_000_000)),
        }));

        const batch = pool.slice(0, batchSize);
        const target = batch.reduce((sum, item) => sum + item.kobo, 0n);

        // Shuffled, because arrival order is not the order a payout batches in, and a
        // benchmark that always puts the answer in the first N slots measures nothing.
        const shuffled = [...pool];
        for (let i = shuffled.length - 1; i > 0; i -= 1) {
          const j = dice.int(0, i);
          [shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!];
        }

        const outcome = uniqueSubsetSummingTo(shuffled, (item) => item.kobo, target);
        if (outcome.kind === 'unique') solved += 1;
        else if (outcome.kind === 'none') none += 1;
        else undecidable += 1;
      });

      const share = ((solved / samples) * 100).toFixed(0);
      const detail =
        solved === samples
          ? ''
          : `${((none / samples) * 100).toFixed(0)}% none, ` +
            `${((undecidable / samples) * 100).toFixed(0)}% ambiguous`;

      line(
        `    ${String(poolSize).padStart(4)}  ${String(batchSize).padStart(5)}  ` +
          `${ms(timings.median).padStart(9)}  ${ms(timings.p95).padStart(7)}  ` +
          `${(share + '%').padStart(8)}  ${detail}`,
      );
    }
  }

  line('');
  line('  Reading this: past 24 candidates the pool is truncated, not searched slowly, so');
  line('  a batch whose members fall outside the cut returns `none` and escalates. The');
  line('  engine never guesses — but tier 3 stops contributing, and the queue absorbs it.');
}

// ── 2. Parsing ──────────────────────────────────────────────────────────────

/** A Flutterwave settlements envelope with `count` payouts, as bytes. */
function settlementBytes(count: number, seed: number): Buffer {
  const dice = random(seed);
  const data = Array.from({ length: count }, (_, i) => {
    const gross = dice.int(50_000, 5_000_000);
    const fee = Math.round(gross * 0.014);
    return {
      id: `stm_bench_${i}`,
      gross_amount: gross / 100,
      net_amount: (gross - fee - 5000) / 100,
      currency: 'NGN',
      status: 'completed',
      due_datetime: '2026-08-14T09:00:00.000Z',
      transaction_datetime: '2026-08-13T14:22:10.000Z',
      fees: [
        { type: 'stamp_duty', amount: 50 },
        { type: 'charge_fee', amount: fee / 100 },
      ],
      charge_count: '3',
    };
  });
  return Buffer.from(JSON.stringify({ status: 'success', message: 'ok', data }), 'utf8');
}

/** A canonical bank statement with `count` rows, as bytes. */
function statementBytes(count: number, seed: number): Buffer {
  const dice = random(seed);
  let balance = 0;
  const rows = Array.from({ length: count }, (_, i) => {
    const amount = dice.int(50_000, 5_000_000);
    balance += amount;
    return {
      id: `GTB-BENCH-${i}`,
      date: '2026-08-14T11:20:00Z',
      amount: (amount / 100).toFixed(2),
      type: 'credit',
      narration: `TRF/FLUTTERWAVE SETTLEMENT stm_bench_${i}/NGN`,
      balance: (balance / 100).toFixed(2),
    };
  });
  return Buffer.from(JSON.stringify(rows), 'utf8');
}

function benchIngest(options: BenchOptions): void {
  const { line, samples } = options;

  const context = {
    merchantId: 'bench',
    filename: 'bench.json',
    receivedFrom: 'bench',
    receivedAt: new Date('2026-08-15T10:00:00Z'),
  };

  line('');
  line('  Parsing, end to end through the real ingest boundary');
  line('  (signature-adjacent work excluded; card-data scan and evidence hashing included)');
  line('');
  line('       rows       bytes     median      p95        throughput');
  line('    ───────  ──────────  ─────────  ───────  ────────────────');

  for (const rows of [100, 1_000, 10_000]) {
    const psp = settlementBytes(rows, options.seed);
    const timings = timed(Math.max(3, Math.floor(samples / 10)), () => {
      ingestSettlement('flutterwave', psp, context);
    });
    line(
      `    ${String(rows).padStart(7)}  ${(psp.byteLength / 1024).toFixed(0).padStart(7)} KiB  ` +
        `${ms(timings.median).padStart(9)}  ${ms(timings.p95).padStart(7)}  ` +
        `${rate(rows, timings.median).padStart(16)}  psp settlement`,
    );
  }

  for (const rows of [100, 1_000, 10_000]) {
    const bank = statementBytes(rows, options.seed);
    const timings = timed(Math.max(3, Math.floor(samples / 10)), () => {
      ingestBankStatement(bank, {
        bankAccountId: 'bench-account',
        bank: 'gtbank',
        filename: 'bench.json',
        receivedFrom: 'bench',
        receivedAt: context.receivedAt,
      });
    });
    line(
      `    ${String(rows).padStart(7)}  ${(bank.byteLength / 1024).toFixed(0).padStart(7)} KiB  ` +
        `${ms(timings.median).padStart(9)}  ${ms(timings.p95).padStart(7)}  ` +
        `${rate(rows, timings.median).padStart(16)}  bank statement`,
    );
  }
}

// ── 3. Writing ──────────────────────────────────────────────────────────────

/**
 * Ledger posting against a real Postgres, including the triggers.
 *
 * The triggers are the point. This system enforces balance-zero and append-only *in the
 * database* rather than in application code (ADR-0015), which is the right call and is not
 * free — every insert runs a constraint the application could have skipped. Measuring
 * posting without them would measure a system nobody runs.
 */
async function benchLedger(options: BenchOptions): Promise<void> {
  const { line, databaseUrl } = options;

  line('');
  line('  Ledger posting, against Postgres with the invariant triggers live');

  if (!databaseUrl) {
    line('');
    line('    skipped — set DATABASE_URL to measure this.');
    return;
  }

  const schema = `bench_${Date.now().toString(36)}`;
  const bootstrap = createPool(databaseUrl);
  await bootstrap.query(`CREATE SCHEMA ${schema}`);
  await bootstrap.end();

  const url = new URL(databaseUrl);
  url.searchParams.set('options', `-c search_path=${schema}`);
  const pool = createPool(url.toString());

  try {
    // The same three directories the service migrates, in the same order. Migrating only
    // the ledger's own would build a schema no deployment ever has.
    await runMigrations(pool, [
      LEDGER_MIGRATIONS_DIR,
      RECONCILER_MIGRATIONS_DIR,
      INBOX_MIGRATIONS_DIR,
    ]);

    line('');
    line('       txns       total       per txn        throughput');
    line('    ───────  ──────────  ────────────  ────────────────');

    for (const count of [100, 1_000]) {
      const at = new Date('2026-08-15T10:00:00Z');
      const started = performance.now();

      for (let i = 0; i < count; i += 1) {
        await postTransaction(pool, {
          transactionId: `bench:${schema}:${count}:${i}`,
          source: 'bench',
          reference: `bench-${i}`,
          occurredAt: at,
          recordedAt: at,
          initialState: 'authorized',
          entries: [
            { accountId: 'psp_receivable', amount: { kobo: 100_000n, currency: 'NGN' } },
            { accountId: 'merchant_revenue', amount: { kobo: -100_000n, currency: 'NGN' } },
          ],
        });
      }

      const total = performance.now() - started;
      line(
        `    ${String(count).padStart(7)}  ${ms(total).padStart(10)}  ` +
          `${ms(total / count).padStart(12)}  ${rate(count, total).padStart(16)}`,
      );
    }

    line('');
    line('  One round trip per transaction, no batching and no pipelining. This is the');
    line('  floor, not the ceiling: it is what a single sequential writer achieves.');
  } finally {
    await pool.end();
    const cleanup = createPool(databaseUrl);
    await cleanup.query(`DROP SCHEMA ${schema} CASCADE`);
    await cleanup.end();
  }
}

// ── The entry point ─────────────────────────────────────────────────────────

export async function runBenchmarks(
  which: readonly Benchmark[],
  options: BenchOptions,
): Promise<void> {
  const { line } = options;

  line('');
  line('  ── Performance ────────────────────────────────────────────────────────');
  line(`  node ${process.version} · seed ${options.seed} · ${options.samples} samples`);

  if (which.includes('subset')) benchSubset(options);
  if (which.includes('ingest')) benchIngest(options);
  if (which.includes('ledger')) await benchLedger(options);

  line('');
}
