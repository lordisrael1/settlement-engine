import type { AccountId, Money } from '@recon/canon';
import { ACCOUNT_IDS, equals, money, subtract } from '@recon/canon';

import type { Executor } from './pool.js';

/**
 * The balance of an account: the sum of its entries. Nothing else.
 *
 * This is the definition, not an optimisation of one. `cachedBalance` below is the
 * optimisation, and Law 6 exists to keep it honest about being one.
 */
export async function balance(db: Executor, accountId: AccountId): Promise<Money> {
  const result = await db.query<{ total: string }>(
    'SELECT COALESCE(SUM(amount_kobo), 0)::text AS total FROM entries WHERE account_id = $1',
    [accountId],
  );
  return money(BigInt(result.rows[0]?.total ?? '0'));
}

/** Every account's balance, recomputed from entries. */
export async function allBalances(db: Executor): Promise<Map<AccountId, Money>> {
  const result = await db.query<{ account_id: AccountId; total: string }>(
    `SELECT a.account_id, COALESCE(SUM(e.amount_kobo), 0)::text AS total
       FROM accounts a
       LEFT JOIN entries e ON e.account_id = a.account_id
      GROUP BY a.account_id`,
  );
  const balances = new Map<AccountId, Money>();
  for (const row of result.rows) balances.set(row.account_id, money(BigInt(row.total)));
  for (const id of ACCOUNT_IDS) if (!balances.has(id)) balances.set(id, money(0n));
  return balances;
}

/** The cached running balance. Fast, and never to be trusted over `balance()`. */
export async function cachedBalance(db: Executor, accountId: AccountId): Promise<Money> {
  const result = await db.query<{ balance_kobo: string }>(
    'SELECT balance_kobo::text FROM account_balances WHERE account_id = $1',
    [accountId],
  );
  return money(BigInt(result.rows[0]?.balance_kobo ?? '0'));
}

export interface BalanceDiscrepancy {
  readonly accountId: AccountId;
  readonly cached: Money;
  readonly recomputed: Money;
  readonly difference: Money;
}

/**
 * Law 6, as an assertion you can run at any moment.
 *
 * Returns the accounts where the cache disagrees with the entries. An empty array is the
 * system proving to itself that its own shortcut has not drifted — the same
 * two-independent-records discipline that reconciliation applies to the outside world,
 * turned inward.
 */
export async function verifyBalances(db: Executor): Promise<BalanceDiscrepancy[]> {
  const result = await db.query<{
    account_id: AccountId;
    cached: string;
    recomputed: string;
  }>(
    `SELECT b.account_id,
            b.balance_kobo::text                     AS cached,
            COALESCE(SUM(e.amount_kobo), 0)::text    AS recomputed
       FROM account_balances b
       LEFT JOIN entries e ON e.account_id = b.account_id
      GROUP BY b.account_id, b.balance_kobo`,
  );

  const discrepancies: BalanceDiscrepancy[] = [];
  for (const row of result.rows) {
    const cached = money(BigInt(row.cached));
    const recomputed = money(BigInt(row.recomputed));
    if (!equals(cached, recomputed)) {
      discrepancies.push({
        accountId: row.account_id,
        cached,
        recomputed,
        difference: subtract(cached, recomputed),
      });
    }
  }
  return discrepancies;
}

/**
 * Law 1, at the scale of the whole ledger: every entry ever written, summed, must be
 * zero. Each transaction balancing individually implies it, so a non-zero result here
 * means an entry exists outside any balanced transaction — corruption, not a bug in
 * arithmetic. Cheap enough to run on every deploy.
 */
export async function verifyConservation(db: Executor): Promise<Money> {
  const result = await db.query<{ total: string }>(
    'SELECT COALESCE(SUM(amount_kobo), 0)::text AS total FROM entries',
  );
  return money(BigInt(result.rows[0]?.total ?? '0'));
}
