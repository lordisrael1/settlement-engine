import { readFile } from 'node:fs/promises';

import { format, money } from '@recon/canon';
import {
  ingestBankStatement,
  ingestSettlement,
  SOURCE_IDS,
  sourceProfile,
} from '@recon/ingest';
import {
  createPool,
  LEDGER_MIGRATIONS_DIR,
  rebuildBalancesFromEvents,
  replay,
  runMigrations,
} from '@recon/ledger-core';
import { buildPolicy } from '@recon/policy';
import {
  reconcile,
  recordBankLines,
  recordEvidence,
  recordPayouts,
  recordSettlementLines,
  RECONCILER_MIGRATIONS_DIR,
} from '@recon/reconciler';

import { runDemo } from './demo.js';
import { runSimulation } from './simulate.js';

/**
 * Whose books these are.
 *
 * Single-merchant today, and carried explicitly anyway: fee contracts are negotiated per
 * merchant, so the day a second one appears must not be the day every historical fee
 * becomes wrong.
 */
const MERCHANT = process.env['RECON_MERCHANT'] ?? 'default-merchant';
import {
  heading,
  line,
  printBalances,
  printQueue,
  printReconciliation,
  printVerification,
} from './report.js';

/**
 * Each package owns its own migrations and its own number range, so adding one to the
 * system is adding it to this list — there is no shared file everyone edits and nobody
 * reviews.
 */
const MIGRATIONS = [LEDGER_MIGRATIONS_DIR, RECONCILER_MIGRATIONS_DIR];

/**
 * The deployable.
 *
 * Everything under `packages/` is a library that cannot run on its own; this is the
 * process you start. It owns no business logic — it opens a connection, dispatches a
 * command, and prints. Every decision it appears to make is delegated to a package.
 *
 * `apps/api` serves the same libraries over HTTP. Neither deployable changes the packages,
 * which is the point of keeping them libraries.
 */
const COMMANDS = [
  'migrate',
  'demo',
  'simulate',
  'balances',
  'verify',
  'ingest-settlement',
  'ingest-bank',
  'reconcile',
  'exceptions',
  'replay',
] as const;
type Command = (typeof COMMANDS)[number];

async function main(argv: readonly string[]): Promise<number> {
  const command = (argv[0] ?? 'demo') as Command;
  if (!COMMANDS.includes(command)) {
    console.error(`Unknown command "${command}". Try one of: ${COMMANDS.join(', ')}`);
    return 2;
  }

  const pool = createPool();
  try {
    switch (command) {
      case 'migrate': {
        heading('Migrating');
        for (const migration of await runMigrations(pool, MIGRATIONS)) {
          line(`  ${migration.outcome.padEnd(15)} ${migration.name}`);
        }
        return 0;
      }

      case 'demo': {
        await runMigrations(pool, MIGRATIONS);
        heading('Record the fast promise, wait for the slow money');
        line('  The whole system, end to end, against a real Postgres.');
        line(`  Sources with an adapter: ${SOURCE_IDS.join(', ')}`);
        const ok = await runDemo(pool);
        line(ok ? '\x1b[32mAll invariants held.\x1b[0m' : '\x1b[31mAn invariant failed.\x1b[0m');
        return ok ? 0 : 1;
      }

      /**
       * The adversarial scenario, driven rather than asserted.
       *
       * Generates one messy settlement day from a seed, pushes every byte of it through the
       * real boundary in whatever order was asked for, and reports what a human is left
       * with. Exits non-zero if the books miss the arithmetic or the queue holds anything
       * beyond the single planted phantom — so it is a test you can watch.
       */
      case 'simulate': {
        const seed = Number(argv[1] ?? 1);
        if (!Number.isInteger(seed) || seed < 0) {
          console.error('usage: simulate [seed] [--reverse]');
          return 2;
        }
        // Migrates nothing here: this command opens a schema of its own and migrates that,
        // because the books it prints are only meaningful if nothing else wrote to them.
        return (await runSimulation(seed, argv.includes('--reverse'))) ? 0 : 1;
      }

      case 'balances': {
        heading('Balances');
        await printBalances(pool);
        return 0;
      }

      case 'verify': {
        heading('Verifying');
        return (await printVerification(pool)) ? 0 : 1;
      }

      case 'ingest-settlement': {
        const source = argv[1];
        const path = argv[2];
        if (!source || !path) {
          console.error('usage: ingest-settlement <source> <file>');
          console.error(
            `sources with a settlement adapter: ` +
              SOURCE_IDS.filter((id) => sourceProfile(id).settlement !== null).join(', '),
          );
          return 2;
        }

        const bytes = await readFile(path);
        const result = ingestSettlement(source, bytes, {
          merchantId: MERCHANT,
          filename: path,
          receivedFrom: process.env['RECON_OPERATOR'] ?? 'cli',
          receivedAt: new Date(),
        });

        heading(`Ingested ${path}`);
        line(`  format: ${result.format}`);
        line(`  evidence: ${result.evidence.evidenceId.slice(0, 16)}…  (${result.evidence.parserVersion})`);
        for (const payout of result.payouts) {
          line(
            `  ✓ payout ${payout.payoutReference.padEnd(16)} gross ${format(payout.gross).padStart(13)}` +
              `  expected net ${format(payout.expectedNet).padStart(13)}`,
          );
          for (const adjustment of payout.adjustments) {
            line(`      − ${adjustment.kind.padEnd(16)} ${format(adjustment.amount).padStart(12)}`);
          }
        }
        for (const settlementLine of result.lines) {
          line(
            `  ✓ line   ${settlementLine.reference.padEnd(16)} net ${format(settlementLine.net).padStart(13)}` +
              `  fee ${format(settlementLine.fee).padStart(10)}`,
          );
        }
        for (const rejected of result.rejected) {
          line(`  – ${rejected.kind}: ${rejected.reason}`);
        }

        // Storing the file and the records is what makes re-ingesting the same export a
        // no-op across restarts rather than only within one process (ADR-0020), and what
        // makes the conclusion reproducible from the bytes months later.
        await recordEvidence(pool, result.evidence, bytes);
        const payouts = await recordPayouts(pool, result.payouts);
        const lines = await recordSettlementLines(pool, result.lines);

        line();
        line(
          `  ${payouts.stored} payouts and ${lines.stored} lines stored; ` +
            `${payouts.duplicates + lines.duplicates} already seen; ` +
            `${result.rejected.length} rejected.`,
        );
        line('  Nothing has been booked. Run `ingest-bank`, then `reconcile`.');
        return result.payouts.length + result.lines.length > 0 ? 0 : 1;
      }

      case 'ingest-bank': {
        const path = argv[1];
        const bank = argv[2] ?? 'bank';
        if (!path) {
          console.error('usage: ingest-bank <file> [bank-id]');
          return 2;
        }

        const bytes = await readFile(path);
        const result = ingestBankStatement(bytes, {
          bankAccountId: process.env['RECON_BANK_ACCOUNT'] ?? 'primary',
          bank,
          filename: path,
          receivedFrom: process.env['RECON_OPERATOR'] ?? 'cli',
          receivedAt: new Date(),
        });

        heading(`Ingested ${path}`);
        line(`  evidence: ${result.evidence.evidenceId.slice(0, 16)}…`);
        for (const statementLine of result.lines) {
          line(
            `  ${statementLine.direction === 'credit' ? '+' : '−'} ${statementLine.reference.padEnd(14)}` +
              ` ${format(statementLine.amount).padStart(14)}   ${statementLine.narration}`,
          );
        }
        for (const rejected of result.rejected) {
          line(`  – ${rejected.kind}: ${rejected.reason}`);
        }

        await recordEvidence(pool, result.evidence, bytes);
        const stored = await recordBankLines(pool, result.lines);
        line();
        line(`  ${stored.stored} stored, ${stored.duplicates} already seen.`);
        line('  This is the only evidence that can book cash. Run `reconcile`.');
        return result.lines.length > 0 ? 0 : 1;
      }

      case 'reconcile': {
        await runMigrations(pool, MIGRATIONS);
        heading('Reconciling');
        line('  Stage 2: promises against what the PSPs say they are sending.');
        line('  Stage 3: those reports against what the bank says arrived.');
        line();
        const run = await reconcile(pool, {
          asOf: new Date(),
          policyFor: await buildPolicy(pool, MERCHANT),
        });
        printReconciliation(run);
        return run.failures.length === 0 ? 0 : 1;
      }

      case 'replay': {
        heading('Replaying from event zero');
        line('  Fold the log, and check what falls out against every projection derived');
        line('  from it. Three independent records of the same truth — the entries, the');
        line('  balance cache, and the event log — written by three different code paths.');
        line();

        // `--rebuild` discards the cache first and rebuilds it from the log. Without it
        // this is a read-only proof, safe to run on a schedule against production.
        const rebuild = argv.includes('--rebuild');
        const report = rebuild ? await rebuildBalancesFromEvents(pool) : await replay(pool);

        line(`  ${report.events} events folded${rebuild ? ', balances rebuilt from them' : ''}.`);
        for (const [accountId, balance] of [...report.balances].sort()) {
          line(`    ${accountId.padEnd(18)} ${format(money(balance)).padStart(16)}`);
        }

        line();
        if (report.agrees) {
          line('  [32m✓ every projection agrees with the log.[0m');
          return 0;
        }

        line('  [31m✗ a projection disagrees with the log:[0m');
        for (const drift of report.drift) {
          line(`    ${drift.what} ${drift.key}: log says ${drift.fromEvents}, live says ${drift.live}`);
        }
        return 1;
      }

      case 'exceptions': {
        heading('The queue');
        line('  Worst first: cash we hold and cannot explain outranks money that is late.');
        line('  Every entry carries what the matcher already considered and rejected.');
        line();
        await printQueue(pool);
        // An exception queue is not a failure. Exit 0 whatever it holds; the *contents*
        // are the operational signal, and a non-zero exit here would make every cron that
        // runs it look broken.
        return 0;
      }
    }
  } finally {
    await pool.end();
  }
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    console.error(`\n${error instanceof Error ? error.stack : String(error)}`);
    process.exitCode = 1;
  });
