import type { Pool } from 'pg';

import type { AccountId, SourceId } from '@recon/canon';
import {
  ingestBankStatement,
  ingestSettlement,
  ingestWebhook,
  sourceProfile,
} from '@recon/ingest';
import {
  allBalances,
  bookAuthorizedPayment,
  verifyBalances,
  verifyConservation,
} from '@recon/ledger-core';
import { buildPolicy } from '@recon/policy';
import {
  openExceptions,
  reconcile,
  recordBankLines,
  recordEvidence,
  recordPayouts,
  recordSettlementLines,
  saveFeeContract,
} from '@recon/reconciler';
import type { Arrival, Scenario } from '@recon/simulator';

/**
 * The harness: a generated scenario, driven through the real stack.
 *
 * Nothing here is business logic and nothing here is clever. It is the same wiring
 * `main.ts` does — verify a delivery, book the promise, ingest a file, record what came out,
 * reconcile — with one addition that is the entire point of the file: the order the
 * arrivals are applied in is an argument.
 *
 * Real evidence does not arrive in the order that makes it easy. A bank statement is
 * exported before the PSP's settlement report is available; a webhook is retried three days
 * late; a file is uploaded twice by two people. If the final partition depends on which of
 * those happened first, the system does not have a reconciliation — it has a race, and the
 * answer it gives is the answer of whoever clicked first.
 */

export interface HarnessOptions {
  /** The provider secrets. The same ones the scenario signed with, or nothing verifies. */
  readonly secrets: Readonly<Record<SourceId, string>>;
  readonly bankAccountId?: string;
  readonly bank?: SourceId;
  /** Reconcile after every arrival, rather than once at the end. */
  readonly reconcileBetween?: boolean;
}

/** Everything about the final state that ought not to depend on arrival order. */
export interface FinalState {
  /** Every account with a non-zero balance, in a canonical order. */
  readonly balances: readonly (readonly [AccountId, bigint])[];
  /** What a human is being shown, worst first. */
  readonly queue: readonly {
    readonly subject: string;
    readonly subjectId: string;
    readonly reason: string;
  }[];
  /** Bookings the reconciler tried and the ledger refused. Must always be empty. */
  readonly failures: readonly string[];
  /** Law 6, and Law 1, checked at the end of every drive. */
  readonly cacheAgrees: boolean;
  readonly conservationKobo: bigint;
}

/**
 * Seed the contracts, then apply every arrival in the given order.
 *
 * The contracts come first because they are not evidence — they are the agreements the
 * evidence is read against, and a fee model that arrives halfway through a reconciliation
 * would make the same file price differently depending on when it landed (Law 5).
 */
export async function drive(
  pool: Pool,
  scenario: Scenario,
  order: readonly Arrival[],
  options: HarnessOptions,
): Promise<FinalState> {
  for (const contract of scenario.feeContracts) await saveFeeContract(pool, contract);

  const failures: string[] = [];

  for (const arrival of order) {
    await apply(pool, scenario, arrival, options);
    if (options.reconcileBetween !== false) {
      failures.push(...(await runReconcile(pool, scenario)));
    }
  }

  // A final pass whatever the setting, so every drive ends having seen every record.
  failures.push(...(await runReconcile(pool, scenario)));

  return {
    balances: [...(await allBalances(pool))]
      .filter(([, amount]) => amount.kobo !== 0n)
      .map(([accountId, amount]) => [accountId, amount.kobo] as const)
      .sort(([a], [b]) => (a < b ? -1 : 1)),
    queue: (await openExceptions(pool)).map((entry) => ({
      subject: entry.subject,
      subjectId: entry.subjectId,
      reason: entry.reason,
    })),
    failures,
    cacheAgrees: (await verifyBalances(pool)).length === 0,
    conservationKobo: (await verifyConservation(pool)).kobo,
  };
}

async function runReconcile(pool: Pool, scenario: Scenario): Promise<string[]> {
  const run = await reconcile(pool, {
    asOf: scenario.asOf,
    policyFor: await buildPolicy(pool, scenario.merchantId),
    limit: 50_000,
  });
  return run.failures.map((failure) => `${failure.matchId}: ${failure.error}`);
}

async function apply(
  pool: Pool,
  scenario: Scenario,
  arrival: Arrival,
  options: HarnessOptions,
): Promise<void> {
  switch (arrival.kind) {
    case 'webhooks': {
      for (const delivery of arrival.deliveries) {
        const result = ingestWebhook({
          source: delivery.source,
          headers: delivery.headers,
          rawBody: delivery.body,
          secret: options.secrets[delivery.source] ?? '',
        });

        // A simulator that quietly produced unverifiable deliveries would test the 401 path
        // very thoroughly and nothing else, so this is loud rather than skipped.
        if (result.kind !== 'payment') {
          throw new Error(
            `Scenario ${scenario.seed}: delivery ${delivery.reference} from ` +
              `${delivery.source} came back "${result.kind}"` +
              ('reason' in result ? ` — ${result.reason}` : ''),
          );
        }

        await bookAuthorizedPayment(pool, result.payment, scenario.asOf);
      }
      return;
    }

    case 'settlement': {
      const result = ingestSettlement(arrival.file.source, arrival.file.bytes, {
        merchantId: scenario.merchantId,
        filename: arrival.file.filename,
        receivedFrom: 'simulator',
        receivedAt: scenario.asOf,
      });

      if (result.rejected.length > 0) {
        throw new Error(
          `Scenario ${scenario.seed}: ${arrival.file.filename} had rejected rows — ` +
            result.rejected.map((row) => `${row.kind}: ${row.reason}`).join('; '),
        );
      }

      await recordEvidence(pool, result.evidence, arrival.file.bytes);
      await recordPayouts(pool, result.payouts);
      await recordSettlementLines(pool, result.lines);
      return;
    }

    case 'statement': {
      const result = ingestBankStatement(arrival.file.bytes, {
        bankAccountId: options.bankAccountId ?? 'gtb-3011',
        bank: options.bank ?? 'gtbank',
        filename: arrival.file.filename,
        receivedFrom: 'simulator',
        receivedAt: scenario.asOf,
      });

      if (result.rejected.length > 0) {
        throw new Error(
          `Scenario ${scenario.seed}: ${arrival.file.filename} had rejected rows — ` +
            result.rejected.map((row) => `${row.kind}: ${row.reason}`).join('; '),
        );
      }

      await recordEvidence(pool, result.evidence, arrival.file.bytes);
      await recordBankLines(pool, result.lines);
      return;
    }
  }
}

/**
 * The secrets the simulator signs with.
 *
 * Test values, and obviously so. They exist because a signature scheme with no secret is not
 * a signature scheme, and because the harness must verify against exactly what was signed.
 */
export const SIMULATED_SECRETS: Readonly<Record<SourceId, string>> = {
  paystack: 'sk_test_simulated_secret',
  flutterwave: 'flw_test_simulated_secret_hash',
  nomba: 'nomba_test_simulated_secret',
  monnify: 'monnify_test_simulated_secret',
};

/** The system's own answer to "when is money late", handed to the simulator (Law 7). */
export const calendarFor = (source: SourceId) => sourceProfile(source).calendar;
