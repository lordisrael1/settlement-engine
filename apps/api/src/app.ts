import scalar from '@scalar/fastify-api-reference';
import swagger from '@fastify/swagger';
import Fastify, {
  type FastifyError,
  type FastifyInstance,
  type FastifyServerOptions,
} from 'fastify';

import { inboxDepth } from '@recon/inbox';

import { alertsFor } from './alerts.js';
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
  const app = Fastify({
    ...options,
    /**
     * Type coercion off, and this is a money decision rather than a style one.
     *
     * Ajv coerces by default, and Fastify leaves that on: a body declaring
     * `{"portalBalanceKobo": 100}` against a `type: 'string'` schema is quietly turned into
     * `"100"` and accepted. For most APIs that is a kindness. Here it defeats the reason
     * every amount crosses this boundary as a decimal string in the first place — a JSON
     * number is a double, and `9007199254740993` has already lost its last digit by the time
     * `JSON.parse` returns, so the coerced string is a wrong amount that validates perfectly.
     *
     * Refusing the request is the only honest answer: the caller sent a number, and the
     * number is not the one they meant.
     *
     * Set here rather than merged with anything the caller passed, because a caller that
     * turned it back on would be turning off a control rather than configuring a server, and
     * the one place that constructs this app for real passes a logger and a proxy flag.
     */
    ajv: { customOptions: { coerceTypes: false } },
  });

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
   * It reports the numbers that distinguish "up" from "working". A service whose database is
   * unreachable is not healthy however cheerfully it answers; and an inbox whose pending
   * count only grows is a service that is accepting deliveries and quietly not working them,
   * which is the failure this architecture is most exposed to and the one an HTTP 200 on its
   * own would hide completely.
   *
   * **It now reaches a verdict rather than only reporting numbers.** Reporting a depth and
   * leaving the reader to decide what a big one means is, in practice, nobody deciding: a
   * monitor watching for a non-200 watches a queue grow all weekend and never fires. So the
   * thresholds live in configuration, `alerts` names every one that is breached in a
   * sentence, and the status code moves — which is the one signal every monitor in the world
   * already understands (ADR-0074).
   *
   * Note what it does *not* return any more: the database driver's own error text. A `pg`
   * connection failure carries the host, the port and sometimes the user, and this endpoint
   * is unauthenticated. The specifics go to the log, where the person who needs them is; the
   * caller gets the fact.
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
      async (request, reply) => {
        const at = services.now();

        let depth;
        try {
          await services.pool.query('SELECT 1');
          depth = await inboxDepth(services.pool, at);
        } catch (error) {
          // Logged whole, answered thin. The stack and the connection string are what the
          // operator needs and exactly what an unauthenticated endpoint must not hand to
          // whoever is probing it.
          request.log.error({ err: error }, 'health check could not reach the database');
          return reply.code(503).send({
            status: 'unhealthy',
            database: 'unreachable',
            error: 'The database is unreachable. See the service log for the reason.',
          });
        }

        const alerts = await alertsFor(services, depth, at);

        // 200 while merely busy, 503 once something is breached. A monitor that understands
        // nothing else understands this, which is the only property that matters for the
        // last mile — getting a person's attention without them remembering to look.
        return reply.code(alerts.length === 0 ? 200 : 503).send({
          status: alerts.length === 0 ? 'ok' : 'degraded',
          database: 'reachable',
          inbox: depth,
          alerts,
        });
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
