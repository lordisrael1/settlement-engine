import type { FastifyPluginCallback } from 'fastify';

import { DEFAULT_APPROVAL_POLICY } from '@recon/canon';
import { redact } from '@recon/protect';
import {
  accessLog,
  claimExport,
  evidenceAt,
  issueExport,
  readEvidenceBytes,
  recordAccess,
} from '@recon/reconciler';

import { principalOf, requireApiKey, requireGrant } from '../auth.js';
import type { Services } from '../services.js';

/**
 * Reading a document, and taking a copy of one away.
 *
 * Four endpoints, and the fact that they are four rather than one field on an existing
 * response is the design (ADR-0066). Before this, the only control in the system that
 * governed *reads* was the API key, and every control that did anything — the balance-zero
 * invariant, the append-only triggers, maker-checker on resolutions — governed writes.
 * Exfiltration is a read. It is invisible to every per-write check ever built, and it was
 * invisible here.
 *
 * So the four are separated by exactly what they hand over:
 *
 *   GET  /evidence/:id           metadata: who uploaded it, when, which parser.  No PII.
 *   GET  /evidence/:id/raw       the bytes. Needs `evidence.raw`. Logged with a reason.
 *   POST /evidence/:id/exports   a copy leaving the system. Maker-checked for originals.
 *   GET  /evidence/exports/:token  the sealed archive, once, before it expires.
 *
 * Every one of the last three writes a row to `evidence_access` naming the *verified*
 * principal. The alert that matters is not on any single request — each is legitimate — but
 * on the volume: one principal, many documents, a short window, which is what `accessVolume`
 * counts and what no per-request check can see.
 */
export const evidenceRoutes: FastifyPluginCallback<Services> = (app, services, done) => {
  const { pool, config, now } = services;

  // ── The archive collection, before authentication is added ────────────────
  //
  // Registered first and deliberately outside the API-key hook. The token *is* the
  // credential: it is single-use, short-lived, and the archive it returns is encrypted under
  // a key only the approved requester holds. Requiring a management key as well would mean
  // an export could only be collected by somebody who already had access to the system it
  // was exported from, which is very nearly the opposite of what an export is for.
  app.get<{ Params: { token: string } }>(
    '/evidence/exports/:token',
    {
      schema: {
        tags: ['Evidence'],
        operationId: 'collectExport',
        summary: 'Collect a sealed export, once',
        security: [{ exportToken: [] }],
      },
    },
    async (request, reply) => {
      const claim = await claimExport(pool, request.params.token, now());

      switch (claim.outcome) {
        case 'unknown':
          // The same answer a token that never existed gets. Guessing must learn nothing.
          return reply.code(404).send({ error: 'No such export.' });

        case 'expired':
          return reply.code(410).send({
            error:
              `This export expired at ${claim.expiredAt.toISOString()}. Request another; ` +
              `a link that outlives its errand is a link somebody forwards.`,
          });

        case 'collected':
          // A deliberate leak of one bit. If a link has been used and the person holding it
          // did not use it, they need to know today rather than at the next audit.
          return reply.code(410).send({
            error:
              `This export was collected at ${claim.collectedAt.toISOString()} and each one ` +
              `may be collected once. If that was not you, treat the link as compromised.`,
          });

        case 'delivered':
          await recordAccess(pool, {
            evidenceId: claim.evidenceId,
            // Whoever holds the token. There is no better name available, and inventing one
            // would put a principal in the audit log who was not authenticated.
            principal: `export:${claim.exportId.slice(0, 16)}`,
            action: 'read_raw',
            content: claim.content,
            reason: 'export collected',
            requestId: request.id,
            at: now(),
          });

          return reply
            .code(200)
            .header('content-type', 'application/octet-stream')
            .header(
              'content-disposition',
              `attachment; filename="evidence-${claim.evidenceId.slice(0, 16)}.recon-archive"`,
            )
            // nonce ‖ tag ‖ ciphertext. AES-256-GCM under the key returned once when the
            // export was approved, with the export id as additional data — so this file is
            // useless to a proxy, a browser cache, or anybody it is forwarded to.
            .send(claim.archive);
      }
    },
  );

  // Everything below needs a management key.
  app.register((scope, _options, ready) => {
    scope.addHook('onRequest', requireApiKey(config));

    // ── Metadata ──────────────────────────────────────────────────────────────
    //
    // The cheap, ordinary case, and the one that answers most audit questions: which file,
    // who uploaded it, when, which parser version read it, and whether its bytes are still
    // here. No grant, because there is no personal data in any of it.
    scope.get<{ Params: { id: string } }>(
      '/evidence/:id',
      {
        schema: {
          tags: ['Evidence'],
          operationId: 'evidence',
          summary: 'Document metadata and its access log',
          description: 'No grant required: there is no personal data in any of it.',
        },
      },
      async (request, reply) => {
      const record = await evidenceAt(pool, request.params.id);
      if (!record) return reply.code(404).send({ error: 'No such evidence.' });

      await recordAccess(pool, {
        evidenceId: record.evidenceId,
        principal: principalOf(request).name,
        action: 'read_metadata',
        requestId: request.id,
        at: now(),
      });

      return {
        evidenceId: record.evidenceId,
        kind: record.kind,
        source: record.source,
        filename: record.filename,
        byteLength: record.byteLength,
        receivedFrom: record.receivedFrom,
        receivedAt: record.receivedAt.toISOString(),
        parserVersion: record.parserVersion,
        storageLocation: record.storageLocation,
        // What is held of the bytes right now, said plainly. "Purged on schedule" and "we
        // cannot find it" are different answers that lead to very different conversations.
        held: record.purgedAt
          ? { content: null, purgedAt: record.purgedAt.toISOString() }
          : { content: record.content, purgeAfter: record.purgeAfter?.toISOString() ?? null },
        access: (await accessLog(pool, record.evidenceId)).map((entry) => ({
          principal: entry.principal,
          action: entry.action,
          content: entry.content,
          reason: entry.reason,
          approvedBy: entry.approvedBy,
          at: entry.at.toISOString(),
          })),
        };
      },
    );

    // ── The bytes ─────────────────────────────────────────────────────────────
    //
    // Its own endpoint rather than a field on the response above, which is the whole point:
    // a separate route is separately authorised, separately logged, and separately
    // rate-limited by whatever sits in front of it. A `?include=raw` parameter would have
    // been none of those things.
    scope.get<{ Params: { id: string }; Querystring: { reason?: string } }>(
      '/evidence/:id/raw',
      {
        onRequest: requireGrant('evidence.raw'),
        schema: {
          tags: ['Evidence'],
          operationId: 'evidenceRaw',
          summary: 'The bytes of a document',
          description:
            'Its own endpoint rather than a field on the metadata response, which is the whole ' +
            'point: a separate route is separately authorised, separately logged, and ' +
            'separately rate-limited. A `?include=raw` parameter would have been none of those.',
        },
      },
      async (request, reply) => {
        const reason = (request.query.reason ?? '').trim();
        if (reason === '') {
          return reply.code(400).send({
            error:
              'A `reason` is required. An access record with a name and no reason answers ' +
              'half the question an auditor asks, and this endpoint exists to answer the ' +
              'other half.',
          });
        }

        const record = await evidenceAt(pool, request.params.id);
        if (!record) return reply.code(404).send({ error: 'No such evidence.' });

        const held = await readEvidenceBytes(pool, request.params.id, config.vault);
        if (!held) {
          return reply.code(410).send({
            error:
              `The bytes of ${record.evidenceId} were destroyed on schedule` +
              `${record.purgedAt ? ` at ${record.purgedAt.toISOString()}` : ''}. The record ` +
              `of the document — its hash, its lineage, its parser version, and every ` +
              `conclusion drawn from it — is still here (ADR-0065).`,
          });
        }

        await recordAccess(pool, {
          evidenceId: record.evidenceId,
          principal: principalOf(request).name,
          action: 'read_raw',
          content: held.content,
          reason,
          requestId: request.id,
          at: now(),
        });

        return reply
          .code(200)
          .header('content-type', 'application/octet-stream')
          // The one header that stops a redacted copy from being presented, six months from
          // now, as the bytes the provider sent.
          .header('x-recon-evidence-content', held.content)
          .header('x-recon-hash-matches-id', String(held.hashMatchesId))
          .send(held.bytes);
      },
    );

    // ── Export ────────────────────────────────────────────────────────────────
    //
    // Redacted by default. The original needs a second named approver — the same
    // `ApprovalPolicy` a write-off is measured against (ADR-0042), extended rather than
    // duplicated, because two controls with two thresholds is one control that quietly
    // diverges.
    scope.post<{ Params: { id: string }; Body: ExportBody }>(
      '/evidence/:id/exports',
      {
        onRequest: requireGrant('evidence.export'),
        schema: {
          body: EXPORT_SCHEMA,
          tags: ['Evidence'],
          operationId: 'issueExport',
          summary: 'Take a copy out of the system',
          description:
            'Redacted by default. The original needs a second named approver — the same policy ' +
            'a write-off is measured against (ADR-0042), extended rather than duplicated, ' +
            'because two controls with two thresholds is one control that quietly diverges.',
        },
      },
      async (request, reply) => {
        const principal = principalOf(request);
        const at = now();
        const approved = request.body.approvedBy ?? null;

        const issued = await issueExport(pool, {
          request: {
            evidenceId: request.params.id,
            // Redacted unless the caller asks for the original *and* brings an approver.
            content: request.body.content ?? 'redacted',
            reason: request.body.reason,
            // The verified principal, never a name from the body. A requester who could
            // name themselves could also name somebody else as the approver's counterpart,
            // and maker-checker would be two fields on a form.
            requestedBy: principal.name,
            requestedAt: at,
            approvedBy: approved,
            approvedAt: approved === null ? null : at,
          },
          vault: config.vault,
          // The same keep-list the inbox drain and the retention command run, so a redacted
          // export is redacted by the same rules that redact everything else.
          redact,
          policy: DEFAULT_APPROVAL_POLICY,
          ttlMs: config.exportTtlMs,
          requestId: request.id,
        });

        return reply.code(201).send({
          exportId: issued.exportId,
          content: issued.content,
          byteLength: issued.byteLength,
          expiresAt: issued.expiresAt.toISOString(),
          // Both returned exactly once. Nothing stores either, so an export whose link or
          // key was lost is re-requested rather than recovered — which is correct for a
          // credential and correct for a copy of somebody's personal data.
          url: `/evidence/exports/${issued.token}`,
          archiveKey: issued.archiveKey,
          archiveFormat: 'aes-256-gcm; nonce(12) ‖ tag(16) ‖ ciphertext; aad=export_id',
        });
      },
    );

    ready();
  });

  done();
};

interface ExportBody {
  readonly reason: string;
  readonly content?: 'original' | 'redacted';
  readonly approvedBy?: string;
}

/**
 * Transport validation only: shapes and types. Whether this export needs an approver, and
 * whether the person named may be the one asking, are the engine's questions — answered by
 * `exportApprovalFailure` and by a database constraint, so that this route, the CLI and a
 * future dashboard cannot each have a slightly different idea (ADR-0054).
 */
const EXPORT_SCHEMA = {
  type: 'object',
  required: ['reason'],
  additionalProperties: false,
  properties: {
    reason: { type: 'string', minLength: 1, maxLength: 2000 },
    content: { type: 'string', enum: ['original', 'redacted'] },
    approvedBy: { type: 'string', minLength: 1, maxLength: 200 },
  },
} as const;
