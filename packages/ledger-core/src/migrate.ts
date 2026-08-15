import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Pool } from 'pg';

import { CHART_OF_ACCOUNTS } from '@recon/canon';

import { inTransaction } from './pool.js';

/** The ledger's own migrations. Other packages pass their directories alongside it. */
export const LEDGER_MIGRATIONS_DIR = fileURLToPath(new URL('../migrations/', import.meta.url));

export interface AppliedMigration {
  readonly name: string;
  readonly outcome: 'applied' | 'already-applied';
}

/**
 * Apply every `.sql` file in the given directories, in filename order, exactly once.
 *
 * Each migration runs in its own transaction and records a checksum of the bytes that
 * ran. Editing an applied migration is therefore an error rather than a silent no-op:
 * the schema in front of you would no longer be the schema that was built, and every
 * later reasoning step would be based on a file that never executed.
 */
export async function runMigrations(
  pool: Pool,
  directories: readonly string[] = [LEDGER_MIGRATIONS_DIR],
): Promise<AppliedMigration[]> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name       TEXT PRIMARY KEY,
      checksum   TEXT NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  const files = await collect(directories);
  const results: AppliedMigration[] = [];

  for (const file of files) {
    const sql = await readFile(file.path, 'utf8');
    const checksum = createHash('sha256').update(sql).digest('hex');

    const existing = await pool.query<{ checksum: string }>(
      'SELECT checksum FROM schema_migrations WHERE name = $1',
      [file.name],
    );
    const applied = existing.rows[0];

    if (applied) {
      if (applied.checksum !== checksum) {
        throw new Error(
          `Migration "${file.name}" has changed since it was applied. ` +
            `An applied migration is history; add a new migration instead of editing it.`,
        );
      }
      results.push({ name: file.name, outcome: 'already-applied' });
      continue;
    }

    await inTransaction(pool, async (client) => {
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)', [
        file.name,
        checksum,
      ]);
    });
    results.push({ name: file.name, outcome: 'applied' });
  }

  await syncAccounts(pool);
  return results;
}

/**
 * Push the chart of accounts from `@recon/canon` into the database.
 *
 * The accounts exist in two places — a TypeScript constant and a table entries have a
 * foreign key to — and two copies of anything can disagree. Re-seeding on every migration
 * run makes the code the source of truth and the table a projection of it.
 */
export async function syncAccounts(pool: Pool): Promise<void> {
  for (const account of Object.values(CHART_OF_ACCOUNTS)) {
    await pool.query(
      `INSERT INTO accounts (account_id, account_type, natural_sign, meaning)
            VALUES ($1, $2, $3, $4)
       ON CONFLICT (account_id) DO UPDATE
              SET account_type = EXCLUDED.account_type,
                  natural_sign = EXCLUDED.natural_sign,
                  meaning      = EXCLUDED.meaning`,
      [account.id, account.type, account.naturalSign, account.meaning],
    );
    await pool.query(
      `INSERT INTO account_balances (account_id, balance_kobo, currency)
            VALUES ($1, 0, 'NGN')
       ON CONFLICT (account_id) DO NOTHING`,
      [account.id],
    );
  }
}

async function collect(
  directories: readonly string[],
): Promise<{ name: string; path: string }[]> {
  const files: { name: string; path: string }[] = [];
  const seen = new Map<string, string>();

  for (const directory of directories) {
    const names = (await readdir(directory)).filter((n) => n.endsWith('.sql')).sort();
    for (const name of names) {
      const previous = seen.get(name);
      if (previous) {
        throw new Error(
          `Two migrations are both named "${name}" (${previous} and ${directory}). ` +
            `Migration names are the applied-once key, so they must be unique across packages — ` +
            `give each package its own number range.`,
        );
      }
      seen.set(name, directory);
      files.push({ name, path: join(directory, name) });
    }
  }

  return files.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}
