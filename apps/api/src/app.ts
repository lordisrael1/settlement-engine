import Fastify, {
  type FastifyError,
  type FastifyInstance,
  type FastifyServerOptions,
} from 'fastify';

import { inboxDepth } from '@recon/inbox';

import { statusFor } from './errors.js';
import { ingestRoutes } from './routes/ingest.js';
import { managementRoutes } from './routes/management.js';
import { webhookRoutes } from './routes/webhooks.js';
import type { Services } from './services.js';

/**
 * The service, assembled but not started.
 *
 * Separating construction from listening is what makes the whole contract testable with
 * `app.inject()` — a real request through the real router, the real parsers and the real
 * error handler, with no port, no socket and no teardown race. A suite that binds ports
 * either picks a fixed one and cannot run twice at once, or picks a random one and has to
 * discover it; neither difficulty is anything to do with reconciliation.
 *
 * Three plugins, and the split between them is not cosmetic. Each is its own Fastify scope,
 * which is what lets the webhook and upload rails swap the body parser for one that keeps
 * the raw bytes while the management routes go on receiving parsed JSON. Signatures are
 * computed over bytes; a JSON parser upstream of a verification is a rejection of valid
 * payloads waiting to happen.
 */
export function buildApp(services: Services, options: FastifyServerOptions = {}): FastifyInstance {
  const app = Fastify(options);

  app.setErrorHandler<FastifyError>((error, request, reply) => {
    const domain = statusFor(error);
    if (domain !== null) {
      // The engine's own words. "This booking would need a plug entry of ₦4,200 to balance"
      // is a sentence an operator can act on; "422 Unprocessable Entity" is not.
      return reply.code(domain).send({ error: error.message, code: error.name });
    }

    // Fastify's own refusals — an unparseable body, a payload over the limit, a schema
    // violation — already carry the right status and a usable message.
    if (typeof error.statusCode === 'number' && error.statusCode < 500) {
      return reply.code(error.statusCode).send({ error: error.message, code: error.code });
    }

    // Anything else is our bug. Logged whole, answered thin: an unmapped stack trace is
    // both useless to the caller and an invitation to whoever is probing.
    request.log.error({ err: error }, 'unhandled error');
    return reply.code(500).send({ error: 'Internal error.' });
  });

  /**
   * Unauthenticated on purpose: a health check that needs a credential is a health check
   * the load balancer cannot make.
   *
   * It reports the two numbers that distinguish "up" from "working". A service whose
   * database is unreachable is not healthy however cheerfully it answers; and an inbox whose
   * pending count only grows is a service that is accepting deliveries and quietly not
   * working them, which is the failure this architecture is most exposed to and the one an
   * HTTP 200 on its own would hide completely.
   */
  app.get('/health', async (_request, reply) => {
    try {
      await services.pool.query('SELECT 1');
      const depth = await inboxDepth(services.pool);
      return { status: 'ok', database: 'reachable', inbox: depth };
    } catch (error) {
      return reply.code(503).send({
        status: 'unhealthy',
        database: 'unreachable',
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  app.register(webhookRoutes, services);
  app.register(ingestRoutes, services);
  app.register(managementRoutes, services);

  return app;
}
