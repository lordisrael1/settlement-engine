/**
 * Evidence: writing it down, reading it back, expiring it, and recording who looked.
 *
 * Split out of `store.ts` when the bytes moved out of `evidence` and into `evidence_blobs`,
 * because what used to be one insert is now four operations with genuinely different rules —
 * one of which deletes things, which no other file in this package does.
 *
 * The shape of every function here follows from one decision (ADR-0063): **the database
 * never holds plaintext evidence and never holds key material.** So `recordEvidence` takes
 * a key ring rather than a flag, `readEvidenceBytes` can fail in a way a `SELECT` cannot,
 * and `runRetention` is the only writer that is allowed to destroy anything — which is why
 * it is a command an operator runs rather than a background thread nobody watches.
 */

import type {
  Evidence,
  EvidenceAccessAction,
  EvidenceContent,
  EvidenceKind,
  RetentionSchedule,
  SourceId,
} from '@recon/canon';
import { purgeAfter, reducible } from '@recon/canon';
import type { Executor } from '@recon/ledger-core';
import { appendEvent, inTransaction } from '@recon/ledger-core';
import type { KeyRing, Sealed } from '@recon/protect';
import { seal, unseal } from '@recon/protect';

import type { Stored } from './store.js';

/**
 * What a deployable brings to every evidence operation: somewhere to get keys, and a
 * schedule.
 *
 * Both are arguments rather than module state for the same reason the clock is (ADR-0007) —
 * a test has to be able to run two retention schedules in one process, and a deployment has
 * to be able to hand a KMS-backed key ring to the service and a differently-scoped one to
 * the CLI.
 */
export interface EvidenceVault {
  readonly keyRing: KeyRing;
  readonly retention: RetentionSchedule;
}

/** The additional authenticated data every evidence blob is sealed under. */
const contextOf = (evidenceId: string): Record<string, string> => ({ evidence_id: evidenceId });

// ── Writing ─────────────────────────────────────────────────────────────────

/**
 * Record the file a batch of records came from, and seal its bytes.
 *
 * There is deliberately no way to call this with plaintext that ends up in a column: `raw`
 * is encrypted here or not stored at all. That is the difference between a policy and a
 * property — a future call site cannot forget to encrypt, because there is no unencrypted
 * path to forget.
 *
 * Content-addressed, so re-uploading the same export is resolved by the primary key rather
 * than by remembering. A second upload of a file whose blob has already been redacted or
 * purged does **not** restore it: the evidence row is the identity and it already exists,
 * and quietly resurrecting bytes a retention schedule deleted would make the schedule a
 * suggestion.
 */
export async function recordEvidence(
  db: Executor,
  evidence: Evidence,
  raw: Buffer | null,
  vault: EvidenceVault,
): Promise<Stored> {
  const result = await db.query(
    `INSERT INTO evidence
            (evidence_id, kind, source, filename, byte_length, received_from,
             received_at, parser_version, storage_location)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (evidence_id) DO NOTHING`,
    [
      evidence.evidenceId,
      evidence.kind,
      evidence.source,
      evidence.filename,
      evidence.byteLength,
      evidence.receivedFrom,
      evidence.receivedAt,
      evidence.parserVersion,
      evidence.storageLocation,
    ],
  );

  const stored = result.rowCount ?? 0;

  if (stored > 0 && raw !== null) {
    const sealed = await seal(vault.keyRing, raw, contextOf(evidence.evidenceId));
    await db.query(
      `INSERT INTO evidence_blobs
              (evidence_id, ciphertext, nonce, auth_tag, key_id, wrapped_key,
               content, byte_length, sealed_at, purge_after)
       VALUES ($1, $2, $3, $4, $5, $6, 'original', $7, $8, $9)
       ON CONFLICT (evidence_id) DO NOTHING`,
      [
        evidence.evidenceId,
        sealed.ciphertext,
        sealed.nonce,
        sealed.authTag,
        sealed.keyId,
        sealed.wrappedKey,
        raw.byteLength,
        evidence.receivedAt,
        purgeAfter(vault.retention, evidence.kind, 'original', evidence.receivedAt),
      ],
    );
  }

  return { stored, duplicates: 1 - stored };
}

// ── Reading ─────────────────────────────────────────────────────────────────

/** Everything about a document except its bytes. The answer to most audit questions. */
export interface EvidenceRecord {
  readonly evidenceId: string;
  readonly kind: EvidenceKind;
  readonly source: SourceId;
  readonly filename: string | null;
  readonly byteLength: number;
  readonly storageLocation: string | null;
  readonly receivedFrom: string;
  readonly receivedAt: Date;
  readonly parserVersion: string;
  /** What is held of the bytes right now — and `null` once nothing is. */
  readonly content: EvidenceContent | null;
  readonly purgeAfter: Date | null;
  readonly purgedAt: Date | null;
}

export async function evidenceAt(db: Executor, id: string): Promise<EvidenceRecord | null> {
  const result = await db.query<{
    evidence_id: string;
    kind: EvidenceKind;
    source: string;
    filename: string | null;
    byte_length: number;
    storage_location: string | null;
    received_from: string;
    received_at: Date;
    parser_version: string;
    content: EvidenceContent | null;
    purge_after: Date | null;
    purged_at: Date | null;
  }>(
    `SELECT e.evidence_id, e.kind, e.source, e.filename, e.byte_length, e.storage_location,
            e.received_from, e.received_at, e.parser_version,
            b.content, b.purge_after, b.purged_at
       FROM evidence e
       LEFT JOIN evidence_blobs b ON b.evidence_id = e.evidence_id
      WHERE e.evidence_id = $1`,
    [id],
  );

  const row = result.rows[0];
  return row
    ? {
        evidenceId: row.evidence_id,
        kind: row.kind,
        source: row.source,
        filename: row.filename,
        byteLength: row.byte_length,
        storageLocation: row.storage_location,
        receivedFrom: row.received_from,
        receivedAt: row.received_at,
        parserVersion: row.parser_version,
        content: row.purged_at === null ? row.content : null,
        purgeAfter: row.purge_after,
        purgedAt: row.purged_at,
      }
    : null;
}

export interface EvidenceBytes {
  readonly bytes: Buffer;
  /** Whether these are the bytes that arrived, or the keep-list copy that replaced them. */
  readonly content: EvidenceContent;
  /** True only for an original: a redacted copy does not hash to the evidence id. */
  readonly hashMatchesId: boolean;
}

/**
 * The bytes, decrypted.
 *
 * `null` for a document whose blob is gone, which is a legitimate and expected answer
 * rather than an error: a retention schedule ran, the record says so, and the caller's job
 * is to say "purged on 4 March" instead of "not found". Confusing the two would make an
 * expired document look like a missing one, and those lead to very different conversations.
 *
 * This function does **not** write the access log. Reading and recording the read are
 * separated on purpose — the recorder needs a principal and a reason, which is knowledge
 * this layer does not have and must not invent (ADR-0066).
 */
export async function readEvidenceBytes(
  db: Executor,
  id: string,
  vault: EvidenceVault,
): Promise<EvidenceBytes | null> {
  const result = await db.query<{
    ciphertext: Buffer;
    nonce: Buffer;
    auth_tag: Buffer;
    key_id: string;
    wrapped_key: Buffer;
    content: EvidenceContent;
    purged_at: Date | null;
  }>(
    `SELECT ciphertext, nonce, auth_tag, key_id, wrapped_key, content, purged_at
       FROM evidence_blobs WHERE evidence_id = $1`,
    [id],
  );

  const row = result.rows[0];
  if (!row || row.purged_at !== null) return null;

  const sealed: Sealed = {
    ciphertext: row.ciphertext,
    nonce: row.nonce,
    authTag: row.auth_tag,
    keyId: row.key_id,
    wrappedKey: row.wrapped_key,
  };

  const bytes = await unseal(vault.keyRing, sealed, contextOf(id));
  return { bytes, content: row.content, hashMatchesId: row.content === 'original' };
}

// ── The visitors' book ──────────────────────────────────────────────────────

export interface EvidenceAccess {
  readonly evidenceId: string;
  /** The verified principal. Never a name a caller supplied about itself (ADR-0066). */
  readonly principal: string;
  readonly action: EvidenceAccessAction;
  readonly content?: EvidenceContent | null;
  readonly reason?: string | null;
  readonly approvedBy?: string | null;
  readonly requestId?: string | null;
  readonly at: Date;
}

/**
 * Write down that somebody looked.
 *
 * Called after the read succeeds rather than before it, so the log records what happened
 * and not what was attempted — a refusal is the service log's business, and mixing the two
 * would make "how many times was this document read?" an unanswerable question.
 */
export async function recordAccess(db: Executor, access: EvidenceAccess): Promise<void> {
  await db.query(
    `INSERT INTO evidence_access
            (evidence_id, principal, action, content, reason, approved_by, request_id, at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      access.evidenceId,
      access.principal,
      access.action,
      access.content ?? null,
      access.reason ?? null,
      access.approvedBy ?? null,
      access.requestId ?? null,
      access.at,
    ],
  );
}

export interface AccessRecord extends EvidenceAccess {
  readonly accessId: string;
}

/** Everything that has been done to one document, oldest first. */
export async function accessLog(db: Executor, evidenceId: string): Promise<AccessRecord[]> {
  const result = await db.query<{
    access_id: string;
    evidence_id: string;
    principal: string;
    action: EvidenceAccessAction;
    content: EvidenceContent | null;
    reason: string | null;
    approved_by: string | null;
    request_id: string | null;
    at: Date;
  }>(
    `SELECT access_id::text, evidence_id, principal, action, content, reason,
            approved_by, request_id, at
       FROM evidence_access WHERE evidence_id = $1 ORDER BY access_id`,
    [evidenceId],
  );

  return result.rows.map((row) => ({
    accessId: row.access_id,
    evidenceId: row.evidence_id,
    principal: row.principal,
    action: row.action,
    content: row.content,
    reason: row.reason,
    approvedBy: row.approved_by,
    requestId: row.request_id,
    at: row.at,
  }));
}

/**
 * How much each principal read in a window.
 *
 * The query an alert runs, and the reason the access log exists at all. The signature of
 * exfiltration is one principal reading many documents in a short time, and every
 * individual request in that pattern is legitimate — so no per-request check can see it,
 * and only a count over a window can.
 */
export async function accessVolume(
  db: Executor,
  window: { from: Date; to: Date },
): Promise<{ principal: string; action: EvidenceAccessAction; documents: number }[]> {
  const result = await db.query<{ principal: string; action: EvidenceAccessAction; documents: string }>(
    `SELECT principal, action, COUNT(DISTINCT evidence_id)::text AS documents
       FROM evidence_access
      WHERE at >= $1 AND at < $2 AND action IN ('read_raw', 'export')
      GROUP BY principal, action
      ORDER BY COUNT(DISTINCT evidence_id) DESC`,
    [window.from, window.to],
  );

  return result.rows.map((row) => ({
    principal: row.principal,
    action: row.action,
    documents: Number(row.documents),
  }));
}

// ── Retention ───────────────────────────────────────────────────────────────

export interface RetentionOptions {
  /** The clock, as an argument. A retention run must be replayable to the same answer. */
  readonly asOf: Date;
  readonly vault: EvidenceVault;
  /** Reduce a provider payload to its keep-list copy. Supplied by the deployable. */
  readonly redact: (bytes: Buffer) => { bytes: Buffer; dropped: number };
  /**
   * Write. **Defaults to false**, and that default is the design: a command that deletes
   * financial evidence should have to be asked twice, and an operator should be able to see
   * what a run would do before it does it.
   */
  readonly apply?: boolean;
  readonly limit?: number;
}

export interface RetentionAction {
  readonly evidenceId: string;
  readonly kind: EvidenceKind;
  readonly from: EvidenceContent;
  readonly to: EvidenceContent | 'purged';
  readonly dueSince: Date;
}

export interface RetentionReport {
  readonly applied: boolean;
  /** Provider payloads whose originals are due to be replaced by a keep-list copy. */
  readonly redacted: readonly RetentionAction[];
  /** Documents at the end of their retention, whose bytes are due to be destroyed. */
  readonly purged: readonly RetentionAction[];
  /**
   * Documents this run could not move, and why.
   *
   * Reported rather than thrown, for the same reason the inbox drain works one delivery per
   * transaction: a single document whose blob will not decrypt — a retired key dropped from
   * configuration, a row somebody edited — must not stop every other document's retention.
   * A run that aborts on the first failure is a run that quietly stops running.
   */
  readonly failed: readonly { readonly evidenceId: string; readonly reason: string }[];
}

/**
 * Move every document to the state its retention schedule says it should be in.
 *
 * Two transitions, in this order, because the first produces work for the second on a later
 * run and never on the same one:
 *
 *   `original` → `redacted`   a provider payload past its dispute window
 *   anything   → purged       a document at the end of its retention
 *
 * Each document is its own transaction: a run interrupted halfway has redacted some
 * documents and not others, which is a correct intermediate state, whereas a run that
 * batched them would roll back a hundred completed redactions because the hundred-and-first
 * failed to decrypt.
 *
 * Every transition appends an `EvidencePurged` event in the same transaction, so the
 * destruction is part of the same narrative as everything else that happened to the money —
 * a deletion nobody can see is indistinguishable from a deletion nobody performed.
 */
export async function runRetention(
  db: import('pg').Pool,
  options: RetentionOptions,
): Promise<RetentionReport> {
  const apply = options.apply ?? false;
  const limit = options.limit ?? 500;

  const due = await db.query<{
    evidence_id: string;
    kind: EvidenceKind;
    content: EvidenceContent;
    purge_after: Date;
  }>(
    `SELECT b.evidence_id, e.kind, b.content, b.purge_after
       FROM evidence_blobs b
       JOIN evidence e ON e.evidence_id = b.evidence_id
      WHERE b.purged_at IS NULL AND b.purge_after <= $1
      ORDER BY b.purge_after
      LIMIT $2`,
    [options.asOf, limit],
  );

  const redacted: RetentionAction[] = [];
  const purged: RetentionAction[] = [];
  const failed: { evidenceId: string; reason: string }[] = [];

  for (const row of due.rows) {
    // A provider payload past its dispute window loses the customer and keeps its meaning.
    // A settlement export or a bank statement is the financial record itself and is never
    // reduced — it is kept whole until the end of its retention, then destroyed (ADR-0065).
    const reduce = reducible(row.kind) && row.content === 'original';

    const action: RetentionAction = {
      evidenceId: row.evidence_id,
      kind: row.kind,
      from: row.content,
      to: reduce ? 'redacted' : 'purged',
      dueSince: row.purge_after,
    };

    if (apply) {
      try {
        if (reduce) await reduceOne(db, row.evidence_id, row.kind, options);
        else await purgeOne(db, row.evidence_id, row.content, options.asOf);
      } catch (error) {
        failed.push({
          evidenceId: row.evidence_id,
          reason: error instanceof Error ? error.message : String(error),
        });
        continue;
      }
    }

    (reduce ? redacted : purged).push(action);
  }

  return { applied: apply, redacted, purged, failed };
}

async function reduceOne(
  db: import('pg').Pool,
  evidenceId: string,
  kind: EvidenceKind,
  options: RetentionOptions,
): Promise<void> {
  await inTransaction(db, async (client) => {
    const current = await readEvidenceBytes(client, evidenceId, options.vault);
    if (!current || current.content !== 'original') return;

    const reduced = options.redact(current.bytes);
    const sealed = await seal(options.vault.keyRing, reduced.bytes, contextOf(evidenceId));

    await client.query(
      `UPDATE evidence_blobs
          SET ciphertext = $2, nonce = $3, auth_tag = $4, key_id = $5, wrapped_key = $6,
              content = 'redacted', byte_length = $7, sealed_at = $8, purge_after = $9
        WHERE evidence_id = $1`,
      [
        evidenceId,
        sealed.ciphertext,
        sealed.nonce,
        sealed.authTag,
        sealed.keyId,
        sealed.wrappedKey,
        reduced.bytes.byteLength,
        options.asOf,
        purgeAfter(options.vault.retention, kind, 'redacted', options.asOf),
      ],
    );

    await appendEvent(client, {
      type: 'EvidencePurged',
      subject: evidenceId,
      // Distinguishes this from the purge that will follow years later. Derived from the
      // transition, never from a clock, so a replay produces the same log.
      occurrence: 'original',
      occurredAt: options.asOf,
      recordedAt: options.asOf,
      detail: {
        from: 'original',
        to: 'redacted',
        dropped_fields: reduced.dropped,
        // The hash of the original stays on the evidence row and stays true. Said here too,
        // because this event is the last place anybody looks before asking whether the
        // original can be produced.
        original_hash_retained: true,
      },
    });
  });
}

async function purgeOne(
  db: import('pg').Pool,
  evidenceId: string,
  from: EvidenceContent,
  at: Date,
): Promise<void> {
  await inTransaction(db, async (client) => {
    const result = await client.query(
      // The row stays and the bytes go. A deleted row would leave no record that there had
      // ever been anything to delete, which is the one thing a purge must not do.
      `UPDATE evidence_blobs
          SET ciphertext = ''::bytea, wrapped_key = ''::bytea, nonce = ''::bytea,
              auth_tag = ''::bytea, byte_length = 0, purged_at = $2
        WHERE evidence_id = $1 AND purged_at IS NULL`,
      [evidenceId, at],
    );
    if ((result.rowCount ?? 0) === 0) return;

    await appendEvent(client, {
      type: 'EvidencePurged',
      subject: evidenceId,
      occurrence: from,
      occurredAt: at,
      recordedAt: at,
      detail: { from, to: 'purged', original_hash_retained: true },
    });
  });
}
