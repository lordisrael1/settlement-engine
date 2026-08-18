import type { FastifyPluginCallback } from 'fastify';

import type { AccountId, ExceptionState, ExceptionSubject, Money } from '@recon/canon';
import { money } from '@recon/canon';
import { deliveryAt } from '@recon/inbox';
import { allBalances } from '@recon/ledger-core';
import { buildPolicy } from '@recon/policy';
import {
  exceptionAt,
  exceptionHistory,
  openExceptions,
  reconcile,
  resolveException,
  summarize,
} from '@recon/reconciler';

import { requireApiKey } from '../auth.js';
import {
  asBalances,
  asDelivery,
  asException,
  asRun,
  asSummary,
} from '../serialise.js';
import type { Services } from '../services.js';

/**
 * The read contract, and the one write a human makes.
 *
 * Every handler below is the same three lines — parse the request, call one package
 * function, serialise the answer — and that sameness is the phase's exit criterion, not an
 * accident of scope. If a route here starts deciding *which* exceptions matter, *what* a
 * shortfall means, or *whether* a resolution needs approving, a Law has moved into the
 * transport layer and the packages have stopped being the authority on their own subjects.
 *
 * The one place that could have gone wrong is `POST /exceptions/:key/resolve`, because
 * resolving is genuinely three writes: the decision, the compensating entry, and the
 * closing of the queue item. Sequencing those here would have put the atomicity of a
 * financial correction in an HTTP handler, so the composition lives in the reconciler as
 * `resolveException` and this route calls it. What that leaves here is the mapping from a
 * JSON body to a `Resolution` — and a 422 when the engine says no.
 */
export const managementRoutes: FastifyPluginCallback<Services> = (app, services, done) => {
  const { pool, config, now } = services;

  app.addHook('onRequest', requireApiKey(config));

  // ── What the books say ────────────────────────────────────────────────────
  app.get('/balances', async () => ({ balances: asBalances(await allBalances(pool)) }));

  // ── What happened to a webhook we accepted ────────────────────────────────
  //
  // The inbox's whole promise is that a delivery is never lost between "200" and "booked".
  // A promise nobody can check is a slogan, so the delivery id we handed the provider
  // resolves to its fate: which state, how many attempts, what it became, and — if it
  // failed — the error that stopped it.
  app.get<{ Params: { deliveryId: string } }>(
    '/deliveries/:deliveryId',
    async (request, reply) => {
      const delivery = await deliveryAt(pool, request.params.deliveryId);
      if (!delivery) return reply.code(404).send({ error: 'No such delivery.' });
      return asDelivery(delivery);
    },
  );

  // ── Run the matcher ───────────────────────────────────────────────────────
  //
  // A run is bounded by `reconcileLimit` on purpose. Subset-sum batching over an unbounded
  // set of open promises is how a matcher stops returning; the limit is the difference
  // between a run that takes a second and one that never finishes (D-053).
  app.post('/reconcile/runs', async (_request, reply) => {
    const run = await reconcile(pool, {
      asOf: now(),
      policyFor: await buildPolicy(pool, config.merchantId),
      limit: config.reconcileLimit,
    });
    return reply.code(201).send(asRun(run));
  });

  // ── What it all added up to ───────────────────────────────────────────────
  app.get<{ Querystring: { from?: string; to?: string } }>(
    '/reconciliation/summary',
    async (request, reply) => {
      const to = request.query.to ? date(request.query.to) : now();
      const from = request.query.from ? date(request.query.from) : null;
      if (!to || (request.query.from && !from)) {
        return reply.code(400).send({ error: '`from` and `to` must be ISO-8601 instants.' });
      }
      return asSummary(await summarize(pool, { from: from ?? thirtyDaysBefore(to), to }));
    },
  );

  // ── The queue ─────────────────────────────────────────────────────────────
  app.get<{
    Querystring: { state?: string | string[]; subject?: string; limit?: string };
  }>('/exceptions', async (request, reply) => {
    const states = list(request.query.state) as ExceptionState[];
    const limit = request.query.limit ? Number(request.query.limit) : 100;
    if (!Number.isInteger(limit) || limit <= 0 || limit > 1000) {
      return reply.code(400).send({ error: '`limit` must be an integer between 1 and 1000.' });
    }

    const items = await openExceptions(pool, {
      ...(states.length > 0 ? { states } : {}),
      ...(request.query.subject
        ? { subject: request.query.subject as ExceptionSubject }
        : {}),
      limit,
    });

    // Worst first, as the package ordered it. Re-sorting here would be this layer having an
    // opinion about severity, which is exactly what it must not have.
    return { exceptions: items.map(asException) };
  });

  app.get<{ Params: { key: string } }>('/exceptions/:key', async (request, reply) => {
    const item = await exceptionAt(pool, request.params.key);
    if (!item) return reply.code(404).send({ error: 'No such exception.' });
    return {
      exception: asException(item),
      // Nothing here was ever overwritten, so the history is the whole story: raised on
      // Tuesday, acknowledged by a named person on Wednesday, resolved by evidence on
      // Thursday (D-043).
      history: await exceptionHistory(pool, request.params.key),
    };
  });

  app.post<{ Params: { key: string }; Body: ResolveBody }>(
    '/exceptions/:key/resolve',
    { schema: { body: RESOLVE_SCHEMA } },
    async (request, reply) => {
      const item = await exceptionAt(pool, request.params.key);
      if (!item) return reply.code(404).send({ error: 'No such exception.' });

      const body = request.body;
      const at = now();
      const approved = body.approvedBy ?? null;

      const outcome = await resolveException(pool, {
        key: item.key,
        resolution: {
          // Supplied by the caller, not generated, so a retried request appends one
          // resolution rather than two — and so the compensating transaction it posts has
          // the same id on the second attempt and collides instead of double-booking.
          resolutionKey: body.resolutionKey,
          // Taken from the exception rather than from the body. A caller cannot attach a
          // decision to a subject other than the one it is answering.
          subject: item.subject,
          subjectId: item.subjectId,
          action: body.action,
          reason: body.reason,
          amount: body.amountKobo === undefined ? null : money(BigInt(body.amountKobo)),
          resolvedBy: body.resolvedBy,
          resolvedAt: at,
          evidenceId: body.evidenceId ?? null,
          approvedBy: approved,
          // An approval is complete or absent — never half-recorded, which would look like
          // oversight happened.
          approvedAt: approved === null ? null : at,
        },
        ...(body.entries && body.entries.length > 0
          ? { entries: body.entries.map(toEntry) }
          : {}),
      });

      // Cleared by evidence between the read and the write: a settlement file beat the
      // operator to it, which is the machine doing its job.
      if (!outcome) return reply.code(409).send({ error: 'The exception is no longer open.' });

      return reply.code(201).send({
        resolutionKey: outcome.recorded.resolution.resolutionKey,
        bookedTransactionId: outcome.recorded.bookedTransactionId,
        exceptionClosed: outcome.closed,
      });
    },
  );

  done();
};

interface ResolveBody {
  readonly resolutionKey: string;
  readonly action: string;
  readonly reason: string;
  readonly resolvedBy: string;
  readonly approvedBy?: string;
  readonly evidenceId?: string;
  /** Kobo, as a decimal string. Never a JSON number — a JSON number is a double (Law 3). */
  readonly amountKobo?: string;
  readonly entries?: readonly { readonly accountId: string; readonly kobo: string }[];
}

const KOBO = { type: 'string', pattern: '^-?[0-9]+$' } as const;

/**
 * Transport validation only: shapes and types, nothing about money.
 *
 * Whether this decision needs an approver, whether the amount is plausible, and which
 * accounts it may touch are all the engine's questions, answered by `approvalFailure` and
 * `bookResolutionAdjustment` — and answered there so that the CLI, a future dashboard and
 * this route cannot each have a slightly different idea.
 */
const RESOLVE_SCHEMA = {
  type: 'object',
  required: ['resolutionKey', 'action', 'reason', 'resolvedBy'],
  additionalProperties: false,
  properties: {
    resolutionKey: { type: 'string', minLength: 1, maxLength: 200 },
    action: { type: 'string', minLength: 1, maxLength: 60 },
    reason: { type: 'string', minLength: 1, maxLength: 2000 },
    resolvedBy: { type: 'string', minLength: 1, maxLength: 200 },
    approvedBy: { type: 'string', minLength: 1, maxLength: 200 },
    evidenceId: { type: 'string', minLength: 1, maxLength: 200 },
    amountKobo: KOBO,
    entries: {
      type: 'array',
      maxItems: 20,
      items: {
        type: 'object',
        required: ['accountId', 'kobo'],
        additionalProperties: false,
        properties: {
          accountId: { type: 'string', minLength: 1, maxLength: 60 },
          kobo: KOBO,
        },
      },
    },
  },
} as const;

function toEntry(entry: { accountId: string; kobo: string }): {
  accountId: AccountId;
  amount: Money;
} {
  // The account id is checked by the `entries` foreign key, and an unknown one becomes a
  // refused write rather than a silently created account.
  return { accountId: entry.accountId as AccountId, amount: money(BigInt(entry.kobo)) };
}

function date(text: string): Date | null {
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function thirtyDaysBefore(to: Date): Date {
  return new Date(to.getTime() - 30 * 24 * 60 * 60 * 1000);
}

function list(value: string | string[] | undefined): string[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}
