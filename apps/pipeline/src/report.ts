import type { AccountId, MatchResult, Money } from '@recon/canon';
import { CHART_OF_ACCOUNTS, format, isZero, reasonKind } from '@recon/canon';
import { allBalances, verifyBalances, verifyConservation, type Executor } from '@recon/ledger-core';
import { openExceptions, type ReconciliationRun } from '@recon/reconciler';

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
 * What the run concluded, in the order a human wants it: what it settled, what it is
 * still waiting on, and — last, because it is the only part anyone has to act on — what
 * it could not explain.
 *
 * The goal of the whole system is for the last section to be empty.
 */
export function printReconciliation(run: ReconciliationRun): void {
  const counted = (results: readonly MatchResult[]) => {
    const tally = new Map<string, number>();
    for (const result of results) {
      tally.set(result.reason, (tally.get(result.reason) ?? 0) + 1);
    }
    return [...tally].sort(([a], [b]) => (a < b ? -1 : 1));
  };

  const section = (title: string, note: string, results: readonly MatchResult[]) => {
    console.log(`  ${title.padEnd(34)} ${String(results.length).padStart(3)}`);
    for (const [reason, count] of counted(results)) {
      console.log(
        `    ${reason.padEnd(22)} ${String(count).padStart(3)}   ` +
          `${reasonKind(reason as MatchResult['reason'])} · ${note}`,
      );
    }
  };

  section(
    'stage 2 · reported by the PSP',
    'matched, not yet money',
    run.allocation.prepared.map((prepared) => prepared.result),
  );
  console.log();
  section(
    'stage 3 · confirmed by the bank',
    'booked',
    run.confirmation.confirmed.map((confirmed) => confirmed.result),
  );

  console.log();
  section('waiting', 'not an error', run.deferred);
  console.log();
  section('unexplained', 'a human sees this', run.exceptions);

  // What the run did to the *queue*, which is a different number from what it found. A run
  // that finds four problems and raises none has found the same four as yesterday, and
  // saying so is the difference between a queue and a report.
  console.log();
  console.log(
    `  queue                              ` +
      `${String(run.queue.raised).padStart(3)} raised, ` +
      `${run.queue.unchanged} already open, ` +
      `${run.queue.reopened} returned, ` +
      `${run.queue.cleared} cleared by evidence`,
  );

  for (const failure of run.failures) {
    console.log(`\n  ✗ ${failure.matchId} (${failure.reason})`);
    console.log(`    ${failure.error.split('\n')[0]}`);
  }
}

/**
 * The queue a human actually works from.
 *
 * Worst first, and every entry carries what the matcher already looked at — because the
 * alternative is an operator re-deriving, by hand, the reasoning the machine threw away.
 */
export async function printQueue(db: Executor, limit = 50): Promise<number> {
  const items = await openExceptions(db, { limit });

  if (items.length === 0) {
    console.log('  Nothing unexplained. This is the goal, not a bug.');
    return 0;
  }

  for (const item of items) {
    const age = item.state === 'acknowledged' ? `held by ${item.acknowledgedBy}` : 'unowned';
    console.log(
      `  ${item.reason.padEnd(22)} ${item.subject.padEnd(15)} ${item.subjectId.slice(-24).padEnd(26)}` +
        `${item.amount ? format(item.amount).padStart(14) : ''.padStart(14)}   ${age}`,
    );
    for (const candidate of item.considered) {
      console.log(
        `      considered ${candidate.candidateId.slice(-24).padEnd(26)}` +
          `${candidate.difference ? format(candidate.difference).padStart(14) : ''.padStart(14)}` +
          `   ${candidate.rejectedBecause.replace(/_/g, ' ')}`,
      );
    }
  }

  return items.length;
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
