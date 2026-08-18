import { timingSafeEqual } from 'node:crypto';

import type { onRequestHookHandler } from 'fastify';

import type { Config } from './config.js';

/**
 * The management credential: a static key in a header.
 *
 * Deliberately not on the webhook route, and the asymmetry is the point (D-052). A PSP
 * holds no credential of ours and never will — it proves who it is by signing the bytes it
 * sends with a secret we already share. An operator holds a key. Two rails, two ways of
 * being authentic, and confusing them means either handing a shared secret to every
 * provider or accepting unsigned money movements from anyone who guessed a URL.
 *
 * Compared in constant time, because a comparison that returns early on the first wrong
 * byte tells an attacker how much of the key they have — slowly, but they have all the time
 * they want. It costs nothing to not have that property.
 */
export function requireApiKey(config: Config): onRequestHookHandler {
  const expected = Buffer.from(config.apiKey, 'utf8');

  return (request, reply, done) => {
    const presented = request.headers['x-api-key'];
    const supplied = typeof presented === 'string' ? Buffer.from(presented, 'utf8') : null;

    // Length is compared first because `timingSafeEqual` throws on a mismatch — and a
    // length difference is not a secret worth protecting: it is visible in the request.
    const ok =
      supplied !== null && supplied.length === expected.length && timingSafeEqual(supplied, expected);

    if (!ok) {
      reply.code(401).send({
        error: 'A valid X-API-Key header is required for management endpoints.',
      });
      return;
    }

    done();
  };
}

/**
 * Who is asking, for the audit trail.
 *
 * One static key cannot tell two operators apart, so the caller names itself and we record
 * what it said. That is weaker than an identity we verified, and it is recorded as a claim
 * rather than as a fact — but "uploaded by amaka@example.com, asserted" answers more of the
 * question an auditor asks than "uploaded by the API" does. When real identities arrive,
 * this is the one line that changes.
 */
export function operatorOf(headers: Record<string, string | string[] | undefined>): string {
  const claimed = headers['x-recon-operator'];
  return typeof claimed === 'string' && claimed.trim() !== '' ? claimed.trim() : 'api';
}
