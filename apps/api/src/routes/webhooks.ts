import type { FastifyPluginCallback } from 'fastify';

import { accept } from '@recon/inbox';
import { sourceProfile, verifyWebhook } from '@recon/ingest';
import { refuseCardData } from '@recon/protect';

import type { Services } from '../services.js';

/**
 * The inbound rail nobody schedules but the provider.
 *
 * Four things happen here, in this order, and nothing else happens at all:
 *
 *   1. the source is one we have an adapter for            (404 if not)
 *   2. we hold a secret for it                             (503 if not)
 *   3. the signature over the raw bytes verifies           (401 if not)
 *   4. the bytes carry no card data                        (422 if they do)
 *   5. the bytes are written down                          (200, otherwise)
 *
 * Step 4 is the only place in the system that can keep a card number out of the database at
 * all, because step 5 is the durable acceptance this rail is built around: after it, the
 * bytes exist. So the scan runs here, on the request path, between the signature check and
 * the insert — and a delivery it refuses is never stored, which is the difference between a
 * PCI scope claim and a PCI scope property (ADR-0066). It is deliberately *after* the
 * signature check: scanning bytes any stranger on the internet can choose is work done on a
 * stranger's behalf.
 *
 * Step 5 is one insert. It does not normalise the payload, post to the ledger, match
 * anything, refresh a projection or send a notification — a worker does all of that, later,
 * from the row this wrote (ADR-0050). The promise being made to the provider is exactly *"we
 * safely received this event"*, which is the only promise that can be kept in a couple of
 * milliseconds at a thousand deliveries a second, and the only one that stays true when the
 * matcher is busy.
 *
 * Note what step 3 requires: the **raw bytes**, untouched. `JSON.parse` followed by
 * re-serialising produces different bytes — reordered keys, different whitespace, different
 * unicode escaping — and the signature is over the original ones, so a JSON body parser
 * anywhere upstream of here rejects perfectly valid payloads. Hence the parser swap below,
 * which Fastify scopes to this plugin.
 */
export const webhookRoutes: FastifyPluginCallback<Services> = (app, services, done) => {
  const { pool, config, now } = services;

  // Encapsulated in this plugin only: the management routes keep Fastify's JSON parsing.
  // Removing the built-ins first matters — the default `application/json` parser would
  // otherwise win for exactly the content type every provider sends.
  app.removeAllContentTypeParsers();
  app.addContentTypeParser('*', { parseAs: 'buffer' }, (_request, body: Buffer, next) => {
    next(null, body);
  });

  app.post<{ Params: { source: string } }>(
    '/webhooks/:source',
    { bodyLimit: config.limits.webhookBytes },
    async (request, reply) => {
      const source = request.params.source;

      // Asked before the secret, so an unknown source is a 404 rather than a 503 — "we have
      // never heard of this provider" and "we are misconfigured for one we have" are
      // different answers and lead to different phone calls. Throws, and the error handler
      // turns it into the status.
      sourceProfile(source);

      const secret = config.webhookSecret(source);
      if (!secret) {
        return reply.code(503).send({
          error:
            `No webhook secret is configured for "${source}", so this delivery cannot be ` +
            `authenticated. Nothing has been stored. Set ` +
            `RECON_WEBHOOK_SECRET_${source.toUpperCase()} and the provider's retry will land.`,
        });
      }

      // A request with no body is parsed by nobody, so `body` is undefined rather than
      // empty. Zero bytes cannot carry a valid signature, so this falls through to 401 —
      // which is the honest answer to an empty POST claiming to be from a PSP.
      const rawBody = Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0);

      if (!verifyWebhook({ source, headers: request.headers, rawBody, secret })) {
        // No detail, deliberately. Anything more specific than "it did not verify" is a
        // hint to whoever is guessing, and the provider does not need one — its own logs
        // hold the payload it signed.
        return reply.code(401).send({ error: 'Signature verification failed.' });
      }

      // Authentic, and still refused if it carries a card number or sensitive
      // authentication data. Throws `CardDataRefused`, which the error handler turns into a
      // 422 carrying the finding — the field name or a masked form, never the digits.
      refuseCardData(rawBody, `This ${source} delivery`);

      const accepted = await accept(pool, {
        source,
        headers: request.headers,
        rawBody,
        receivedAt: now(),
      });

      // 200 rather than 202, though 202 is the more accurate word for what just happened.
      // Providers are not uniformly generous about which 2xx they accept and at least one
      // documents 200 specifically; being right about the verb is not worth a retry storm.
      // `duplicate` says the redelivery was absorbed, which is a thing worth being able to
      // count from the outside.
      return reply.code(200).send({
        accepted: true,
        deliveryId: accepted.deliveryId,
        duplicate: accepted.duplicate,
      });
    },
  );

  done();
};
