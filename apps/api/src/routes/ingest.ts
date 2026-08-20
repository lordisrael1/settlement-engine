import type { FastifyPluginCallback } from 'fastify';

import type { IngestAnomaly } from '@recon/canon';
import { anomalySeverity, isDegraded } from '@recon/canon';
import { ingestBankStatement, ingestSettlement } from '@recon/ingest';
import {
  clearConformed,
  recordAnomalies,
  recordBankLines,
  recordEvidence,
  recordPayouts,
  recordSettlementLines,
} from '@recon/reconciler';

import { principalOf, requireApiKey } from '../auth.js';
import { asMoney } from '../serialise.js';
import type { Services } from '../services.js';

/**
 * The two slow rails: what a PSP says it is sending, and what our bank says arrived.
 *
 * These take a **file**, as bytes, in the request body — not a JSON array of records. The
 * bytes are the evidence, their SHA-256 is the evidence's identity, and a client that
 * re-shaped an export into JSON before sending it has destroyed the only artifact anybody
 * can check a conclusion against six months later (ADR-0033).
 *
 * Neither endpoint reconciles anything. Stage two and stage three run on
 * `POST /reconcile/runs`, and keeping the upload separate from the matching is what lets a
 * statement land at 04:00 and be reconciled at 09:00 against three PSP reports that arrived
 * in between — rather than three times, once per upload, each against whatever had turned up
 * so far.
 *
 * Both are idempotent by content address: re-uploading the same export stores the evidence
 * once and reports every row as a duplicate, which is why re-sending a file after a failed
 * parse costs nothing.
 *
 * The bytes are encrypted on the way into `evidence_blobs` and there is no path that stores
 * them otherwise (ADR-0063), and a file carrying a card number is refused by the ingest
 * boundary before an evidence record exists — so there is never a row anybody has to go and
 * delete (ADR-0066). `receivedFrom` is the verified principal now, not a name the caller
 * supplied about itself.
 */
export const ingestRoutes: FastifyPluginCallback<Services> = (app, services, done) => {
  const { pool, config, now } = services;

  app.addHook('onRequest', requireApiKey(config));

  // Uploads are bytes, whatever content type they arrive under: CSV, JSON, OFX, XLSX. As in
  // the webhook plugin, this parser is scoped here and the built-ins are removed first so
  // that a settlement export declaring `application/json` is not parsed into an object and
  // its bytes lost.
  app.removeAllContentTypeParsers();
  app.addContentTypeParser('*', { parseAs: 'buffer' }, (_request, body: Buffer, next) => {
    next(null, body);
  });

  app.post<{ Params: { source: string }; Querystring: { filename?: string } }>(
    '/ingest/settlement/:source',
    {
      bodyLimit: config.limits.uploadBytes,
      schema: {
        tags: ['Ingest'],
        operationId: 'ingestSettlement',
        summary: 'Upload a PSP settlement export',
        description:
          'Stores the file as evidence and the records it yields. Books nothing. Idempotent ' +
          'by content address: re-uploading the same export stores the evidence once and ' +
          'reports every row as a duplicate, which is why re-sending after a failed parse ' +
          'costs nothing.',
      },
    },
    async (request, reply) => {
      const bytes = bodyOf(request.body);
      if (bytes.byteLength === 0) {
        return reply.code(400).send({ error: 'The request body is the settlement file itself.' });
      }

      // Throws `UnknownSourceError` (404) or `NoSettlementAdapterError` (501). The second is
      // the honest answer for Paystack: no sanitized export has pinned its column layout, so
      // there is no parser, and inventing one produces a parser that looks right and books
      // the wrong amounts (ADR-0025).
      const result = ingestSettlement(request.params.source, bytes, {
        merchantId: config.merchantId,
        filename: request.query.filename ?? null,
        receivedFrom: principalOf(request).name,
        receivedAt: now(),
      });

      await recordEvidence(pool, result.evidence, bytes, config.vault);
      const payouts = await recordPayouts(pool, result.payouts);
      const lines = await recordSettlementLines(pool, result.lines);
      const drift = await noteDrift(services, request.params.source, result, now());

      return reply.code(201).send({
        evidenceId: result.evidence.evidenceId,
        format: result.format,
        parserVersion: result.evidence.parserVersion,
        payouts: {
          ...payouts,
          reported: result.payouts.map((payout) => ({
            payoutReference: payout.payoutReference,
            gross: asMoney(payout.gross),
            expectedNet: asMoney(payout.expectedNet),
            adjustments: payout.adjustments.map((adjustment) => ({
              kind: adjustment.kind,
              amount: asMoney(adjustment.amount),
              narration: adjustment.narration,
            })),
          })),
        },
        lines,
        // Rows the parser refused, kept in the response rather than swallowed: a row
        // rejected in silence is money that vanished between two systems that each believe
        // the other has it.
        rejected: result.rejected,
        ...drift,
        // Said plainly, because the reflex of every reader is that a settlement report is
        // money. It is a claim by a party with an interest in the answer (ADR-0027).
        booked: 'nothing — a PSP report is a claim, and only bank evidence books cash',
      });
    },
  );

  app.post<{ Querystring: { filename?: string; account?: string; bank?: string } }>(
    '/ingest/bank',
    {
      bodyLimit: config.limits.uploadBytes,
      schema: {
        tags: ['Ingest'],
        operationId: 'ingestBankStatement',
        summary: 'Upload a bank statement',
        description:
          'The only evidence that can book cash. Debits are kept: a returned payout and a ' +
          'chargeback both arrive as debits, and a parser that filtered them out would make ' +
          'the two most alarming bank events invisible.',
      },
    },
    async (request, reply) => {
      const bytes = bodyOf(request.body);
      if (bytes.byteLength === 0) {
        return reply.code(400).send({ error: 'The request body is the statement file itself.' });
      }

      const result = ingestBankStatement(bytes, {
        bankAccountId: request.query.account ?? config.bankAccountId,
        bank: request.query.bank ?? config.bank,
        filename: request.query.filename ?? null,
        receivedFrom: principalOf(request).name,
        receivedAt: now(),
      });

      await recordEvidence(pool, result.evidence, bytes, config.vault);
      const lines = await recordBankLines(pool, result.lines);
      const drift = await noteDrift(
        services,
        request.query.bank ?? config.bank,
        result,
        now(),
      );

      return reply.code(201).send({
        evidenceId: result.evidence.evidenceId,
        format: result.format,
        parserVersion: result.evidence.parserVersion,
        lines,
        rejected: result.rejected,
        ...drift,
        booked: 'nothing yet — run POST /reconcile/runs; this is the only evidence that can',
      });
    },
  );

  done();
};

/**
 * Record what this file drifted, clear what it no longer does, and say so in the response.
 *
 * The file is admitted either way. Nothing here rejects, nothing changes a status code, and
 * whatever parsed has already been stored by the time this runs — a bank that added a column
 * must not stop the morning's reconciliation, and row isolation is already the rule one layer
 * down (a mangled row must not cost us the other four thousand nine hundred and ninety-nine).
 * What changes is that the response now distinguishes itself from a quiet Tuesday's, and that
 * the distinction outlives the response.
 *
 * `clearConformed` runs on every upload, not only clean ones, and is scoped to this source.
 * That is what makes the queue self-clearing (ADR-0044): a provider who fixed their own bad
 * afternoon costs nobody a click, and the proportion that close this way is the number that
 * says whether the thresholds are tuned or merely loud.
 */
async function noteDrift(
  services: Services,
  source: string,
  result: { readonly anomalies: readonly IngestAnomaly[] },
  at: Date,
): Promise<Record<string, unknown>> {
  const outcome = await recordAnomalies(services.pool, result.anomalies);
  const cleared = await clearConformed(
    services.pool,
    source,
    result.anomalies.map((anomaly) => anomaly.key),
    at,
  );

  if (result.anomalies.length === 0 && cleared.length === 0) return {};

  return {
    drift: {
      raised: outcome.raised,
      recurring: outcome.recurring,
      // Kept distinct from `raised` because it is the more alarming of the two: a drift that
      // resolved and has come back is a provider changing their mind, not a provider changing
      // their format, and the two want different conversations.
      reopened: outcome.reopened,
      cleared,
      observed: result.anomalies.map((anomaly) => ({
        key: anomaly.key,
        kind: anomaly.kind,
        detail: anomaly.detail,
        occurrences: anomaly.occurrences,
        rowsInFile: anomaly.rowsInFile,
        firstSeenAt: anomaly.firstSeenAt,
        sample: anomaly.sample,
        severity: anomalySeverity(anomaly),
      })),
    },
    // The one field a caller can branch on without understanding any of the above. A cron job
    // that checks nothing else should still be able to tell that this 201 is not the usual
    // one.
    ...(isDegraded(result.anomalies)
      ? {
          degraded:
            `this file did not match the format this parser knows — it was accepted and ` +
            `whatever parsed was stored, but see drift.observed before trusting the totals`,
        }
      : {}),
  };
}

function bodyOf(body: unknown): Buffer {
  return Buffer.isBuffer(body) ? body : Buffer.alloc(0);
}
