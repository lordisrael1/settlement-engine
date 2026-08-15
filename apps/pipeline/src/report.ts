import type { AccountId, Money } from '@recon/canon';
import { CHART_OF_ACCOUNTS, format, isZero } from '@recon/canon';
import { allBalances, verifyBalances, verifyConservation, type Executor } from '@recon/ledger-core';

export function heading(text: string): void {
  console.log(`\n\x1b[1m${text}\x1b[0m`);
  console.log('─'.repeat(Math.max(text.length, 60)));
}

export function line(text = ''): void {
  console.log(text);
}

export async function printBalances(db: Executor): Promise<void> {
  const balances = await allBalances(db);
  const width = Math.max(...Object.keys(CHART_OF_ACCOUNTS).map((id) => id.length));

  for (const [accountId, amount] of balances) {
    const account = CHART_OF_ACCOUNTS[accountId as AccountId];
    console.log(
      `  ${accountId.padEnd(width)}  ${format(amount).padStart(16)}   ${account.type}`,
    );
  }
}

/**
 * The system checking itself: the cache against the entries (Law 6), and every entry
 * ever written against zero (Law 1 at the scale of the whole ledger).
 */
export async function printVerification(db: Executor): Promise<boolean> {
  const discrepancies = await verifyBalances(db);
  const conservation: Money = await verifyConservation(db);

  if (discrepancies.length === 0) {
    console.log('  Law 6  cached balances == recomputed balances   ✓ all accounts agree');
  } else {
    console.log('  Law 6  cached balances != recomputed balances   ✗');
    for (const d of discrepancies) {
      console.log(
        `         ${d.accountId}: cached ${format(d.cached)}, entries say ${format(d.recomputed)} ` +
          `(off by ${format(d.difference)})`,
      );
    }
  }

  const conserved = isZero(conservation);
  console.log(
    conserved
      ? '  Law 1  every entry ever written sums to           ✓ zero'
      : `  Law 1  every entry ever written sums to           ✗ ${format(conservation)}`,
  );

  return discrepancies.length === 0 && conserved;
}
