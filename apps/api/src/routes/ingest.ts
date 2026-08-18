import type { FastifyPluginCallback } from 'fastify';

import { ingestBankStatement, ingestSettlement } from '@recon/ingest';
import {
  recordBankLines,
  recordEvidence,
  recordPayouts,
  recordSettlementLines,
} from '@recon/reconciler';

import { operatorOf, requireApiKey } from '../auth.js';
import { asMoney } from '../serialise.js';
import type { Services } from '../services.js';

/**
 * The two slow rails: what a PSP says it is sending, and what our bank says arrived.
 *
 * These take a **file**, as bytes, in the request body — not a JSON array of records. The
 * bytes are the evidence, their SHA-256 is the evidence's identity, and a client that
 * re-shaped an export into JSON before sending it has destroyed the only artifact anybody
 * can check a conclusion against six months later (D-033).
 *
 * Neither endpoint reconciles anything. Stage two and stage three run on
 * `POST /reconcile/runs`, and keeping the upload separate from the matching is what lets a
 * statement land at 04:00 and be reconciled at 09:00 against three PSP reports that arrived
 * in between — rather than three times, once per upload, each against whatever had turned up
 * so far.
 *
 * Both are idempotent by content address: re-uploading the same export stores the evidence
 * once and reports every row as a duplicate. That is Law 4 on the money half, and it is why
 * re-sending a file after a failed parse costs nothing.
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
    { bodyLimit: config.limits.uploadBytes },
    async (request, reply) => {
      const bytes = bodyOf(request.body);
      if (bytes.byteLength === 0) {
        return reply.code(400).send({ error: 'The request body is the settlement file itself.' });
      }

      // Throws `UnknownSourceError` (404) or `NoSettlementAdapterError` (501). The second is
      // the honest answer for Paystack: no sanitized export has pinned its column layout, so
      // there is no parser, and inventing one produces a parser that looks right and books
      // the wrong amounts (D-025).
      const result = ingestSettlement(request.params.source, bytes, {
        merchantId: config.merchantId,
        filename: request.query.filename ?? null,
        receivedFrom: operatorOf(request.headers),
        receivedAt: now(),
      });

      await recordEvidence(pool, result.evidence, bytes);
      const payouts = await recordPayouts(pool, result.payouts);
      const lines = await recordSettlementLines(pool, result.lines);

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
        // Said plainly, because the reflex of every reader is that a settlement report is
        // money. It is a claim by a party with an interest in the answer (D-027).
        booked: 'nothing — a PSP report is a claim, and only bank evidence books cash',
      });
    },
  );

  app.post<{ Querystring: { filename?: string; account?: string; bank?: string } }>(
    '/ingest/bank',
    { bodyLimit: config.limits.uploadBytes },
    async (request, reply) => {
      const bytes = bodyOf(request.body);
      if (bytes.byteLength === 0) {
        return reply.code(400).send({ error: 'The request body is the statement file itself.' });
      }

      const result = ingestBankStatement(bytes, {
        bankAccountId: request.query.account ?? config.bankAccountId,
        bank: request.query.bank ?? config.bank,
        filename: request.query.filename ?? null,
        receivedFrom: operatorOf(request.headers),
        receivedAt: now(),
      });

      await recordEvidence(pool, result.evidence, bytes);
      const lines = await recordBankLines(pool, result.lines);

      return reply.code(201).send({
        evidenceId: result.evidence.evidenceId,
        parserVersion: result.evidence.parserVersion,
        lines,
        rejected: result.rejected,
        booked: 'nothing yet — run POST /reconcile/runs; this is the only evidence that can',
      });
    },
  );

  done();
};

function bodyOf(body: unknown): Buffer {
  return Buffer.isBuffer(body) ? body : Buffer.alloc(0);
}
