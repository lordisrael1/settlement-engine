import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildApp } from './app.js';
import { OPERATIONS } from './openapi.js';
import type { Services } from './services.js';

/**
 * The specification, checked against the routes it claims to describe.
 *
 * A reference document is worth exactly as much as its worst entry, and the way one goes
 * wrong is never that somebody wrote a bad description — it is that a route was added six
 * months later and nobody thought about the docs. So the coverage is asserted rather than
 * intended: an undocumented route fails here, by name, on the build that adds it.
 *
 * No database. `buildApp` assembles the router without connecting to anything, which is the
 * whole reason construction is separate from listening — and the specification is built from
 * the route table, not from behaviour.
 */

/** Enough of `Services` to assemble the router. Nothing here issues a query. */
const SERVICES = {
  pool: { query: async () => ({ rows: [] }) },
  config: {
    limits: { webhookBytes: 256 * 1024, uploadBytes: 32 * 1024 * 1024 },
    principals: { authenticate: () => null },
    merchantId: 'test-merchant',
    bankAccountId: 'test-account',
    bank: 'test-bank',
    webhookSecret: () => null,
    reconcileLimit: 1000,
    exportTtlMs: 900_000,
    vault: {},
  },
  now: () => new Date('2026-08-20T00:00:00Z'),
} as unknown as Services;

const specification = async () => {
  const app = buildApp(SERVICES);
  await app.ready();
  try {
    return app.swagger() as {
      openapi: string;
      paths: Record<string, Record<string, { operationId?: string; responses?: Record<string, unknown> }>>;
      components: { securitySchemes: Record<string, unknown> };
    };
  } finally {
    await app.close();
  }
};

/**
 * The property that makes a generated specification worth having over a hand-written one: it
 * cannot silently fall behind the routes.
 */
test('every route the service serves appears in the specification', async () => {
  const spec = await specification();

  const documented = new Set<string>();
  for (const [path, operations] of Object.entries(spec.paths)) {
    for (const method of Object.keys(operations)) {
      documented.add(`${method.toUpperCase()} ${path}`);
    }
  }

  // OpenAPI spells parameters `{like}` where Fastify spells them `:like`.
  const expected = Object.keys(OPERATIONS).map((key) =>
    key.replace(/:([^/]+)/g, '{$1}'),
  );

  const missing = expected.filter((operation) => !documented.has(operation));
  assert.deepEqual(missing, [], 'these operations are described but no longer served');

  // The reverse, and the direction that actually rots: a route added without documentation.
  // `/docs` and its own assets are the reference UI rather than the API, so they are excluded.
  const undocumented = [...documented].filter(
    (operation) => !expected.includes(operation) && !operation.includes('/docs'),
  );
  assert.deepEqual(undocumented, [], 'these routes are served but undocumented — add them to OPERATIONS');
});

/**
 * Every operation says what can go wrong, not merely what goes right.
 *
 * The error catalogue is the half of an API reference people actually open, and it is the
 * half a generator cannot infer: no tool can know that a 409 on `resolve` means a settlement
 * file beat the operator to it, or that a 410 on evidence means destroyed-on-schedule rather
 * than never-existed.
 */
test('every operation documents at least one failure', async () => {
  const spec = await specification();

  const silent: string[] = [];
  for (const [path, operations] of Object.entries(spec.paths)) {
    for (const [method, operation] of Object.entries(operations)) {
      if (path.includes('/docs')) continue;
      const codes = Object.keys(operation.responses ?? {});
      if (!codes.some((code) => Number(code) >= 400)) {
        silent.push(`${method.toUpperCase()} ${path}`);
      }
    }
  }

  assert.deepEqual(silent, [], 'these operations describe only success');
});

/**
 * Three ways of being authentic, and the specification has to say so.
 *
 * A reference that describes only the API key would leave a provider integrator guessing at
 * the one rail that does not use one — and an operator assuming the export link needs a key
 * it deliberately does not (ADR-0052, ADR-0066).
 */
test('the specification describes all three authentication rails', async () => {
  const spec = await specification();

  assert.deepEqual(Object.keys(spec.components.securitySchemes).sort(), [
    'apiKey',
    'exportToken',
    'providerSignature',
  ]);
  assert.equal(spec.openapi, '3.1.0');
});

/**
 * The reason responses live in `openapi.ts` rather than on the routes.
 *
 * Fastify's `schema.response` is a serialiser as well as a description, and
 * `fast-json-stringify` drops any property the schema does not name. In a service whose
 * responses carry money, a documentation edit must never be able to reshape a payload — so
 * this asserts the separation directly, rather than trusting everyone to remember it.
 */
test('no route compiles a response schema, so documentation cannot reshape a payload', async () => {
  const app = buildApp(SERVICES);

  // `register` defers: the plugins' routes are created during `ready()`, so a hook added here
  // — after construction, before ready — sees every one of them.
  const withResponseSchemas: string[] = [];
  app.addHook('onRoute', (route) => {
    const schema = route.schema as { response?: unknown } | undefined;
    if (schema?.response !== undefined) {
      withResponseSchemas.push(`${String(route.method)} ${route.url}`);
    }
  });

  await app.ready();
  await app.close();

  assert.deepEqual(
    withResponseSchemas,
    [],
    'a response schema on a route is a serialiser: fast-json-stringify drops what it does ' +
      'not name, so this would let a documentation edit silently remove a field carrying money',
  );
});

/** …and the descriptions still have to exist somewhere, which is here. */
test('every documented operation describes its responses', () => {
  const silent = Object.entries(OPERATIONS)
    .filter(([, documented]) => !('response' in documented))
    .map(([key]) => key);

  assert.deepEqual(silent, []);
});
