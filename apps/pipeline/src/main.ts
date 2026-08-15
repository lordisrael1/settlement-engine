import { readFile } from 'node:fs/promises';

import { format } from '@recon/canon';
import { ingestSettlement, SOURCE_IDS, sourceProfile } from '@recon/ingest';
import { createPool, runMigrations } from '@recon/ledger-core';

import { runDemo } from './demo.js';
import { heading, line, printBalances, printVerification } from './report.js';

/**
 * The deployable.
 *
 * Everything under `packages/` is a library that cannot run on its own; this is the
 * process you start. It owns no business logic — it opens a connection, dispatches a
 * command, and prints. Every decision it appears to make is delegated to a package.
 *
 * Phase 6 replaces this entry point with a Fastify service. The libraries do not change
 * when that happens, which is the whole point of keeping them libraries.
 */
const COMMANDS = ['migrate', 'demo', 'balances', 'verify', 'ingest-settlement'] as const;
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
        for (const migration of await runMigrations(pool)) {
          line(`  ${migration.outcome.padEnd(15)} ${migration.name}`);
        }
        return 0;
      }

      case 'demo': {
        await runMigrations(pool);
        heading('Record the fast promise, wait for the slow money');
        line('  Phases 1 and 2, end to end, against a real Postgres.');
        line(`  Sources with an adapter: ${SOURCE_IDS.join(', ')}`);
        const ok = await runDemo(pool);
        line(ok ? '\x1b[32mAll invariants held.\x1b[0m' : '\x1b[31mAn invariant failed.\x1b[0m');
        return ok ? 0 : 1;
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

        const result = ingestSettlement(source, await readFile(path));
        heading(`Ingested ${path}`);
        line(`  format: ${result.format}`);
        for (const settlementLine of result.lines) {
          line(
            `  ✓ ${settlementLine.reference.padEnd(16)} net ${format(settlementLine.net).padStart(14)}` +
              `  fee ${format(settlementLine.fee).padStart(10)}`,
          );
        }
        for (const rejected of result.rejected) {
          line(`  – ${rejected.kind}: ${rejected.reason}`);
        }
        line();
        line(`  ${result.lines.length} lines, ${result.rejected.length} rejected.`);
        return result.lines.length > 0 ? 0 : 1;
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
