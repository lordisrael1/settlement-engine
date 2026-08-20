import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';

import type { Pool } from 'pg';

import type { FeeContract } from '@recon/canon';
import { createPool, LEDGER_MIGRATIONS_DIR, runMigrations } from '@recon/ledger-core';
import { matchOf, openExceptions, RECONCILER_MIGRATIONS_DIR } from '@recon/reconciler';
import {
  arrivals,
  bankStatementFile,
  flutterwaveCharge,
  flutterwaveSettlementFile,
  generate,
  random,
  signed,
  type Arrival,
  type Scenario,
} from '@recon/simulator';

import {
  calendarFor,
  drive,
  SIMULATED_SECRETS,
  SIMULATED_VAULT,
  type FinalState,
} from './chaos.js';

/**
 * The adversarial end-to-end suite.
 *
 * Everywhere else, the tests state a case and check the answer. Here the *case* is
 * generated — a renegotiated fee contract with payments on both sides of it, a reversal on a
 * rail that never names its payouts, a chargeback folded in beside the fees, a bank charge
 * nobody announced, a payout reported and not yet credited, and exactly one credit that
 * belongs to nobody — and the claim under test is the one the whole system exists to make:
 *
 *   **everything explainable is explained without a human, the books land exactly where
 *   arithmetic says they should, and the single genuine anomaly is the only thing anybody
 *   is shown.**
 *
 * Against a real Postgres, because two of the invariants being relied on are a deferred
 * constraint trigger and a partial unique index, and a mock would only agree with us.
 *
 *   docker compose up -d postgres
 *   DATABASE_URL=postgres://recon:recon@localhost:5432/recon npm test
 */
const DATABASE_URL = process.env['DATABASE_URL'];

/**
 * Fixed seeds, not a random one per run.
 *
 * A suite that draws its own seed is a suite that fails on somebody else's machine and
 * passes on yours. These four are arbitrary and permanent; a fifth is added by writing it
 * down, and a failure names the one that produced it.
 */
const SEEDS = [1, 7, 4_242];

const MIGRATIONS = [LEDGER_MIGRATIONS_DIR, RECONCILER_MIGRATIONS_DIR];

describe(
  'the adversarial simulator',
  { skip: DATABASE_URL ? false : 'set DATABASE_URL to run' },
  () => {
    const pools: Pool[] = [];

    /**
     * Every drive gets a schema of its own.
     *
     * These tests assert *absolute* balances — "the books are exactly here" — which is only
     * a meaningful claim about a ledger nothing else is writing to. Sharing `public` with
     * the property suite would make each assertion depend on what that suite had written.
     */
    const freshLedger = async (): Promise<Pool> => {
      const schema = `chaos_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
      const bootstrap = createPool(DATABASE_URL);
      await bootstrap.query(`CREATE SCHEMA ${schema}`);
      await bootstrap.end();

      const url = new URL(DATABASE_URL!);
      url.searchParams.set('options', `-c search_path=${schema}`);
      const pool = createPool(url.toString());
      pools.push(pool);

      await runMigrations(pool, MIGRATIONS);
      return pool;
    };

    const scenarioFor = (seed: number): Scenario =>
      generate({ seed, calendarFor, secrets: SIMULATED_SECRETS });

    before(() => undefined);
    after(async () => {
      await Promise.all(pools.map((pool) => pool.end()));
    });

    // ── The central claim ──────────────────────────────────────────────────────

    /**
     * The central claim, stated as a test: the simulator's one phantom credit is the only
     * item a human is ever shown.
     *
     * The balance assertion is what stops this being a weaker claim than it sounds. A queue
     * can be empty because everything was explained, or because everything was quietly
     * mis-booked into one account that happens to balance — and only the second half tells
     * those apart.
     */
    for (const seed of SEEDS) {
      test(`seed ${seed}: everything explainable is explained, and only the phantom is raised`, async () => {
        const scenario = scenarioFor(seed);
        const pool = await freshLedger();

        const state = await drive(pool, scenario, arrivals(scenario), {
          secrets: SIMULATED_SECRETS,
          vault: SIMULATED_VAULT,
        });

        assert.deepEqual(state.failures, [], `seed ${seed}: the ledger refused a booking`);

        assert.deepEqual(
          state.queue.map((entry) => `${entry.reason} ${entry.subjectId}`),
          scenario.truth.phantomCreditKeys.map((key) => `UNIDENTIFIED_CREDIT ${key}`),
          `seed ${seed}: the queue is not exactly the planted phantom`,
        );

        assert.deepEqual(
          Object.fromEntries(state.balances),
          Object.fromEntries(
            Object.entries(scenario.truth.balances).filter(([, kobo]) => kobo !== 0n),
          ),
          `seed ${seed}: the books did not land where the arithmetic says`,
        );

        assert.ok(state.cacheAgrees, `seed ${seed}: the balance cache drifted from the entries`);
        assert.equal(state.conservationKobo, 0n, `seed ${seed}: the books stopped balancing`);
      });
    }

    /**
     * The straggler is not in the queue, and that is a decision the calendar made.
     *
     * A payout reported and not yet credited is the most common real state in Nigerian
     * settlement. Escalating it would put an entry in the queue every single day for money
     * that is going exactly to plan — which is how an exception queue becomes something
     * nobody opens, and then how the phantom above goes unnoticed for a week.
     */
    test('a payout inside its settlement window is pending, not late', async () => {
      const scenario = scenarioFor(SEEDS[0]!);
      const pool = await freshLedger();

      const state = await drive(pool, scenario, arrivals(scenario), {
        secrets: SIMULATED_SECRETS,
        vault: SIMULATED_VAULT,
      });

      assert.ok(scenario.truth.stragglerPayouts.length > 0, 'the scenario planted no straggler');
      for (const payout of scenario.truth.stragglerPayouts) {
        assert.ok(
          !state.queue.some((entry) => entry.subjectId === payout),
          `${payout} is inside its window and should not be in the queue`,
        );
      }
    });

    // ── The fee change ────────────────────────────────────────────────────────

    /**
     * History is priced at its own rates.
     *
     * The scenario renegotiates the card rate partway through and puts payments on both
     * sides of the boundary. If the reconciliation applied today's contract to all of them,
     * every payment before the renegotiation would develop a fee variance that never
     * happened — and the books would still balance, which is what makes this failure mode
     * worth a test rather than a comment.
     */
    test('each payment is priced by the contract in force at its own moment', async () => {
      const scenario = scenarioFor(SEEDS[0]!);
      const pool = await freshLedger();

      await drive(pool, scenario, arrivals(scenario), { secrets: SIMULATED_SECRETS, vault: SIMULATED_VAULT });

      const expected = new Map(
        scenario.truth.pricedBy.map((entry) => [entry.reference, entry.contractId]),
      );
      assert.ok(expected.size > 0, 'the scenario priced nothing');

      const contracts = new Set(scenario.feeContracts.map((c: FeeContract) => c.contractId));
      assert.equal(contracts.size, 2, 'the scenario did not renegotiate anything');

      let checked = 0;
      let expectedFeeKobo = 0n;
      let observedFeeKobo = 0n;

      for (const payoutReference of [
        ...scenario.truth.confirmedPayouts,
        ...scenario.truth.stragglerPayouts,
      ]) {
        const match = await matchOf(pool, `allocate:${payoutReference}`);
        assert.ok(match, `no conclusion recorded for ${payoutReference}`);

        for (const explanation of match.explainedBy) {
          const wanted = expected.get(explanation.transactionId);
          assert.equal(
            explanation.contractId,
            wanted,
            `${explanation.transactionId} was priced by the wrong contract`,
          );
          expectedFeeKobo += explanation.expectedFee?.kobo ?? 0n;
          observedFeeKobo += explanation.observedFee?.kobo ?? 0n;
          checked += 1;
        }
      }

      assert.equal(checked, expected.size, 'not every payment was priced');
      // The sharp version of the claim: our dated model predicted what the PSP actually
      // charged, to the kobo, across a rate change. Per-payment shares can differ by a kobo
      // because apportionment is exact-sum and rounding has to land somewhere; the total
      // cannot.
      assert.equal(
        expectedFeeKobo,
        observedFeeKobo,
        'the fee model and the PSP disagree about what the batch cost',
      );
    });

    // ── Out-of-order arrival ──────────────────────────────────────────────────

    /**
     * The partition does not depend on who clicked first.
     *
     * Real evidence arrives in whatever order it arrives: a bank statement exported before
     * the PSP's report is available, a settlement file uploaded two days late, a webhook
     * retried after both. Every one of those orders passes through states the canonical
     * order never visits — a credit that matches nothing yet, a payout with no promises to
     * cover — and each of those raises an exception that must later *clear itself* when the
     * missing record turns up.
     *
     * If the final state differed by order, the system would not have a reconciliation. It
     * would have a race, and the answer would be whichever one happened to be observed.
     */
    test('every arrival order reaches the same books and the same queue', async () => {
      const scenario = scenarioFor(SEEDS[0]!);
      const canonical = arrivals(scenario);

      const orders: { label: string; order: readonly Arrival[] }[] = [
        { label: 'canonical', order: canonical },
        { label: 'reversed', order: [...canonical].reverse() },
      ];

      // Seeded shuffles rather than every permutation: six orders is enough to visit the
      // interesting shapes, and the seed makes a failure reproducible.
      const shuffler = random(0xc0ffee);
      for (let attempt = 0; attempt < 4; attempt += 1) {
        orders.push({ label: `shuffle-${attempt}`, order: shuffler.shuffle(canonical) });
      }

      let reference: FinalState | null = null;
      let referenceLabel = '';

      for (const { label, order } of orders) {
        const pool = await freshLedger();
        const state = await drive(pool, scenario, order, { secrets: SIMULATED_SECRETS, vault: SIMULATED_VAULT });

        assert.deepEqual(state.failures, [], `${label}: the ledger refused a booking`);
        assert.ok(state.cacheAgrees, `${label}: the balance cache drifted`);
        assert.equal(state.conservationKobo, 0n, `${label}: the books stopped balancing`);

        if (reference === null) {
          reference = state;
          referenceLabel = label;
          continue;
        }

        assert.deepEqual(
          state.balances,
          reference.balances,
          `${label} reached different books than ${referenceLabel} ` +
            `(order: ${order.map((a) => a.label).join(' → ')})`,
        );
        assert.deepEqual(
          state.queue,
          reference.queue,
          `${label} reached a different queue than ${referenceLabel} ` +
            `(order: ${order.map((a) => a.label).join(' → ')})`,
        );
      }
    });

    /**
     * The exceptions raised along the way close themselves.
     *
     * Reversing the arrival order guarantees the intermediate runs raise findings the
     * canonical order never sees — a bank credit before its payout exists, a settlement line
     * before its promise does. Every one of them must be closed by the evidence finally
     * arriving, without a person. If they were not, the queue would grow by the number of
     * unlucky orderings rather than by the number of problems.
     */
    test('findings raised by an unlucky order clear themselves when the evidence lands', async () => {
      const scenario = scenarioFor(SEEDS[0]!);
      const pool = await freshLedger();

      await drive(pool, scenario, [...arrivals(scenario)].reverse(), {
        secrets: SIMULATED_SECRETS,
        vault: SIMULATED_VAULT,
      });

      const everRaised = await openExceptions(pool, { states: ['open', 'acknowledged', 'resolved'] });
      const stillOpen = await openExceptions(pool);

      assert.ok(
        everRaised.length > stillOpen.length,
        'the reversed order raised nothing extra, so this test proves nothing',
      );
      assert.deepEqual(
        stillOpen.map((entry) => entry.subjectId),
        scenario.truth.phantomCreditKeys,
        'something raised on the way through never closed',
      );
      for (const entry of everRaised) {
        if (stillOpen.some((open) => open.key === entry.key)) continue;
        assert.equal(
          entry.resolvedCause,
          'evidence_arrived',
          `${entry.key} was closed, but not by the evidence turning up`,
        );
      }
    });

    // ── Duplicates ────────────────────────────────────────────────────────────

    /**
     * Idempotency, across every rail at once.
     *
     * Providers retry until you answer 200, operators upload the same export twice, and a
     * bank statement for an overlapping period contains rows you already have. Duplicates
     * are guaranteed, not unlikely. Applying the entire scenario a second time must move
     * exactly no money and raise exactly no new exception.
     */
    test('replaying every file and delivery a second time changes nothing', async () => {
      const scenario = scenarioFor(SEEDS[0]!);
      const pool = await freshLedger();
      const order = arrivals(scenario);

      const once = await drive(pool, scenario, order, { secrets: SIMULATED_SECRETS, vault: SIMULATED_VAULT });
      const twice = await drive(pool, scenario, order, { secrets: SIMULATED_SECRETS, vault: SIMULATED_VAULT });

      assert.deepEqual(twice.failures, [], 'the second pass refused a booking');
      assert.deepEqual(twice.balances, once.balances, 'the second pass moved money');
      assert.deepEqual(twice.queue, once.queue, 'the second pass changed the queue');
    });

    /**
     * The same settlement rows arriving inside *different* bytes.
     *
     * Content addressing catches the identical file — the hash is the same, so the evidence
     * is the same record. This is the harder case: an export re-run with a different page
     * size, or one file pasted into another, produces bytes we have never seen carrying rows
     * we have. Deduplication has to happen on the *record's* identity, not the file's.
     */
    test('a settlement report re-exported into different bytes still books once', async () => {
      const scenario = scenarioFor(SEEDS[0]!);
      const pool = await freshLedger();
      const order = arrivals(scenario);

      const once = await drive(pool, scenario, order, { secrets: SIMULATED_SECRETS, vault: SIMULATED_VAULT });

      // The same rows, with the pagination metadata a second export would carry. Different
      // hash, same payouts.
      const reExported = order.map((arrival): Arrival => {
        if (arrival.kind !== 'settlement' || arrival.file.source !== 'flutterwave') return arrival;
        const original = JSON.parse(arrival.file.bytes.toString('utf8')) as {
          data: unknown[];
          meta: unknown;
        };
        return {
          kind: 'settlement',
          label: `${arrival.label}#reexport`,
          file: {
            ...arrival.file,
            filename: `re-${arrival.file.filename}`,
            bytes: Buffer.from(
              JSON.stringify({
                status: 'success',
                message: 'Settlements fetched',
                meta: { page_info: { total: original.data.length, current_page: 1, total_pages: 1 }, exported_again: true },
                data: original.data,
              }),
              'utf8',
            ),
          },
        };
      });

      const twice = await drive(pool, scenario, reExported, { secrets: SIMULATED_SECRETS, vault: SIMULATED_VAULT });

      assert.deepEqual(twice.failures, [], 'the re-export refused a booking');
      assert.deepEqual(twice.balances, once.balances, 'the re-export booked the payouts again');
      assert.deepEqual(twice.queue, once.queue, 'the re-export changed the queue');
    });

    // ── Refusing to guess ─────────────────────────────────────────────────────

    /**
     * The one case where escalating *is* the correct answer.
     *
     * Four promises, and a payout whose gross two different pairs of them sum to exactly —
     * by gross and, because the rate is a flat percentage, by net as well. Taking either
     * pair would settle the wrong receivable and leave the right one to escalate later as an
     * inexplicable absence, long after anybody could reconstruct what happened.
     *
     * Guessing costs a week of nobody knowing anything is wrong. Escalating costs five
     * minutes. This is the test that stops a future "helpful" tie-break from being added.
     */
    test('a payout two different subsets fit equally well escalates rather than guessing', async () => {
      const asOf = new Date('2026-08-18T09:00:00.000Z');
      const paidAt = new Date('2026-08-17T09:00:00.000Z');
      const valueDate = new Date('2026-08-17T18:00:00.000Z');
      const pool = await freshLedger();

      // ₦10,000 + ₦20,000 and ₦12,000 + ₦18,000. Both sum to ₦30,000 gross — and under a
      // pure-percentage card, to the same net too.
      const amounts = [1_000_000n, 2_000_000n, 1_200_000n, 1_800_000n];
      const contract: FeeContract = {
        contractId: 'ambiguous-card',
        source: 'flutterwave',
        merchantId: 'ambiguity-merchant',
        channel: 'card',
        currency: 'NGN',
        effectiveFrom: new Date(0),
        effectiveTo: null,
        rateCard: {
          percentBasisPoints: 140,
          flatKobo: 0n,
          flatWaivedBelowKobo: null,
          capKobo: null,
          vatBasisPoints: 750,
        },
        approvedBy: 'cfo@example.com',
        approvedAt: new Date(0),
      };

      const grossKobo = 3_000_000n;
      const feeKobo = 42_000n; // 1.40% of ₦30,000
      const vatKobo = 3_150n; // 7.5% of the fee
      const payoutReference = 'FLW-AMBIGUOUS-01';

      const scenario: Scenario = {
        seed: 0,
        merchantId: 'ambiguity-merchant',
        asOf,
        feeContracts: [contract],
        deliveries: amounts.map((gross, index) =>
          signed(
            'flutterwave',
            flutterwaveCharge({
              chargeId: `chg-amb-${index}`,
              reference: `ORD-AMB-${index}`,
              grossKobo: gross,
              occurredAt: paidAt,
              channel: 'card',
            }),
            SIMULATED_SECRETS['flutterwave']!,
            `chg-amb-${index}`,
          ),
        ),
        settlements: [
          {
            source: 'flutterwave',
            filename: 'ambiguous-settlements.json',
            bytes: flutterwaveSettlementFile([
              {
                payoutReference,
                grossKobo,
                feeKobo,
                vatKobo,
                chargebackKobo: 0n,
                reportedAt: valueDate,
                valueDate,
                chargeCount: 2,
              },
            ]),
          },
        ],
        statements: [
          { source: 'gtbank', filename: 'ambiguous-statement.json', bytes: bankStatementFile([]) },
        ],
        truth: {
          phantomCreditKeys: [],
          confirmedPayouts: [],
          stragglerPayouts: [],
          reversedPayments: [],
          pricedBy: [],
          balances: {},
        },
      };

      const state = await drive(pool, scenario, arrivals(scenario), {
        secrets: SIMULATED_SECRETS,
        vault: SIMULATED_VAULT,
      });

      assert.deepEqual(state.failures, [], 'the ledger refused a booking');
      assert.deepEqual(
        state.queue.map((entry) => [entry.reason, entry.subjectId]),
        [['PHANTOM_CREDIT', payoutReference]],
        'the matcher picked one of two equally good answers instead of escalating',
      );

      // And it kept its working, so whoever picks this up is not starting from scratch.
      const match = await openExceptions(pool);
      assert.ok(
        (match[0]?.considered.length ?? 0) > 0,
        'the exception carries no record of what was considered',
      );

      // Nothing was booked at all: no cash, and no receivable discharged.
      assert.equal(
        state.balances.find(([accountId]) => accountId === 'bank_account')?.[1] ?? 0n,
        0n,
        'an ambiguous payout moved cash',
      );
    });
  },
);
