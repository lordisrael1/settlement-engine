import type { AccountId, ProjectionDrift, ReplayReport } from '@recon/canon';
import { foldBalances } from '@recon/canon';

import { readEvents } from './events.js';
import { inTransaction, type Executor } from './pool.js';

/**
 * The proof.
 *
 * Everything else in this system is an assertion that the books are right. This is the one
 * operation that *demonstrates* it: fold the log from event zero, and check that what falls
 * out equals what the tables say. Three independent records of the same truth — the entries,
 * the balance cache, and the event log — written by three different code paths, and any two
 * disagreeing means one of them is wrong and we find out on a schedule rather than during an
 * audit.
 *
 * Note what makes this stronger than the usual event-sourcing arrangement. When the log is
 * the only writer, replaying it can only ever reproduce itself: the fold agrees with the
 * projection because the projection came from the fold, and a bug in the writer is
 * invisible. Here the two are written independently in the same transaction, so agreement
 * is evidence rather than tautology.
 *
 * Nothing here reads a clock or takes an `asOf`. A replay is a statement about what the
 * record says, and the answer must be the same in March and in December (Law 5).
 */

const PAGE = 500;

/**
 * Fold the whole log and compare it with every projection derived from it.
 *
 * Reads in pages, because "replay the whole history" is precisely the operation whose input
 * grows without bound — and a proof that runs out of memory the moment the history gets
 * interesting is not a proof.
 */
export async function replay(db: Executor): Promise<ReplayReport> {
  const folded = new Map<AccountId, bigint>();
  let after = 0n;
  let events = 0;

  for (;;) {
    const page = await readEvents(db, { after, limit: PAGE });
    if (page.length === 0) break;

    for (const [accountId, amount] of foldBalances(page)) {
      folded.set(accountId, (folded.get(accountId) ?? 0n) + amount);
    }

    events += page.length;
    after = page[page.length - 1]!.sequence;
  }

  const drift = [
    ...(await balanceDrift(db, folded)),
    ...(await entryDrift(db, folded)),
    ...(await exceptionDrift(db)),
  ];

  return { events, balances: folded, drift, agrees: drift.length === 0 };
}

/**
 * The log against the balance cache.
 *
 * An account present in one and absent from the other counts as a difference against zero,
 * which is the honest reading: "we have no row for this" and "this account holds nothing"
 * are the same claim, and a fold that produces a non-zero balance for an account the cache
 * has never heard of is exactly the kind of drift this exists to catch.
 */
async function balanceDrift(
  db: Executor,
  folded: ReadonlyMap<AccountId, bigint>,
): Promise<ProjectionDrift[]> {
  const cached = await db.query<{ account_id: AccountId; balance_kobo: string }>(
    'SELECT account_id, balance_kobo::text FROM account_balances',
  );

  const live = new Map(cached.rows.map((row) => [row.account_id, BigInt(row.balance_kobo)]));
  const accounts = new Set([...folded.keys(), ...live.keys()]);

  return [...accounts]
    .sort()
    .filter((accountId) => (folded.get(accountId) ?? 0n) !== (live.get(accountId) ?? 0n))
    .map((accountId) => ({
      what: 'balance',
      key: accountId,
      fromEvents: (folded.get(accountId) ?? 0n).toString(),
      live: (live.get(accountId) ?? 0n).toString(),
    }));
}

/**
 * The log against the entries themselves.
 *
 * A separate check from the cache, and not a redundant one: the cache could agree with the
 * log while both disagree with the entries, which are the only thing the Law 1 trigger
 * actually guards. This is the comparison that catches a booking event carrying entries the
 * ledger never wrote.
 */
async function entryDrift(
  db: Executor,
  folded: ReadonlyMap<AccountId, bigint>,
): Promise<ProjectionDrift[]> {
  const summed = await db.query<{ account_id: AccountId; total: string }>(
    'SELECT account_id, SUM(amount_kobo)::text AS total FROM entries GROUP BY account_id',
  );

  const live = new Map(summed.rows.map((row) => [row.account_id, BigInt(row.total)]));
  const accounts = new Set([...folded.keys(), ...live.keys()]);

  return [...accounts]
    .sort()
    .filter((accountId) => (folded.get(accountId) ?? 0n) !== (live.get(accountId) ?? 0n))
    .map((accountId) => ({
      what: 'entries',
      key: accountId,
      fromEvents: (folded.get(accountId) ?? 0n).toString(),
      live: (live.get(accountId) ?? 0n).toString(),
    }));
}

/**
 * The unified log against the queue's own log.
 *
 * The exception queue keeps its history in `exception_events` and derives its state from it;
 * the unified log records the same raises and resolutions from a different call site. Two
 * writers in one transaction, so agreement is a real check on both — and a queue whose state
 * disagrees with the system narrative is exactly the sort of divergence that gets noticed
 * six months later by somebody with a spreadsheet.
 *
 * Skipped where the reconciler's tables are absent: the ledger is usable on its own, and a
 * replay that fails because an optional package is not installed proves nothing.
 */
async function exceptionDrift(db: Executor): Promise<ProjectionDrift[]> {
  const present = await db.query<{ exists: boolean }>(
    `SELECT to_regclass('exception_events') IS NOT NULL AS exists`,
  );
  if (!present.rows[0]?.exists) return [];

  const fromLog = await db.query<{ subject: string; open: boolean }>(
    `SELECT DISTINCT ON (subject) subject, type = 'ExceptionRaised' AS open
       FROM events
      WHERE type IN ('ExceptionRaised', 'ExceptionResolved')
      ORDER BY subject, sequence DESC`,
  );
  const fromQueue = await db.query<{ exception_key: string; state: string }>(
    'SELECT exception_key, state FROM exceptions',
  );

  const logged = new Map(fromLog.rows.map((row) => [row.subject, row.open]));
  const queued = new Map(
    fromQueue.rows.map((row) => [row.exception_key, row.state !== 'resolved']),
  );
  const keys = new Set([...logged.keys(), ...queued.keys()]);

  return [...keys]
    .sort()
    .filter((key) => (logged.get(key) ?? false) !== (queued.get(key) ?? false))
    .map((key) => ({
      what: 'exception',
      key,
      fromEvents: (logged.get(key) ?? false) ? 'open' : 'resolved',
      live: (queued.get(key) ?? false) ? 'open' : 'resolved',
    }));
}

/**
 * Throw the balance cache away and rebuild it from the log alone.
 *
 * The bible's exit criterion, executed rather than argued: delete the projection, replay
 * from event zero, and the numbers come back. It is safe precisely because
 * `account_balances` is a cache and was never protected by an append-only trigger — the
 * entries are the truth, and this table has always been a convenience that Law 6 keeps
 * honest.
 *
 * Returns the report from the *rebuilt* state, so a caller can assert in one step that the
 * rebuild reproduced the ledger rather than merely completing.
 */
export async function rebuildBalancesFromEvents(db: Executor): Promise<ReplayReport> {
  const report = await replay(db);

  await inTransaction(db, async (client) => {
    // Zeroed rather than deleted: every account in the chart keeps its row, because a
    // missing row and a zero balance are the same claim and one of them breaks a foreign
    // key. This is the "delete all projections" step, done in the way this schema allows.
    await client.query('UPDATE account_balances SET balance_kobo = 0');

    for (const [accountId, balance] of report.balances) {
      await client.query(
        `INSERT INTO account_balances (account_id, balance_kobo, currency)
              VALUES ($1, $2::bigint, 'NGN')
         ON CONFLICT (account_id) DO UPDATE SET balance_kobo = EXCLUDED.balance_kobo`,
        [accountId, balance.toString()],
      );
    }
  });

  // Recomputed against the freshly rebuilt cache: if the rebuild were wrong, this second
  // report is where it shows, and a caller gets the failure rather than a cheerful summary
  // of the state it just corrupted.
  return replay(db);
}
