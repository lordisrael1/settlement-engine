import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';

import type { Pool } from 'pg';

import type { IngestAnomaly } from '@recon/canon';
import { anomalyKey, NO_LINEAGE } from '@recon/canon';
import { createPool, LEDGER_MIGRATIONS_DIR, runMigrations } from '@recon/ledger-core';

import {
  acknowledgeAnomaly,
  clearConformed,
  openAnomalies,
  recordAnomalies,
  resolveAnomaly,
} from './anomalies.js';
import { RECONCILER_MIGRATIONS_DIR } from './store.js';

/**
 * The drift queue, against a real Postgres — because what is being asserted is a lifecycle
 * held in a table and derived by a view, and a mock would only ever agree with us.
 *
 *   docker compose up -d postgres
 *   DATABASE_URL=postgres://recon:recon@localhost:5432/recon npm test
 *
 * The interesting assertions are not "a row was written". They are that the same drift seen
 * twice is one entry with two observations, that a person's ownership survives the next
 * upload, and that a source which starts behaving clears its own queue — the three properties
 * that decide whether anybody is still reading this table in a month.
 */
describe('ingest anomalies', { skip: !process.env['DATABASE_URL'] && 'set DATABASE_URL to run' }, () => {
  let pool: Pool;

  const AT = new Date('2026-08-15T10:00:00Z');
  const LATER = new Date('2026-08-16T10:00:00Z');

  const anomaly = (over: Partial<IngestAnomaly> = {}): IngestAnomaly => ({
    key: anomalyKey('flutterwave', 'unknown_field', '$.data[].settlement_fee'),
    source: 'flutterwave',
    kind: 'unknown_field',
    detail: '$.data[].settlement_fee',
    evidenceId: 'evidence-monday',
    evidenceKind: 'psp_settlement',
    parserVersion: 'flutterwave-settlements/2',
    format: 'flutterwave-settlements-api-v4',
    occurrences: 3,
    rowsInFile: 3,
    firstSeenAt: NO_LINEAGE,
    sample: null,
    observedAt: AT,
    ...over,
  });

  /**
   * The files these anomalies point at.
   *
   * Seeded rather than stubbed because `ingest_anomaly_events.evidence_id` carries a real
   * foreign key, and that constraint is a feature worth testing against rather than around: an
   * anomaly whose file cannot be produced is a complaint with no evidence behind it, and this
   * system's whole discipline is that every conclusion traces to bytes somebody can hand you
   * (ADR-0033).
   *
   * The insert is raw SQL rather than `recordEvidence` because that path encrypts bytes into
   * `evidence_blobs` and needs a key ring (ADR-0063) — none of which this suite is testing.
   */
  const EVIDENCE_IDS = [
    'evidence-monday',
    'evidence-tuesday',
    'evidence-n1',
    'evidence-n2',
    'evidence-n3',
    'evidence-m1',
    'evidence-f1',
    'evidence-f2',
  ];

  /**
   * A schema of this suite's own, as the reconciliation suite does — the other suites run
   * against the same database in parallel, and a queue assertion is global by nature.
   *
   * It also sidesteps a constraint worth naming: `evidence` is append-only, enforced by a
   * database trigger (ADR-0015), so a suite that seeded evidence into a shared schema could
   * not clean up after itself even if it wanted to. Dropping a private schema is the only
   * honest teardown available, and it is the better one anyway.
   */
  before(async () => {
    const schema = `anomaly_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
    const bootstrap = createPool(process.env['DATABASE_URL']!);
    await bootstrap.query(`CREATE SCHEMA ${schema}`);
    await bootstrap.end();

    const url = new URL(process.env['DATABASE_URL']!);
    url.searchParams.set('options', `-c search_path=${schema}`);
    pool = createPool(url.toString());

    await runMigrations(pool, [LEDGER_MIGRATIONS_DIR, RECONCILER_MIGRATIONS_DIR]);

    for (const id of EVIDENCE_IDS) {
      await pool.query(
        `INSERT INTO evidence
                (evidence_id, kind, source, filename, byte_length, received_from,
                 received_at, parser_version)
         VALUES ($1, 'psp_settlement', 'flutterwave', 'export.json', 1, 'test-suite', $2, 'test/1')
         ON CONFLICT (evidence_id) DO NOTHING`,
        [id, AT],
      );
    }
  });

  after(async () => {
    await pool.end();
  });

  /**
   * The property that makes this a queue rather than a log. An hourly upload of a file with
   * the same new field would otherwise produce twenty-four entries a day for one problem,
   * which is the exact shape of a table people mute.
   */
  test('the same drift in two files is one entry with two observations', async () => {
    const first = await recordAnomalies(pool, [anomaly()]);
    assert.deepEqual(first.raised.length, 1, 'the first sighting is news');

    const second = await recordAnomalies(pool, [
      anomaly({ evidenceId: 'evidence-tuesday', observedAt: LATER }),
    ]);
    assert.equal(second.raised.length, 0, 'the second is not');
    assert.equal(second.recurring.length, 1);

    const queue = await openAnomalies(pool);
    const entry = queue.find((item) => item.detail === '$.data[].settlement_fee');

    assert.ok(entry);
    assert.equal(entry.filesAffected, 2, 'two files');
    assert.equal(entry.timesRaised, 1, 'one problem');
    assert.deepEqual(entry.firstSeen, AT, 'and it began on Saturday, which is the useful part');
  });

  /**
   * Ownership must survive the next upload. A person who picked this up on Monday morning
   * should not be silently un-assigned at noon because the hourly cron ran again.
   */
  test('an acknowledged anomaly stays acknowledged when the drift is seen again', async () => {
    const key = anomalyKey('nomba', 'unknown_field', '$[].walletTag');
    await recordAnomalies(pool, [
      anomaly({ key, source: 'nomba', detail: '$[].walletTag', evidenceId: 'evidence-n1' }),
    ]);

    assert.equal(await acknowledgeAnomaly(pool, key, 'amaka', AT), true);
    await recordAnomalies(pool, [
      anomaly({
        key,
        source: 'nomba',
        detail: '$[].walletTag',
        evidenceId: 'evidence-n2',
        observedAt: LATER,
      }),
    ]);

    const entry = (await openAnomalies(pool)).find((item) => item.key === key);
    assert.ok(entry);
    assert.equal(entry.state, 'acknowledged', 'still Amaka’s');
  });

  /**
   * The operation that keeps the queue readable. Without it the table only grows, and a
   * provider who fixed their own bad afternoon would cost somebody a click forever.
   */
  test('a source whose files parse cleanly clears its own queue', async () => {
    const key = anomalyKey('monnify', 'unknown_field', '$[].responseBody.reserveHeld');
    await recordAnomalies(pool, [
      anomaly({
        key,
        source: 'monnify',
        detail: '$[].responseBody.reserveHeld',
        evidenceId: 'evidence-m1',
      }),
    ]);

    // A later Monnify file drifts nothing at all.
    const cleared = await clearConformed(pool, 'monnify', [], LATER);
    assert.deepEqual(cleared, [key]);

    const open = await openAnomalies(pool);
    assert.equal(open.find((item) => item.key === key), undefined, 'gone, with nobody notified');
  });

  /**
   * Clearing is scoped to one source, and this is the test that matters most for trust: a
   * healthy chatty source must never be able to silence a quiet broken one.
   */
  test('a clean file from one source does not clear another source’s drift', async () => {
    const key = anomalyKey('nomba', 'unknown_value', 'record_type=payout_v2');
    await recordAnomalies(pool, [
      anomaly({
        key,
        source: 'nomba',
        kind: 'unknown_value',
        detail: 'record_type=payout_v2',
        evidenceId: 'evidence-n3',
      }),
    ]);

    await clearConformed(pool, 'flutterwave', [], LATER);

    const entry = (await openAnomalies(pool)).find((item) => item.key === key);
    assert.ok(entry, 'Flutterwave having a good day says nothing about Nomba');
  });

  /**
   * A drift that resolved and came back is appended as a reopening, never rewritten as though
   * it had been open all along. Which problems recur is the most useful signal this table
   * holds, and an UPDATE would erase it (ADR-0034).
   */
  test('drift that returns after resolution is recorded as a reopening', async () => {
    const key = anomalyKey('flutterwave', 'unknown_value', 'fees[].type=cross_border_levy');
    const drift = anomaly({
      key,
      kind: 'unknown_value',
      detail: 'fees[].type=cross_border_levy',
      evidenceId: 'evidence-f1',
    });

    await recordAnomalies(pool, [drift]);
    assert.equal(await resolveAnomaly(pool, key, 'amaka', 'parser_updated', AT), true);

    const back = await recordAnomalies(pool, [
      { ...drift, evidenceId: 'evidence-f2', observedAt: LATER },
    ]);
    assert.deepEqual(back.reopened, [key], 'a problem that came back is worth saying so');

    const history = await pool.query<{ to_state: string }>(
      'SELECT to_state FROM ingest_anomaly_events WHERE anomaly_key = $1 ORDER BY event_id',
      [key],
    );
    assert.deepEqual(
      history.rows.map((row) => row.to_state),
      ['open', 'resolved', 'open'],
      'three observations, none of them overwritten',
    );
  });
});
