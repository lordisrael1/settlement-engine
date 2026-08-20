/**
 * Taking a copy of a document out of the system.
 *
 * The one operation that ends with evidence somewhere this system cannot see, which is why
 * it is the one read that is maker-checked. A resolution moves money out of the books and
 * needs a second named approver (ADR-0042); an original export moves a customer's name and
 * email out of the estate, and needs the same. That is deliberately the *same* control
 * reading the *same* `ApprovalPolicy` rather than a second mechanism with its own threshold
 * and its own idea of what a second pair of eyes means — two controls to keep in step is one
 * to quietly diverge.
 *
 * Three properties are worth stating outright, because each is the reason for a piece of
 * machinery that would otherwise look like ceremony:
 *
 *   **Redacted by default.** Asking for an export gets the keep-list copy. The original
 *   requires the approver, so the expensive path is the one somebody had to choose.
 *
 *   **The archive is sealed under a key we do not keep.** Generated here, returned once in
 *   the response to the approved request, and never stored. So the stored archive is
 *   unreadable to the database, to a backup of it and to this service, and an export table
 *   does not quietly become a second copy of every document anybody ever exported.
 *
 *   **The link is short-lived and single-use.** The token is never stored — its SHA-256 is
 *   the export's identity — and collecting the archive empties it. When object storage
 *   arrives, this same contract moves to a bucket's signed URL and nothing above it changes
 *   (ADR-0066).
 */

import { createHash, randomBytes } from 'node:crypto';

import type { ApprovalPolicy, EvidenceContent, EvidenceExportRequest } from '@recon/canon';
import { DEFAULT_APPROVAL_POLICY, exportApprovalFailure } from '@recon/canon';
import type { Executor } from '@recon/ledger-core';
import { freshKey, sealWithKey } from '@recon/protect';

import { readEvidenceBytes, recordAccess, type EvidenceVault } from './evidence.js';

/**
 * Refused on the merits: no approver, no reason, or an approver who is the requester.
 *
 * Named so the API can answer 422 and return the message verbatim — the message is written
 * for the person who tripped the rule, and "422 Unprocessable Entity" teaches them nothing.
 */
export class UnapprovedExportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnapprovedExportError';
  }
}

/** The bytes asked for are not here — expired, purged, or reduced to a redacted copy. */
export class EvidenceUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EvidenceUnavailableError';
  }
}

export interface ExportOptions {
  readonly request: EvidenceExportRequest;
  readonly vault: EvidenceVault;
  readonly policy?: ApprovalPolicy;
  /**
   * Reduce a payload to its keep-list copy.
   *
   * Required, and required for a reason worth stating: a redacted export of a document
   * still inside its dispute window has to *be* redacted. Exporting the original bytes and
   * labelling them "redacted" because that is what was asked for would defeat the approval
   * gate entirely — anybody with `evidence.export` could take a customer's name and email
   * out of the system by asking for the version that does not need an approver.
   */
  readonly redact: (bytes: Buffer) => { bytes: Buffer; dropped: number };
  /** How long the link lives. Minutes, not days: a link valid for a week gets forwarded. */
  readonly ttlMs: number;
  readonly requestId?: string | null;
}

export interface IssuedExport {
  /** The SHA-256 of the token. Safe to log, safe to quote in a ticket. */
  readonly exportId: string;
  /**
   * The download token. Returned exactly once, here. Nothing stores it, so an export whose
   * token was lost is re-requested rather than recovered — which is the correct behaviour
   * for a credential.
   */
  readonly token: string;
  /** Base64. The only copy: decrypting the archive is impossible without it. */
  readonly archiveKey: string;
  readonly expiresAt: Date;
  readonly content: EvidenceContent;
  readonly byteLength: number;
}

/**
 * Approve, seal, and hand back a link.
 *
 * The read of the evidence and the record that it was read are in the caller's transaction,
 * so an export that is recorded is an export that happened and vice versa. There is no
 * ordering in which a document is copied out without a row saying so.
 */
export async function issueExport(
  db: Executor,
  options: ExportOptions,
): Promise<IssuedExport> {
  const policy = options.policy ?? DEFAULT_APPROVAL_POLICY;
  const { request } = options;

  const refusal = exportApprovalFailure(policy, request);
  if (refusal) throw new UnapprovedExportError(refusal);

  const held = await readEvidenceBytes(db, request.evidenceId, options.vault);
  if (!held) {
    throw new EvidenceUnavailableError(
      `Evidence ${request.evidenceId} has no bytes to export: its retention has run and the ` +
        `payload was destroyed. The record of the document — its hash, its lineage, its ` +
        `parser version and every conclusion drawn from it — is still here.`,
    );
  }

  if (request.content === 'original' && held.content !== 'original') {
    // Approval does not conjure bytes. Saying so precisely matters, because "the approver
    // signed off and the export came back redacted" is otherwise indistinguishable from a
    // bug in the approval path.
    throw new EvidenceUnavailableError(
      `Evidence ${request.evidenceId} is held as a redacted copy: its dispute window closed ` +
        `and the original was destroyed on schedule. A second approver cannot restore it. ` +
        `Request the redacted export instead.`,
    );
  }

  // Redacted was asked for and the document is still held whole, so reduce it now. This is
  // the line that makes "redacted by default" true rather than merely the default value of
  // a field.
  const exported =
    request.content === 'redacted' && held.content === 'original'
      ? options.redact(held.bytes).bytes
      : held.bytes;

  // Random, necessarily. Every other identifier in this system is derived so that a replay
  // produces the same value — and a download token that a replay could produce is a
  // download token an attacker can produce. The row's *identity* stays derived: it is the
  // hash of this token.
  const token = randomBytes(32).toString('base64url');
  const exportId = createHash('sha256').update(token).digest('hex');

  const archiveKey = freshKey();
  const archive = sealWithKey(archiveKey, exported, { export_id: exportId });
  const expiresAt = new Date(request.requestedAt.getTime() + options.ttlMs);

  await db.query(
    `INSERT INTO evidence_exports
            (export_id, evidence_id, content, reason, requested_by, requested_at,
             approved_by, approved_at, expires_at,
             archive, archive_nonce, archive_tag, archive_bytes)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
    [
      exportId,
      request.evidenceId,
      request.content,
      request.reason,
      request.requestedBy,
      request.requestedAt,
      request.approvedBy,
      request.approvedAt,
      expiresAt,
      archive.ciphertext,
      archive.nonce,
      archive.authTag,
      exported.byteLength,
    ],
  );

  await recordAccess(db, {
    evidenceId: request.evidenceId,
    principal: request.requestedBy,
    action: 'export',
    content: request.content,
    reason: request.reason,
    approvedBy: request.approvedBy,
    requestId: options.requestId ?? null,
    at: request.requestedAt,
  });

  return {
    exportId,
    token,
    archiveKey: archiveKey.toString('base64'),
    expiresAt,
    content: request.content,
    byteLength: exported.byteLength,
  };
}

export type ExportClaim =
  | {
      readonly outcome: 'delivered';
      readonly exportId: string;
      readonly evidenceId: string;
      readonly content: EvidenceContent;
      /** nonce ‖ tag ‖ ciphertext. AES-256-GCM, additional data `export_id=<exportId>`. */
      readonly archive: Buffer;
    }
  /** No such token. Deliberately the same answer as a token that never existed. */
  | { readonly outcome: 'unknown' }
  | { readonly outcome: 'expired'; readonly expiredAt: Date }
  | { readonly outcome: 'collected'; readonly collectedAt: Date };

/**
 * Collect the archive, once.
 *
 * Collecting empties the stored copy, so the export exists on our side for exactly as long
 * as it takes somebody to fetch it — which is the difference between a delivery mechanism
 * and an archive of everything anybody ever exported.
 *
 * A second attempt is told the export was already collected rather than being refused
 * anonymously. That is a deliberate leak of one bit: if a link has been used and the person
 * holding it did not use it, they need to know that today, not at the next audit.
 */
export async function claimExport(
  db: Executor,
  token: string,
  at: Date,
): Promise<ExportClaim> {
  const exportId = createHash('sha256').update(token).digest('hex');

  const found = await db.query<{
    evidence_id: string;
    content: EvidenceContent;
    expires_at: Date;
    fetched_at: Date | null;
    archive: Buffer;
    archive_nonce: Buffer;
    archive_tag: Buffer;
  }>(
    `SELECT evidence_id, content, expires_at, fetched_at, archive, archive_nonce, archive_tag
       FROM evidence_exports WHERE export_id = $1`,
    [exportId],
  );

  const row = found.rows[0];
  if (!row) return { outcome: 'unknown' };
  if (row.fetched_at !== null) return { outcome: 'collected', collectedAt: row.fetched_at };
  if (row.expires_at <= at) return { outcome: 'expired', expiredAt: row.expires_at };

  await db.query(
    `UPDATE evidence_exports
        SET fetched_at = $2, archive = ''::bytea, archive_nonce = ''::bytea,
            archive_tag = ''::bytea
      WHERE export_id = $1 AND fetched_at IS NULL`,
    [exportId, at],
  );

  return {
    outcome: 'delivered',
    exportId,
    evidenceId: row.evidence_id,
    content: row.content,
    archive: Buffer.concat([row.archive_nonce, row.archive_tag, row.archive]),
  };
}
