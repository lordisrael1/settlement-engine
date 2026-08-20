import scalar from '@scalar/fastify-api-reference';
import swagger from '@fastify/swagger';
import Fastify, {
  type FastifyError,
  type FastifyInstance,
  type FastifyServerOptions,
} from 'fastify';

import { inboxDepth } from '@recon/inbox';

import { statusFor } from './errors.js';
import { OPENAPI_DOCUMENT, OPERATIONS } from './openapi.js';
import { evidenceRoutes } from './routes/evidence.js';
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
 * Four plugins, and the split between them is not cosmetic. Each is its own Fastify scope,
 * which is what lets the webhook and upload rails swap the body parser for one that keeps
 * the raw bytes while the management routes go on receiving parsed JSON. Signatures are
 * computed over bytes; a JSON parser upstream of a verification is a rejection of valid
 * payloads waiting to happen.
 */
export function buildApp(services: Services, options: FastifyServerOptions = {}): FastifyInstance {
  const app = Fastify(options);

  /**
   * The specification, generated from the routes and described in `openapi.ts`.
   *
   * Registered before the route plugins, because `@fastify/swagger` collects routes as they
   * are added and cannot see ones registered before it.
   *
   * `transform` is the whole reason responses are documented in a separate file rather than
   * attached to the routes. It runs when the specification is built and never on a request, so
   * a response description can never become a serialiser — and `fast-json-stringify` silently
   * dropping a field nobody thought to list is not a failure this service may have.
   */
  app.register(swagger, {
    openapi: OPENAPI_DOCUMENT as unknown as Record<string, unknown>,
    transform: ({ schema, url, route }) => {
      const documented = OPERATIONS[`${methodOf(route)} ${url}`];
      return { schema: documented ? { ...schema, ...documented } : schema, url };
    },
  });

  /**
   * Unauthenticated, like `/health` and for the same reason: a reference nobody can read
   * without first being told how to authenticate is a reference that answers the one question
   * it exists to answer last. It describes shapes and rules; it returns no data, reaches no
   * database, and names no principal.
   */
  app.register(scalar, {
    routePrefix: '/docs',
    configuration: { title: 'Reconciliation API' },
  });

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
  // Registered rather than declared, and the difference is not stylistic: `.get()` adds a
  // route immediately, while `.register()` defers until `ready()`. `@fastify/swagger` collects
  // routes through an `onRoute` hook installed when *its* plugin body runs — during `ready()`
  // — so a route added synchronously above is invisible to it, and would be missing from the
  // specification with nothing to indicate it. Deferring puts this in the same queue as every
  // other route, behind swagger.
  app.register(async (scope) => {
    scope.get(
      '/health',
      {
        schema: {
          tags: ['Health'],
          operationId: 'health',
          summary: 'Up, and whether it is working',
          security: [],
        },
      },
      async (_request, reply) => {
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
      },
    );
  });

  app.register(webhookRoutes, services);
  app.register(ingestRoutes, services);
  app.register(evidenceRoutes, services);
  app.register(managementRoutes, services);

  return app;
}

/**
 * The method a route was registered under, as a single uppercase verb.
 *
 * Fastify allows an array — one handler for several methods — and none of these routes uses
 * that. Taking the first is therefore correct here and would quietly document only half of a
 * multi-method route if one were ever added, which is what the coverage test is for.
 */
function methodOf(route: { method: string | string[] }): string {
  return Array.isArray(route.method) ? (route.method[0] ?? '') : route.method;
}
