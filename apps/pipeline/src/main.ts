import { readFile } from 'node:fs/promises';

import { format, money } from '@recon/canon';
import {
  ingestBankStatement,
  ingestSettlement,
  SOURCE_IDS,
  sourceProfile,
} from '@recon/ingest';
import { INBOX_MIGRATIONS_DIR } from '@recon/inbox';
import {
  createPool,
  LEDGER_MIGRATIONS_DIR,
  rebuildBalancesFromEvents,
  replay,
  runMigrations,
} from '@recon/ledger-core';
import { buildPolicy } from '@recon/policy';
import {
  attestBankBalance,
  bankPosition,
  collisionDraft,
  lastAttestation,
  raiseExceptions,
  reconcile,
  reservePositions,
  recordBankLines,
  recordEvidence,
  recordPayouts,
  recordSettlementLines,
  RECONCILER_MIGRATIONS_DIR,
} from '@recon/reconciler';

import { BENCHMARKS, runBenchmarks, type Benchmark } from './bench.js';
import { runDemo } from './demo.js';
import { runRetentionCommand } from './retention.js';
import { runSimulation } from './simulate.js';
import { vaultFromEnv } from './vault.js';

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
const MIGRATIONS = [LEDGER_MIGRATIONS_DIR, RECONCILER_MIGRATIONS_DIR, INBOX_MIGRATIONS_DIR];

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
  'reserves',
  'attest-bank',
  'replay',
  'evidence-retention',
  'bench',
] as const;
type Command = (typeof COMMANDS)[number];

async function main(argv: readonly string[]): Promise<number> {
  const command = (argv[0] ?? 'demo') as Command;
  if (!COMMANDS.includes(command)) {
    console.error(`Unknown command "${command}". Try one of: ${COMMANDS.join(', ')}`);
    return 2;
  }

  // Dispatched before the pool exists, deliberately. Two of the three benchmarks touch no
  // database — parsing and the subset-sum search are pure functions — and demanding a
  // Postgres to measure them would make the cheapest numbers in the repository the most
  // annoying ones to reproduce. The ledger benchmark asks for the URL itself and says so
  // when it is missing, rather than being skipped in silence.
  if (command === 'bench') {
    const flag = (name: string, fallback: number): number => {
      const found = argv.find((arg) => arg.startsWith(`--${name}=`));
      const value = found ? Number(found.slice(name.length + 3)) : NaN;
      return Number.isFinite(value) && value > 0 ? value : fallback;
    };

    const named = argv.slice(1).filter((arg) => !arg.startsWith('-')) as Benchmark[];
    const unknown = named.filter((name) => !BENCHMARKS.includes(name));
    if (unknown.length > 0) {
      console.error(`Unknown benchmark "${unknown[0]}". Try one of: ${BENCHMARKS.join(', ')}`);
      return 2;
    }

    heading('Benchmark');
    await runBenchmarks(named.length > 0 ? named : BENCHMARKS, {
      seed: flag('seed', 1),
      samples: flag('samples', 200),
      line,
      databaseUrl: process.env['DATABASE_URL'],
    });
    return 0;
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
        await recordEvidence(pool, result.evidence, bytes, vaultFromEnv());
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

        await recordEvidence(pool, result.evidence, bytes, vaultFromEnv());
        const stored = await recordBankLines(pool, result.lines);
        line();
        line(`  ${stored.stored} stored, ${stored.duplicates} already seen.`);

        // Two distinct credits wearing one id. Not a duplicate, not stored, and the loudest
        // thing this command can say — because the alternative is a quiet drop and a payout
        // that mysteriously never confirms three days later (ADR-0068).
        if (stored.collisions.length > 0) {
          await raiseExceptions(pool, stored.collisions.map(collisionDraft), new Date());
          line();
          line(`  \x1b[31m${stored.collisions.length} row(s) NOT stored: id already held by a different row.\x1b[0m`);
          for (const collision of stored.collisions) {
            line(
              `    ${collision.idempotencyKey}  differs in ${collision.differing.join(', ')}` +
                `  (${format(collision.arriving.amount)}, ${collision.arriving.narration})`,
            );
          }
          line('    Your statement ids are not unique. Include the running balance or a');
          line('    within-file sequence in them, then re-upload — a hash of date, amount and');
          line('    narration collides on two genuine same-day credits and drops one.');
          line('    Each is queued as BANK_LINE_COLLISION; see `exceptions`.');
          return 1;
        }

        line('  This is the only evidence that can book cash. Run `reconcile`.');
        return result.lines.length > 0 ? 0 : 1;
      }

      case 'reconcile': {
        await runMigrations(pool, MIGRATIONS);
        heading('Reconciling');
        line('  Stage 2: promises against what the PSPs say they are sending.');
        line('  Stage 3: those reports against what the bank says arrived.');
        line();
        // Bounded, and the bound is visible. A run that hits it reads a *sample* — and
        // stops clearing exceptions whose subjects it never loaded, which is the difference
        // between "the problem went away" and "we did not look" (ADR-0075). The report says
        // so in yellow when it happens.
        const flag = argv.find((arg) => arg.startsWith('--limit='));
        const asked = flag ? Number(flag.slice('--limit='.length)) : NaN;
        const envLimit = Number(process.env['RECON_RECONCILE_LIMIT']);
        const limit = Number.isInteger(asked) && asked > 0
          ? asked
          : Number.isInteger(envLimit) && envLimit > 0
            ? envLimit
            : 1000;

        const run = await reconcile(pool, {
          asOf: new Date(),
          policyFor: await buildPolicy(pool, MERCHANT),
          limit,
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

      /**
       * Move every document to the state its retention schedule says it should be in.
       *
       * A dry run unless `--apply` is given, because a command that destroys financial
       * evidence should have to be asked twice. Every destruction it carries out appends an
       * `EvidencePurged` event, so the deletion is part of the same narrative as everything
       * else that happened to the money (ADR-0065).
       */
      case 'evidence-retention': {
        await runMigrations(pool, MIGRATIONS);
        // Awaited, not returned. `return promise` inside this try/finally would run
        // `pool.end()` before the command had finished with it — every other case here
        // awaits and returns a number, which is why none of them tripped over it.
        return await runRetentionCommand(pool, {
          asOf: new Date(),
          apply: argv.includes('--apply'),
        });
      }

      /**
       * Our money, in somebody else's account, and how long it has been there.
       *
       * `psp_reserve` is an asset and the balance alone is unfalsifiable: a PSP that returns
       * reserves on schedule and one that never returns any produce the same number. This is
       * that number taken apart — which payout, withheld when, due when, how much is still
       * out (ADR-0071).
       */
      case 'reserves': {
        await runMigrations(pool, MIGRATIONS);
        heading('Reserves outstanding');
        line('  Withheld by a PSP and not yet returned. Overdue ones are also in the queue.');
        line();

        const positions = await reservePositions(pool);
        if (positions.length === 0) {
          line('  Nothing outstanding. Either no source withholds, or everything came back.');
          return 0;
        }

        const now = new Date();
        for (const position of positions) {
          const overdue = position.dueAt !== null && position.dueAt < now;
          const due =
            position.dueAt === null
              ? 'no schedule declared'
              : `due ${position.dueAt.toISOString().slice(0, 10)}`;
          line(
            `  ${overdue ? '\x1b[31m!\x1b[0m' : ' '} ${position.inflowKey.padEnd(20)}` +
              ` ${format(position.outstanding).padStart(14)} of ${format(position.withheld).padStart(14)}` +
              `  withheld ${position.withheldAt.toISOString().slice(0, 10)}  ${due}`,
          );
        }

        line();
        line('  A source with no declared schedule is never overdue and never clears itself.');
        line('  That is not a bug: it is what "they promised nothing" looks like.');
        return 0;
      }

      /**
       * The control the architecture cannot perform for itself.
       *
       * Cash is booked from an uploaded file, and nothing proves the file came from the bank
       * — no signature, no feed, no independent check. `verify` does not catch a fabricated
       * statement and could not: it proves the books are internally consistent, and a
       * fabricated statement that balances is internally consistent. The only real control
       * is a person opening the bank's own portal and comparing (ADR-0068).
       *
       * With no argument this prints the comparison the system *can* make on its own — our
       * balance against the bank's own running balance on the last line we ingested — which
       * catches a half-ingested statement but proves nothing about provenance. With
       * `--balance` it records what a named person read in the portal.
       */
      case 'attest-bank': {
        await runMigrations(pool, MIGRATIONS);
        const account = process.env['RECON_BANK_ACCOUNT'] ?? 'primary';
        const position = await bankPosition(pool, account);

        heading(`Bank position — ${account}`);
        line(`  books say                 ${format(position.ledgerBalance).padStart(16)}`);
        line(
          `  last statement's own      ` +
            (position.statementClosing
              ? `${format(position.statementClosing).padStart(16)}  ` +
                `(value date ${position.statementAt?.toISOString().slice(0, 10)})`
              : '     — no statement line reports a running balance'),
        );
        if (position.difference) {
          line(`  difference                ${format(position.difference).padStart(16)}`);
          line();
          line('  A difference here is expected: the real account holds movements this system');
          line('  never models — supplier payments, salaries, standing orders. The question is');
          line('  not whether it is zero but whether anybody can say what it consists of.');
        }

        const balance = argv.find((arg) => arg.startsWith('--balance='));
        if (!balance) {
          const last = await lastAttestation(pool, account);
          line();
          line(
            last
              ? `  Last checked against the bank's portal ${last.asOf.toISOString().slice(0, 10)} ` +
                  `by ${last.attestedBy} (difference ${format(last.difference)}).`
              : `  \x1b[33mNobody has ever compared these books to the bank's own portal.\x1b[0m`,
          );
          line();
          line('  This is the trust boundary. Cash is booked from an uploaded file and nothing');
          line('  proves that file came from the bank; `verify` cannot catch a fabricated one,');
          line('  because a fabricated statement that balances is internally consistent.');
          line('  Record a check:  attest-bank --balance=<naira> [--note="..."]');
          return 0;
        }

        const naira = balance.slice('--balance='.length).replace(/,/g, '');
        if (!/^-?\d+(\.\d{1,2})?$/.test(naira)) {
          console.error('usage: attest-bank --balance=<naira, e.g. 1450320.55> [--note="..."]');
          return 2;
        }
        const [whole = '0', fraction = ''] = naira.replace('-', '').split('.');
        const kobo = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));

        const note = argv.find((arg) => arg.startsWith('--note='));
        const attested = await attestBankBalance(pool, {
          bankAccountId: account,
          asOf: new Date(),
          portalBalance: money(naira.startsWith('-') ? -kobo : kobo),
          // A person, not a service account. The same standard `resolutions` holds, because
          // this is the same kind of act: a human asserting something the machine cannot.
          attestedBy: process.env['RECON_OPERATOR'] ?? 'cli',
          note: note ? note.slice('--note='.length) : null,
          recordedAt: new Date(),
        });

        line();
        line(`  Recorded by ${attested.attestedBy}.`);
        line(`  portal ${format(attested.portalBalance)}  −  books ${format(attested.ledgerBalance)}`);
        line(`  difference ${format(attested.difference)}`);
        line();
        line('  Appended, never edited. An attestation that can be changed afterwards is not');
        line('  evidence that somebody checked; it is evidence that somebody has a row.');
        return 0;
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
