import type { FastifyRequest, onRequestHookHandler } from 'fastify';

import type { Config } from './config.js';
import type { Grant, Principal } from './principals.js';

/**
 * The management credential: a per-principal key in a header.
 *
 * Deliberately not on the webhook route, and the asymmetry is the point (ADR-0052). A PSP
 * holds no credential of ours and never will — it proves who it is by signing the bytes it
 * sends with a secret we already share. An operator holds a key. Two rails, two ways of
 * being authentic, and confusing them means either handing a shared secret to every
 * provider or accepting unsigned money movements from anyone who guessed a URL.
 *
 * What changed is the other half: the key now belongs to a *named principal*, and that name
 * is what the audit record carries. One shared key with a self-declared operator header was
 * tolerable while every audited action was a write the ledger constrained anyway; it stops
 * being tolerable when a request can return a customer's name and email, because then the
 * access log is the only control there is (ADR-0066).
 */

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by `requireApiKey`. Present on every authenticated route and nowhere else. */
    principal?: Principal;
  }
}

export function requireApiKey(config: Config): onRequestHookHandler {
  return (request, reply, done) => {
    const presented = request.headers['x-api-key'];
    const principal = config.principals.authenticate(
      typeof presented === 'string' ? presented : undefined,
    );

    if (!principal) {
      // No detail, and no distinction between "no key" and "wrong key". The lookup is by
      // digest of what was presented, so there is no comparison loop to leak how close a
      // guess came, and there is no reason to say more here either.
      reply.code(401).send({
        error: 'A valid X-API-Key header is required for management endpoints.',
      });
      return;
    }

    request.principal = principal;
    done();
  };
}

/**
 * Require a grant on top of a valid key.
 *
 * The separation this exists for: reading a balance and reading a provider payload are both
 * authenticated, and only one of them hands over a customer's email. A reconciliation
 * operator who works the exception queue all day has no reason to hold `evidence.raw`, and
 * an audit log where everybody could have done everything narrows nothing down.
 */
export function requireGrant(grant: Grant): onRequestHookHandler {
  return (request, reply, done) => {
    const principal = request.principal;

    if (!principal || !principal.grants.has(grant)) {
      reply.code(403).send({
        error:
          `This endpoint needs the "${grant}" grant, which ${principal?.name ?? 'this key'} ` +
          `does not hold. It is separate from ordinary management access because it returns ` +
          `personal data, and the request has been recorded as refused.`,
      });
      return;
    }

    done();
  };
}

/**
 * The verified principal, for a handler that has already passed `requireApiKey`.
 *
 * Throws rather than defaulting. A default would be a name in an audit record that nobody
 * authenticated, which is the exact failure this replaced — and a route that reaches this
 * without the hook is a wiring bug, which should be loud.
 */
export function principalOf(request: FastifyRequest): Principal {
  const principal = request.principal;
  if (!principal) {
    throw new Error(
      'principalOf() was called on a route with no authentication hook. Every route that ' +
        'records who did something must be behind requireApiKey.',
    );
  }
  return principal;
}
