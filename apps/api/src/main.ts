import { INBOX_MIGRATIONS_DIR } from '@recon/inbox';
import { createPool, LEDGER_MIGRATIONS_DIR, runMigrations } from '@recon/ledger-core';
import { RECONCILER_MIGRATIONS_DIR } from '@recon/reconciler';

import { buildApp } from './app.js';
import { configFromEnv } from './config.js';
import { startInboxWorker } from './worker.js';

/**
 * The deployable.
 *
 * Everything under `packages/` is a library that cannot run on its own; this is the process
 * you start. It owns no business logic — it reads configuration, opens a connection,
 * migrates, binds a port, starts a worker, and knows how to stop. Every decision it appears
 * to make is delegated.
 *
 * It joins `apps/pipeline` rather than replacing it. One set of libraries, two ways to run
 * them: a service for the traffic and a CLI for the operator, and nothing under `packages/`
 * changed when this arrived, which is what the split was for (D-022).
 */

/**
 * Each package owns its own migrations and its own numbers, so adding one to the system is
 * adding a directory to this list.
 */
const MIGRATIONS = [LEDGER_MIGRATIONS_DIR, RECONCILER_MIGRATIONS_DIR, INBOX_MIGRATIONS_DIR];

/**
 * An arbitrary constant, fixed forever: the key every replica takes before migrating.
 *
 * Two instances starting together would otherwise both find migration 0007 unapplied and
 * both try to create the table, and one of them would crash-loop on a duplicate-object
 * error at exactly the moment you are trying to deploy. Postgres advisory locks are held on
 * a connection and released when it closes, so a replica that dies mid-migration does not
 * wedge the next one.
 */
const MIGRATION_LOCK = 776_155_301;

async function main(): Promise<void> {
  const config = configFromEnv();
  const pool = createPool();
  const app = buildApp(
    { pool, config, now: () => new Date() },
    {
      logger: { level: process.env['LOG_LEVEL'] ?? 'info' },
      // Trust nothing about a header a proxy may or may not have set. Turned on by a
      // deployment that actually runs behind one, because a spoofable client address in a
      // financial audit log is worse than an honest proxy address.
      trustProxy: process.env['RECON_TRUST_PROXY'] === 'true',
    },
  );

  const migrator = await pool.connect();
  try {
    await migrator.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK]);
    for (const migration of await runMigrations(pool, MIGRATIONS)) {
      if (migration.outcome === 'applied') app.log.info(`migration applied: ${migration.name}`);
    }
  } finally {
    await migrator.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK]).catch(() => undefined);
    migrator.release();
  }

  const worker = startInboxWorker(
    pool,
    config,
    () => new Date(),
    (report) => app.log.info(report, 'inbox drained'),
    (error) => app.log.error({ err: error }, 'inbox drain failed'),
  );

  await app.listen({ host: config.host, port: config.port });

  /**
   * Stop accepting, finish what is in flight, then let go of the database.
   *
   * In that order and no other. Killing the pool first would abort a delivery mid-booking —
   * which the design survives, because the inbox row stays pending and the ledger's primary
   * key refuses the second attempt at what did commit. Surviving a failure is not a reason
   * to cause one.
   */
  let closing = false;
  const shutdown = (signal: string): void => {
    if (closing) return;
    closing = true;
    app.log.info(`${signal} received — draining`);

    void (async () => {
      try {
        await app.close();
        await worker.stop();
        await pool.end();
        process.exitCode = 0;
      } catch (error) {
        app.log.error({ err: error }, 'unclean shutdown');
        process.exitCode = 1;
      }
    })();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((error: unknown) => {
  console.error(`\n${error instanceof Error ? error.stack : String(error)}`);
  process.exitCode = 1;
});
