import pg from 'pg';
import type { Pool, PoolClient } from 'pg';

import { asLawViolation } from './errors.js';

/**
 * Anything that can run SQL. A `Pool` grabs its own connection per statement, so it is
 * only safe for single statements; a `PoolClient` is a pinned connection and is what a
 * multi-statement transaction needs. `inTransaction` below papers over the difference
 * without letting a caller accidentally write a multi-statement operation
 * non-atomically.
 */
export type Executor = Pool | PoolClient;

export function createPool(connectionString?: string): Pool {
  const url = connectionString ?? process.env['DATABASE_URL'];
  if (!url) {
    throw new Error(
      'DATABASE_URL is not set. The ledger needs Postgres — see docker-compose.yml.',
    );
  }
  return new pg.Pool({ connectionString: url });
}

/**
 * Run `fn` inside a database transaction.
 *
 * If `db` is already a pinned client we assume the caller opened the transaction and
 * simply join it — nested BEGINs are not a thing in Postgres, and silently opening a
 * second one would break the atomicity the caller is relying on. This is what lets
 * `reverse()` compose two ledger writes into one all-or-nothing unit.
 */
export async function inTransaction<T>(
  db: Executor,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  if (!(db instanceof pg.Pool)) return fn(db);

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    // Law 1's deferred constraint trigger fires here, not on INSERT. If the entries
    // do not sum to zero, this is the statement that throws.
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw asLawViolation(error) ?? error;
  } finally {
    client.release();
  }
}
