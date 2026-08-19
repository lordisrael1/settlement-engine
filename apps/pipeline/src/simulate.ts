import type { Pool } from 'pg';

import type { AccountId } from '@recon/canon';
import { format, money } from '@recon/canon';
import { createPool, LEDGER_MIGRATIONS_DIR, runMigrations } from '@recon/ledger-core';
import { RECONCILER_MIGRATIONS_DIR } from '@recon/reconciler';
import { arrivals, generate } from '@recon/simulator';

import { calendarFor, drive, SIMULATED_SECRETS } from './chaos.js';
import { heading, line } from './report.js';

/**
 * A ledger of this seed's own, emptied first.
 *
 * Every number this command prints is an **absolute** claim — "the books land exactly
 * here" — and that is only a statement about a ledger nothing else has written to. Run
 * against the shared schema it would be measuring the demo's weather, and two different
 * seeds could not coexist at all: their fee contracts occupy the same scope, and the
 * exclusion constraint that forbids two contracts in force at once would refuse the
 * second one. Correctly — the constraint is right and the command was wrong.
 *
 * Named after the seed rather than randomly, so the books can be opened afterwards:
 *
 *   psql -c 'SET search_path = simulator_seed_42' -c 'SELECT * FROM entries'
 */
async function ledgerFor(seed: number): Promise<{ pool: Pool; schema: string }> {
  const schema = `simulator_seed_${seed}`;
  const bootstrap = createPool();
  try {
    // Dropped and rebuilt, so a second run of the same seed is the same narrative rather
    // than the same narrative on top of yesterday's. Safe because this command owns every
    // schema of this name and creates nothing anywhere else.
    await bootstrap.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await bootstrap.query(`CREATE SCHEMA ${schema}`);
  } finally {
    await bootstrap.end();
  }

  const url = new URL(process.env['DATABASE_URL']!);
  url.searchParams.set('options', `-c search_path=${schema}`);
  const pool = createPool(url.toString());
  await runMigrations(pool, [LEDGER_MIGRATIONS_DIR, RECONCILER_MIGRATIONS_DIR]);
  return { pool, schema };
}

/**
 * The adversarial simulator, narrated.
 *
 * The same generator the Phase 8 suite runs, with the answer printed instead of asserted —
 * because "158 tests pass" and "here is the day it survived" are different kinds of
 * evidence, and only the second one can be watched.
 *
 * It still fails: the exit code is the suite's own claim, checked here rather than by
 * `node --test`. A demo that cannot fail is a slideshow.
 */
export async function runSimulation(seed: number, reverse: boolean): Promise<boolean> {
  const { pool, schema } = await ledgerFor(seed);
  try {
    return await narrate(pool, schema, seed, reverse);
  } finally {
    await pool.end();
  }
}

async function narrate(
  pool: Pool,
  schema: string,
  seed: number,
  reverse: boolean,
): Promise<boolean> {
  const scenario = generate({ seed, calendarFor, secrets: SIMULATED_SECRETS });
  const order = reverse ? [...arrivals(scenario)].reverse() : arrivals(scenario);

  heading(`A generated Tuesday — seed ${seed}`);
  line('  Not a fixture. Every amount, count and grouping below comes from that one');
  line('  integer, and the same integer reproduces these exact bytes on any machine.');
  line();
  line(`  ${scenario.deliveries.length} signed webhook deliveries across two providers`);
  line(`  ${scenario.settlements.length} settlement exports, ${scenario.statements.length} bank statements`);
  line(`  reconciled as at ${scenario.asOf.toISOString()}`);
  line();
  line(`  Into an empty ledger of its own — schema ${schema} — because every number below`);
  line('  is an absolute claim, and that is only a claim about books nobody else wrote to.');

  heading('What was planted, and what each thing is');
  line('  a fee renegotiation      payments on both sides of it, priced at their own rates');
  line('  a reversal               on a rail that never names the payout carrying it');
  line('  a chargeback             folded in beside the fees, where it is easiest to miss');
  line('  a bank charge            a correspondent bank took it and told nobody');
  line(`  a straggler              ${scenario.truth.stragglerPayouts.join(', ')} — reported, uncredited, not late`);
  line(`  one phantom credit       ${scenario.truth.phantomCreditKeys.join(', ')}`);
  line();
  line('  Everything except the last must be explained without a human. That is the claim.');

  heading(`Arrival order${reverse ? ' — reversed, deliberately' : ''}`);
  for (const [index, arrival] of order.entries()) {
    line(`  ${String(index + 1).padStart(2)}. ${arrival.label}`);
  }
  if (reverse) {
    line();
    line('  Bank statements before the reports that explain them, and settlement rows before');
    line('  the promises they settle. Each of those raises a finding the canonical order');
    line('  never sees — and every one of them has to close itself when the evidence lands.');
  }

  const state = await drive(pool, scenario, order, { secrets: SIMULATED_SECRETS });

  heading('The books, against what the arithmetic says they should be');
  const expected = new Map<string, bigint>(
    Object.entries(scenario.truth.balances).filter(([, kobo]) => kobo !== 0n),
  );
  const actual = new Map<string, bigint>(state.balances.map(([id, kobo]) => [id, kobo]));

  let booksAgree = true;
  for (const accountId of [...new Set([...expected.keys(), ...actual.keys()])].sort()) {
    const want = expected.get(accountId) ?? 0n;
    const got = actual.get(accountId) ?? 0n;
    const agrees = want === got;
    booksAgree &&= agrees;
    line(
      `  ${agrees ? '✓' : '✗'} ${accountId.padEnd(18)} ${format(money(got)).padStart(16)}` +
        (agrees ? '' : `   expected ${format(money(want))}`),
    );
  }

  heading('What a human is shown');
  if (state.queue.length === 0) {
    line('  Nothing at all.');
  }
  for (const entry of state.queue) {
    line(`  ${entry.reason.padEnd(22)} ${entry.subject.padEnd(14)} ${entry.subjectId}`);
  }
  line();
  const onlyThePhantom =
    state.queue.length === scenario.truth.phantomCreditKeys.length &&
    state.queue.every((entry) => scenario.truth.phantomCreditKeys.includes(entry.subjectId));
  line(
    onlyThePhantom
      ? '  Exactly the planted phantom, and nothing else. Every other difference — the'
      : '  ✗ the queue is not exactly the planted phantom.',
  );
  if (onlyThePhantom) {
    line('  renegotiated rate, the reversal, the clawback, the bank charge, the payout still');
    line('  inside its window — was explained by the machine and shown to nobody.');
  }

  heading('The system checks itself');
  line(`  Law 6  cached balances == recomputed balances   ${state.cacheAgrees ? '✓ all accounts agree' : '✗ drifted'}`);
  line(
    `  Law 1  every entry ever written sums to           ` +
      `${state.conservationKobo === 0n ? '✓ zero' : `✗ ${state.conservationKobo}`}`,
  );
  line(
    `  bookings the ledger refused                       ` +
      `${state.failures.length === 0 ? '✓ none' : `✗ ${state.failures.join('; ')}`}`,
  );

  const ok =
    booksAgree &&
    onlyThePhantom &&
    state.cacheAgrees &&
    state.conservationKobo === 0n &&
    state.failures.length === 0;

  line();
  line(
    ok
      ? '\x1b[32mThe generated day was survived.\x1b[0m'
      : '\x1b[31mThe generated day was not survived.\x1b[0m',
  );
  return ok;
}

export type { AccountId };
