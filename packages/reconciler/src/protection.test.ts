import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';

import type { Pool } from 'pg';

import type { Evidence, EvidenceKind } from '@recon/canon';
import { DEFAULT_APPROVAL_POLICY, DEFAULT_RETENTION } from '@recon/canon';
import {
  createPool,
  eventsAbout,
  LEDGER_MIGRATIONS_DIR,
  runMigrations,
} from '@recon/ledger-core';
import { localKeyRing, openWithKey, parseLocalKey, redact } from '@recon/protect';

import {
  accessLog,
  accessVolume,
  evidenceAt,
  readEvidenceBytes,
  recordAccess,
  recordEvidence,
  runRetention,
  type EvidenceVault,
} from './evidence.js';
import { claimExport, issueExport, UnapprovedExportError, EvidenceUnavailableError } from './export.js';
import { RECONCILER_MIGRATIONS_DIR } from './store.js';

/**
 * Encryption, retention, access and export — against a real Postgres.
 *
 * Every claim here is about something the *database* does or refuses: a constraint that
 * makes an unapproved export impossible to record, a trigger that makes the access log
 * unrewritable, a column that holds ciphertext rather than a customer's email. A mock would
 * only ever agree with the design we already believe, and the whole point of putting these
 * controls in the schema is that they survive the code being wrong.
 *
 *   docker compose up -d postgres
 *   DATABASE_URL=postgres://recon:recon@localhost:5432/recon npm test
 */
const DATABASE_URL = process.env['DATABASE_URL'];

const RECEIVED = new Date('2026-06-01T09:00:00Z');
/** Well past the thirty-day dispute window, and nowhere near the six-year record horizon. */
const AFTER_WINDOW = new Date('2026-08-01T09:00:00Z');
/** Past everything. */
const AFTER_EVERYTHING = new Date('2033-01-01T09:00:00Z');

const VAULT: EvidenceVault = {
  keyRing: localKeyRing([parseLocalKey(`test:${Buffer.alloc(32, 2).toString('base64')}`)], 'test'),
  retention: DEFAULT_RETENTION,
};

/** A provider payload with everything a live one carries. */
const CHARGE = {
  event: 'charge.success',
  data: {
    id: 4_210_771,
    status: 'success',
    reference: 'PSK_9f3a2c',
    amount: 1_000_000,
    currency: 'NGN',
    channel: 'card',
    paid_at: '2026-06-01T08:14:22.000Z',
    created_at: '2026-06-01T08:14:02.000Z',
    fees: 25_000,
    ip_address: '102.89.34.11',
    customer: { id: 88_213, first_name: 'Amaka', email: 'amaka@example.com' },
    authorization: { authorization_code: 'AUTH_k2p9wz', bin: '506099', last4: '4412' },
  },
};

describe('evidence protection', { skip: DATABASE_URL ? false : 'set DATABASE_URL to run' }, () => {
  let pool: Pool;

  before(async () => {
    const schema = `protect_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
    const bootstrap = createPool(DATABASE_URL);
    await bootstrap.query(`CREATE SCHEMA ${schema}`);
    await bootstrap.end();

    const url = new URL(DATABASE_URL!);
    url.searchParams.set('options', `-c search_path=${schema}`);
    pool = createPool(url.toString());

    await runMigrations(pool, [LEDGER_MIGRATIONS_DIR, RECONCILER_MIGRATIONS_DIR]);
  });

  after(async () => {
    await pool.end();
  });

  const unique = () => randomUUID().replace(/-/g, '');

  const evidence = (id: string, kind: EvidenceKind): Evidence => ({
    evidenceId: id,
    kind,
    source: 'paystack',
    filename: kind === 'webhook' ? null : 'settlement.json',
    byteLength: 100,
    storageLocation: null,
    receivedFrom: 'amaka@example.com',
    receivedAt: RECEIVED,
    parserVersion: 'test/1',
  });

  const store = async (kind: EvidenceKind, bytes: Buffer): Promise<string> => {
    const id = unique();
    await recordEvidence(pool, evidence(id, kind), bytes, VAULT);
    return id;
  };

  const REDACTOR = (bytes: Buffer) => redact(bytes);

  // ── The bytes are not in the database ─────────────────────────────────────

  test('the column holds ciphertext, and only the key ring gets the bytes back', async () => {
    const bytes = Buffer.from(JSON.stringify(CHARGE), 'utf8');
    const id = await store('webhook', bytes);

    const column = await pool.query<{ ciphertext: Buffer; key_id: string }>(
      'SELECT ciphertext, key_id FROM evidence_blobs WHERE evidence_id = $1',
      [id],
    );
    assert.ok(!column.rows[0]!.ciphertext.includes(Buffer.from('amaka@example.com', 'utf8')));
    // Which root key sealed it, so a rotation is visible per row rather than assumed.
    assert.equal(column.rows[0]!.key_id, 'test');

    assert.deepEqual((await readEvidenceBytes(pool, id, VAULT))?.bytes, bytes);
  });

  test('a ciphertext moved to another evidence row does not decrypt', async () => {
    // The property the encryption context buys. A database write anybody can make must not
    // be able to serve one document's bytes as another document's evidence.
    const first = await store('webhook', Buffer.from('{"reference":"A"}', 'utf8'));
    const second = await store('webhook', Buffer.from('{"reference":"B"}', 'utf8'));

    await pool.query(
      `UPDATE evidence_blobs SET ciphertext = source.ciphertext, nonce = source.nonce,
              auth_tag = source.auth_tag, wrapped_key = source.wrapped_key,
              key_id = source.key_id
         FROM (SELECT ciphertext, nonce, auth_tag, wrapped_key, key_id
                 FROM evidence_blobs WHERE evidence_id = $1) AS source
        WHERE evidence_id = $2`,
      [first, second],
    );

    // It fails at the *outer* layer: the wrapped data key names the first document in its
    // encryption context, so unwrapping it under the second document's id is refused before
    // the payload cipher is even constructed. Either failure is the right one; this is the
    // one a whole-row copy produces.
    await assert.rejects(
      () => readEvidenceBytes(pool, second, VAULT),
      /did not unwrap|did not authenticate/,
    );
  });

  test('a document that will not decrypt is reported, and does not stop the run', async () => {
    // The corrupted row above is still due for retention. A run that aborted on it would
    // leave every other document unexpired — a retention job that quietly stops running is
    // worse than one that reports a document it could not move (the same reasoning the
    // inbox drain applies to a poison delivery).
    const healthy = await store('webhook', Buffer.from(JSON.stringify(CHARGE), 'utf8'));

    const report = await runRetention(pool, {
      asOf: AFTER_WINDOW,
      vault: VAULT,
      redact: REDACTOR,
      apply: true,
    });

    assert.ok(report.failed.length >= 1, 'the undecryptable document was not reported');
    assert.equal((await readEvidenceBytes(pool, healthy, VAULT))?.content, 'redacted');
  });

  // ── Retention ─────────────────────────────────────────────────────────────

  test('a dry run says what it would do and does nothing', async () => {
    const id = await store('webhook', Buffer.from(JSON.stringify(CHARGE), 'utf8'));

    const report = await runRetention(pool, {
      asOf: AFTER_WINDOW,
      vault: VAULT,
      redact: REDACTOR,
    });

    assert.equal(report.applied, false);
    assert.ok(report.redacted.some((action) => action.evidenceId === id));

    // Nothing was written: the default is the safe one, because a command that destroys
    // financial evidence should have to be asked twice.
    const held = await readEvidenceBytes(pool, id, VAULT);
    assert.equal(held?.content, 'original');
    assert.ok(held?.bytes.toString('utf8').includes('amaka@example.com'));
  });

  test('a provider payload past its window keeps its meaning and loses the customer', async () => {
    const id = await store('webhook', Buffer.from(JSON.stringify(CHARGE), 'utf8'));

    await runRetention(pool, { asOf: AFTER_WINDOW, vault: VAULT, redact: REDACTOR, apply: true });

    const held = await readEvidenceBytes(pool, id, VAULT);
    assert.equal(held?.content, 'redacted');
    // No longer the bytes that arrived, and the record says so rather than leaving anybody
    // to find out by re-hashing.
    assert.equal(held?.hashMatchesId, false);

    const text = held!.bytes.toString('utf8');
    assert.ok(text.includes('PSK_9f3a2c'));
    for (const gone of ['Amaka', 'amaka@example.com', '102.89.34.11', '506099', '4412']) {
      assert.ok(!text.includes(gone), `${gone} survived retention`);
    }

    // The evidence row itself is untouched: the hash, the uploader, the parser version and
    // the original byte length are still exactly what they were (ADR-0065).
    const record = await evidenceAt(pool, id);
    assert.equal(record?.byteLength, 100);
    assert.equal(record?.receivedFrom, 'amaka@example.com');
    assert.equal(record?.parserVersion, 'test/1');

    // And the destruction is in the narrative, not only in a column.
    const events = await eventsAbout(pool, id);
    const purge = events.find((event) => event.type === 'EvidencePurged');
    assert.equal(purge?.detail['from'], 'original');
    assert.equal(purge?.detail['to'], 'redacted');
  });

  test('a settlement export is never reduced — it is the record itself', async () => {
    // A bank narration naming a counterparty is evidence rather than an accident of
    // transport, so dropping it to satisfy minimisation would destroy the record in order
    // to protect it. Settlement and bank evidence are kept whole for the record horizon.
    const id = await store('psp_settlement', Buffer.from('{"settlements":[{"payer":"Amaka"}]}', 'utf8'));

    await runRetention(pool, { asOf: AFTER_WINDOW, vault: VAULT, redact: REDACTOR, apply: true });

    const held = await readEvidenceBytes(pool, id, VAULT);
    assert.equal(held?.content, 'original');
    assert.ok(held?.bytes.toString('utf8').includes('Amaka'));
  });

  test('at the end of retention the bytes go and the record stays', async () => {
    const id = await store('psp_settlement', Buffer.from('{"settlements":[]}', 'utf8'));

    await runRetention(pool, {
      asOf: AFTER_EVERYTHING,
      vault: VAULT,
      redact: REDACTOR,
      apply: true,
    });

    assert.equal(await readEvidenceBytes(pool, id, VAULT), null);

    const record = await evidenceAt(pool, id);
    assert.ok(record !== null, 'the evidence record was deleted, and must never be');
    assert.equal(record.content, null);
    assert.ok(record.purgedAt !== null);

    // Purged means empty, and the database enforces it rather than trusting the writer.
    await assert.rejects(
      pool.query(
        `UPDATE evidence_blobs SET ciphertext = 'restored'::bytea WHERE evidence_id = $1`,
        [id],
      ),
      /evidence_blobs_purged_is_empty/,
    );
  });

  test('a retention run is idempotent: the second pass finds nothing left to do', async () => {
    await store('webhook', Buffer.from(JSON.stringify(CHARGE), 'utf8'));
    await runRetention(pool, { asOf: AFTER_WINDOW, vault: VAULT, redact: REDACTOR, apply: true });

    const again = await runRetention(pool, {
      asOf: AFTER_WINDOW,
      vault: VAULT,
      redact: REDACTOR,
      apply: true,
    });
    assert.equal(again.redacted.length, 0);
  });

  test('re-uploading a file whose bytes were purged does not resurrect them', async () => {
    const bytes = Buffer.from('{"settlements":["once"]}', 'utf8');
    const id = await store('psp_settlement', bytes);
    await runRetention(pool, {
      asOf: AFTER_EVERYTHING,
      vault: VAULT,
      redact: REDACTOR,
      apply: true,
    });

    // Content-addressed, so the evidence row already exists and the upload is a duplicate.
    // Quietly restoring bytes a retention schedule destroyed would make the schedule a
    // suggestion.
    await recordEvidence(pool, evidence(id, 'psp_settlement'), bytes, VAULT);
    assert.equal(await readEvidenceBytes(pool, id, VAULT), null);
  });

  // ── The visitors' book ────────────────────────────────────────────────────

  test('the access log is append-only and counts by principal', async () => {
    const id = await store('webhook', Buffer.from(JSON.stringify(CHARGE), 'utf8'));

    await recordAccess(pool, {
      evidenceId: id,
      principal: 'amaka@example.com',
      action: 'read_raw',
      content: 'original',
      reason: 'chargeback 4417',
      at: RECEIVED,
    });

    const log = await accessLog(pool, id);
    assert.equal(log.length, 1);
    assert.equal(log[0]!.principal, 'amaka@example.com');
    assert.equal(log[0]!.reason, 'chargeback 4417');

    await assert.rejects(
      pool.query('UPDATE evidence_access SET principal = $1 WHERE evidence_id = $2', [
        'somebody-else',
        id,
      ]),
      /LAW_2_VIOLATION/,
    );

    // The query an alert runs. The signature of exfiltration is one principal reading many
    // documents, and no per-request check can see it.
    const volume = await accessVolume(pool, {
      from: new Date(RECEIVED.getTime() - 1000),
      to: new Date(RECEIVED.getTime() + 1000),
    });
    assert.ok(volume.some((row) => row.principal === 'amaka@example.com' && row.documents >= 1));
  });

  test('reading bytes without saying why is refused by the database', async () => {
    const id = await store('webhook', Buffer.from('{"reference":"X"}', 'utf8'));

    await assert.rejects(
      recordAccess(pool, {
        evidenceId: id,
        principal: 'amaka@example.com',
        action: 'read_raw',
        content: 'original',
        reason: null,
        at: RECEIVED,
      }),
      /evidence_access_reasoned/,
    );
  });

  // ── Export ────────────────────────────────────────────────────────────────

  const exportRequest = (id: string, over: Record<string, unknown> = {}) => ({
    evidenceId: id,
    content: 'redacted' as const,
    reason: 'auditor request 2026-Q2',
    requestedBy: 'amaka@example.com',
    requestedAt: RECEIVED,
    approvedBy: null,
    approvedAt: null,
    ...over,
  });

  test('a redacted export needs no approver, and comes back sealed', async () => {
    const id = await store('webhook', Buffer.from(JSON.stringify(CHARGE), 'utf8'));
    await runRetention(pool, { asOf: AFTER_WINDOW, vault: VAULT, redact: REDACTOR, apply: true });

    const issued = await issueExport(pool, {
      request: exportRequest(id),
      vault: VAULT,
      redact: REDACTOR,
      ttlMs: 60_000,
    });

    const claim = await claimExport(pool, issued.token, RECEIVED);
    assert.equal(claim.outcome, 'delivered');
    if (claim.outcome !== 'delivered') return;

    // The archive is unreadable without the key returned once at approval time — so the
    // stored copy is useless to the database, to a backup of it, and to us.
    assert.ok(!claim.archive.includes(Buffer.from('PSK_9f3a2c', 'utf8')));

    const nonce = claim.archive.subarray(0, 12);
    const tag = claim.archive.subarray(12, 28);
    const ciphertext = claim.archive.subarray(28);
    const opened = openWithKey(
      Buffer.from(issued.archiveKey, 'base64'),
      { nonce, authTag: tag, ciphertext },
      { export_id: issued.exportId },
    );
    assert.ok(opened.toString('utf8').includes('PSK_9f3a2c'));
    assert.ok(!opened.toString('utf8').includes('amaka@example.com'));
  });

  test('an export is collected once', async () => {
    const id = await store('webhook', Buffer.from('{"reference":"Y"}', 'utf8'));
    const issued = await issueExport(pool, {
      request: exportRequest(id),
      vault: VAULT,
      redact: REDACTOR,
      ttlMs: 60_000,
    });

    assert.equal((await claimExport(pool, issued.token, RECEIVED)).outcome, 'delivered');
    assert.equal((await claimExport(pool, issued.token, RECEIVED)).outcome, 'collected');
  });

  test('an expired link is refused, and says so rather than 404ing', async () => {
    const id = await store('webhook', Buffer.from('{"reference":"Z"}', 'utf8'));
    const issued = await issueExport(pool, {
      request: exportRequest(id),
      vault: VAULT,
      redact: REDACTOR,
      ttlMs: 60_000,
    });

    const claim = await claimExport(pool, issued.token, new Date(RECEIVED.getTime() + 120_000));
    assert.equal(claim.outcome, 'expired');
  });

  test('exporting the original needs a second named person', async () => {
    const id = await store('webhook', Buffer.from(JSON.stringify(CHARGE), 'utf8'));

    await assert.rejects(
      issueExport(pool, {
        request: exportRequest(id, { content: 'original' }),
        vault: VAULT,
        redact: REDACTOR,
        policy: DEFAULT_APPROVAL_POLICY,
        ttlMs: 60_000,
      }),
      (error: unknown) => {
        assert.ok(error instanceof UnapprovedExportError);
        assert.match(error.message, /second named approver/);
        return true;
      },
    );

    // And an approver who is the requester is one person named twice — the same rule a
    // write-off is measured against (ADR-0042), not a second one that could diverge.
    await assert.rejects(
      issueExport(pool, {
        request: exportRequest(id, {
          content: 'original',
          approvedBy: 'amaka@example.com',
          approvedAt: RECEIVED,
        }),
        vault: VAULT,
        redact: REDACTOR,
        ttlMs: 60_000,
      }),
      /cannot approve their own export/,
    );

    const approved = await issueExport(pool, {
      request: exportRequest(id, {
        content: 'original',
        approvedBy: 'chidi@example.com',
        approvedAt: RECEIVED,
      }),
      vault: VAULT,
      redact: REDACTOR,
      ttlMs: 60_000,
    });
    assert.equal(approved.content, 'original');
  });

  test('the database refuses an unapproved original export even without the engine', async () => {
    // A rogue script, bypassing every line of our code. Maker-checker on exports is a
    // constraint, not a convention — a control only application code enforces is a control
    // one refactor away from not existing.
    const id = await store('webhook', Buffer.from('{"reference":"W"}', 'utf8'));

    await assert.rejects(
      pool.query(
        `INSERT INTO evidence_exports
                (export_id, evidence_id, content, reason, requested_by, requested_at,
                 expires_at, archive, archive_nonce, archive_tag, archive_bytes)
         VALUES ($1, $2, 'original', 'because', 'amaka@example.com', now(), now(),
                 ''::bytea, ''::bytea, ''::bytea, 0)`,
        [unique(), id],
      ),
      /evidence_exports_original_needs_approval/,
    );
  });

  test('approval cannot conjure bytes that were destroyed on schedule', async () => {
    const id = await store('webhook', Buffer.from(JSON.stringify(CHARGE), 'utf8'));
    await runRetention(pool, { asOf: AFTER_WINDOW, vault: VAULT, redact: REDACTOR, apply: true });

    await assert.rejects(
      issueExport(pool, {
        request: exportRequest(id, {
          content: 'original',
          approvedBy: 'chidi@example.com',
          approvedAt: RECEIVED,
        }),
        vault: VAULT,
        redact: REDACTOR,
        ttlMs: 60_000,
      }),
      (error: unknown) => {
        assert.ok(error instanceof EvidenceUnavailableError);
        assert.match(error.message, /A second approver cannot restore it/);
        return true;
      },
    );
  });

  test('an export writes itself into the access log', async () => {
    const id = await store('webhook', Buffer.from('{"reference":"V"}', 'utf8'));
    await issueExport(pool, {
      request: exportRequest(id, { reason: 'NDPC subject access request' }),
      vault: VAULT,
      redact: REDACTOR,
      ttlMs: 60_000,
    });

    const log = await accessLog(pool, id);
    assert.equal(log.at(-1)?.action, 'export');
    assert.equal(log.at(-1)?.reason, 'NDPC subject access request');
  });
});
