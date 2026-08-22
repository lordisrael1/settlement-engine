import type { FastifyPluginCallback } from 'fastify';

import type { AccountId, ExceptionState, ExceptionSubject, Money } from '@recon/canon';
import { money } from '@recon/canon';
import { deliveryAt } from '@recon/inbox';
import { allBalances } from '@recon/ledger-core';
import { buildPolicy } from '@recon/policy';
import {
  acknowledgeAnomaly,
  attestBankBalance,
  bankPosition,
  exceptionAt,
  exceptionHistory,
  lastAttestation,
  openAnomalies,
  openExceptions,
  reconcile,
  reservePositions,
  resolveException,
  summarize,
} from '@recon/reconciler';

import { principalOf, requireApiKey } from '../auth.js';
import { addressOf, rateLimit } from '../ratelimit.js';
import {
  asBalances,
  asMoney,
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
 * function, serialise the answer — and that sameness is deliberate. If a route here starts
 * deciding *which* exceptions matter, *what* a shortfall means, or *whether* a resolution
 * needs approving, domain logic has moved into the transport layer and the packages have
 * stopped being the authority on their own subjects.
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

  // Keyed by principal once there is one, and by address before then — an unauthenticated
  // caller guessing keys is exactly the traffic worth limiting, and it has no principal yet.
  // Registered before the authentication hook so a flood of bad keys costs a map lookup
  // rather than a digest comparison per request.
  rateLimit(
    app,
    config.rateLimits.management,
    (request) => request.principal?.name ?? `anon:${addressOf(request)}`,
    now,
  );

  app.addHook('onRequest', requireApiKey(config));

  // ── What the books say ────────────────────────────────────────────────────
  app.get(
    '/balances',
    { schema: { tags: ['Reconciliation'], operationId: 'balances', summary: 'Current balances' } },
    async () => ({ balances: asBalances(await allBalances(pool)) }),
  );

  // ── What happened to a webhook we accepted ────────────────────────────────
  //
  // The inbox's whole promise is that a delivery is never lost between "200" and "booked".
  // A promise nobody can check is a slogan, so the delivery id we handed the provider
  // resolves to its fate: which state, how many attempts, what it became, and — if it
  // failed — the error that stopped it.
  app.get<{ Params: { deliveryId: string } }>(
    '/deliveries/:deliveryId',
    {
      schema: {
        tags: ['Webhooks'],
        operationId: 'delivery',
        summary: 'What became of an accepted delivery',
      },
    },
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
  // between a run that takes a second and one that never finishes (ADR-0053).
  app.post(
    '/reconcile/runs',
    {
      schema: {
        tags: ['Reconciliation'],
        operationId: 'reconcile',
        summary: 'Run the matcher',
        description:
          'Allocation, then bank confirmation. Kept separate from the uploads so a statement ' +
          'can land at 04:00 and be reconciled at 09:00 against three PSP reports that arrived ' +
          'in between — rather than three times, once per upload.',
      },
    },
    async (_request, reply) => {
      const run = await reconcile(pool, {
        asOf: now(),
        policyFor: await buildPolicy(pool, config.merchantId),
        limit: config.reconcileLimit,
        // The bounded subset search, with the deployment's own bound. The default is a
        // small-batch one and a provider that reports payout totals without per-line
        // references needs it raised (ADR-0070).
        limits: config.subsetLimits,
      });
      return reply.code(201).send(asRun(run));
    },
  );

  // ── What it all added up to ───────────────────────────────────────────────
  app.get<{ Querystring: { from?: string; to?: string } }>(
    '/reconciliation/summary',
    {
      schema: {
        tags: ['Reconciliation'],
        operationId: 'summary',
        summary: 'What it all added up to',
      },
    },
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
  }>(
    '/exceptions',
    { schema: { tags: ['Exceptions'], operationId: 'exceptions', summary: 'The queue, worst first' } },
    async (request, reply) => {
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
    },
  );

  /**
   * The drift queue: foreign formats that have moved, worst first.
   *
   * Deliberately a separate endpoint from `/exceptions` rather than a filter on it. An
   * exception is a money difference a person can answer with a resolution; an anomaly is a
   * statement about a parser, with no amount and nothing to resolve (ADR-0067). Two questions,
   * two lists — and the person who reads one in the morning is often not the person who reads
   * the other.
   */
  app.get<{ Querystring: { limit?: string } }>(
    '/ingest/anomalies',
    {
      schema: {
        tags: ['Ingest'],
        operationId: 'anomalies',
        summary: 'The drift queue',
        description:
          'Foreign formats that have moved, worst first. An unknown field is the earliest ' +
          'warning available and arrives while everything still works.',
      },
    },
    async (request, reply) => {
    const limit = request.query.limit ? Number(request.query.limit) : 100;
    if (!Number.isInteger(limit) || limit <= 0 || limit > 1000) {
      return reply.code(400).send({ error: '`limit` must be an integer between 1 and 1000.' });
    }

    const items = await openAnomalies(pool, limit);
    return {
      anomalies: items.map((item) => ({
        key: item.key,
        source: item.source,
        kind: item.kind,
        detail: item.detail,
        state: item.state,
        severity: item.severity,
        since: item.since,
        // The two dates that turn an anomaly into a diagnosis. A field that first appeared on
        // the day the fee variances started is an explanation; the newest observation alone
        // could never say so.
        firstSeen: item.firstSeen,
        lastSeen: item.lastSeen,
        filesAffected: item.filesAffected,
        timesRaised: item.timesRaised,
        occurrences: item.occurrences,
        rowsInFile: item.rowsInFile,
        share: item.share,
        evidenceId: item.evidenceId,
        parserVersion: item.parserVersion,
        format: item.format,
        firstPath: item.firstPath,
        sample: item.sample,
      })),
    };
  });

  app.post<{ Params: { key: string }; Body: { actor?: string; note?: string } }>(
    '/ingest/anomalies/:key/acknowledge',
    {
      schema: {
        tags: ['Ingest'],
        operationId: 'acknowledgeAnomaly',
        summary: 'Take ownership of a drift',
      },
    },
    async (request, reply) => {
      const actor = request.body?.actor ?? principalOf(request).name;
      const took = await acknowledgeAnomaly(
        pool,
        request.params.key,
        actor,
        now(),
        request.body?.note ?? null,
      );
      if (!took) {
        return reply
          .code(409)
          .send({ error: 'No such anomaly, or it is not in a state that can be acknowledged.' });
      }
      return { acknowledged: request.params.key, by: actor };
    },
  );

  app.get<{ Params: { key: string } }>(
    '/exceptions/:key',
    {
      schema: {
        tags: ['Exceptions'],
        operationId: 'exception',
        summary: 'One exception, with its whole history',
      },
    },
    async (request, reply) => {
    const item = await exceptionAt(pool, request.params.key);
    if (!item) return reply.code(404).send({ error: 'No such exception.' });
    return {
      exception: asException(item),
      // Nothing here was ever overwritten, so the history is the whole story: raised on
      // Tuesday, acknowledged by a named person on Wednesday, resolved by evidence on
      // Thursday (ADR-0043).
        history: await exceptionHistory(pool, request.params.key),
      };
    },
  );

  app.post<{ Params: { key: string }; Body: ResolveBody }>(
    '/exceptions/:key/resolve',
    {
      schema: {
        body: RESOLVE_SCHEMA,
        tags: ['Exceptions'],
        operationId: 'resolveException',
        summary: 'Answer an exception',
        description:
          'Three writes in one transaction: the decision, the compensating entry, and the ' +
          'closing of the queue item. `resolutionKey` is supplied by the caller, not ' +
          'generated, so a retried request appends one resolution rather than two.',
      },
    },
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

  // ── Our money, in somebody else's account ─────────────────────────────────
  //
  // `psp_reserve` is an asset, and the balance alone is unfalsifiable: a PSP returning
  // reserves on schedule and one returning none of them produce the same number. This is
  // that number taken apart — which payout, withheld when, due when, still out how much
  // (ADR-0071).
  app.get<{ Querystring: { limit?: string } }>(
    '/reserves',
    {
      schema: {
        tags: ['Reconciliation'],
        operationId: 'reserves',
        summary: 'Reserves withheld and not yet returned',
        description:
          'Oldest first, overdue ones first of all. A hold with no dueAt belongs to a source ' +
          'that declared no release schedule: never overdue, never self-clearing, and worth ' +
          'noticing for exactly that reason.',
      },
    },
    async (request) => {
      // Bounded like every other list here. Parsed rather than trusted: an unparseable or
      // absurd `limit` falls back to the default instead of becoming a 400, because a
      // reserve list is a read and a reader who typed the query wrong wants the list.
      const asked = Number(request.query.limit);
      const limit = Number.isInteger(asked) && asked > 0 && asked <= 1000 ? asked : 500;
      const positions = await reservePositions(pool, limit);
      const at = now();

      return {
        reserves: positions.map((position) => ({
          inflowKey: position.inflowKey,
          source: position.source,
          withheld: asMoney(position.withheld),
          released: asMoney(position.released),
          outstanding: asMoney(position.outstanding),
          withheldAt: position.withheldAt.toISOString(),
          dueAt: position.dueAt?.toISOString() ?? null,
          overdue: position.dueAt !== null && position.dueAt < at,
          confirmedBy: position.confirmedBy,
          evidenceId: position.evidenceId,
        })),
      };
    },
  );

  // ── The trust boundary ────────────────────────────────────────────────────
  //
  // Cash here is booked from an uploaded file, and nothing proves that file came from the
  // bank: no signature on the bytes, no feed, no independent check. Anyone holding an ingest
  // key can produce a statement that confirms inflows and moves `psp_receivable` into
  // `bank_account`. `verify` does not catch it and could not — it proves the books are
  // *internally* consistent, and a fabricated statement that balances is internally
  // consistent (ADR-0068).
  //
  // These two endpoints are the honest response to that, and neither pretends to be a fix.
  // The first is the check the system can make on its own; the second records a check only a
  // person can make.
  app.get(
    '/bank/position',
    {
      schema: {
        tags: ['Reconciliation'],
        operationId: 'bankPosition',
        summary: 'Our books against the bank\'s own arithmetic',
        description:
          "Compares `bank_account`, summed from entries, to the running balance on the last " +
          'statement line ingested. Catches a half-ingested statement or an unmodelled debit. ' +
          'It does NOT prove the statement came from the bank: a fabricated file carries a ' +
          'fabricated running balance and agrees with itself perfectly.',
      },
    },
    async () => {
      const position = await bankPosition(pool, config.bankAccountId);
      const last = await lastAttestation(pool, config.bankAccountId);

      return {
        bankAccountId: position.bankAccountId,
        ledgerBalance: asMoney(position.ledgerBalance),
        statementClosing: position.statementClosing ? asMoney(position.statementClosing) : null,
        statementAt: position.statementAt?.toISOString() ?? null,
        difference: position.difference ? asMoney(position.difference) : null,
        // Expected to be non-zero, and saying so here rather than leaving a reader to
        // discover it: the real account holds movements this system never models.
        differenceIsExpected:
          'The real account holds movements this system does not model — supplier payments, ' +
          'salaries, standing orders. The question is not whether this is zero but whether ' +
          'anybody can say what it consists of.',
        lastAttestation: last
          ? {
              asOf: last.asOf.toISOString(),
              attestedBy: last.attestedBy,
              portalBalance: asMoney(last.portalBalance),
              difference: asMoney(last.difference),
              note: last.note,
            }
          : null,
      };
    },
  );

  app.post<{ Body: AttestBody }>(
    '/bank/attestations',
    {
      schema: {
        body: ATTEST_SCHEMA,
        tags: ['Reconciliation'],
        operationId: 'attestBankBalance',
        summary: 'Record that a person compared the books to the bank',
        description:
          'The only control over a fabricated bank statement, and it is out-of-band by ' +
          'necessity: a human reads the bank\'s own portal and records what it said. ' +
          'Append-only — an attestation that can be edited afterwards is not evidence that ' +
          'somebody checked.',
      },
    },
    async (request, reply) => {
      const body = request.body;
      const at = now();

      const attested = await attestBankBalance(pool, {
        bankAccountId: body.bankAccountId ?? config.bankAccountId,
        // When they read the portal, not when they posted this. A balance read at 09:00 and
        // recorded at 11:00 is a statement about 09:00.
        asOf: body.asOf ? new Date(body.asOf) : at,
        portalBalance: money(BigInt(body.portalBalanceKobo)),
        // The verified principal, never a name the caller supplied about itself. This is an
        // audit record of a human control, and a self-declared one would record nothing.
        attestedBy: principalOf(request).name,
        note: body.note ?? null,
        recordedAt: at,
      });

      return reply.code(201).send({
        bankAccountId: attested.bankAccountId,
        asOf: attested.asOf.toISOString(),
        portalBalance: asMoney(attested.portalBalance),
        ledgerBalance: asMoney(attested.ledgerBalance),
        difference: asMoney(attested.difference),
        attestedBy: attested.attestedBy,
      });
    },
  );

  done();
};

interface AttestBody {
  /** Integer kobo, as a string: a BIGINT must never round-trip through a JSON number. */
  readonly portalBalanceKobo: string;
  readonly bankAccountId?: string;
  /** ISO-8601. When the portal was read, not when this was posted. */
  readonly asOf?: string;
  readonly note?: string;
}

const ATTEST_SCHEMA = {
  type: 'object',
  required: ['portalBalanceKobo'],
  additionalProperties: false,
  properties: {
    portalBalanceKobo: { type: 'string', pattern: '^-?\\d+$' },
    bankAccountId: { type: 'string', minLength: 1 },
    asOf: { type: 'string', format: 'date-time' },
    note: { type: 'string', maxLength: 2000 },
  },
} as const;

interface ResolveBody {
  readonly resolutionKey: string;
  readonly action: string;
  readonly reason: string;
  readonly resolvedBy: string;
  readonly approvedBy?: string;
  readonly evidenceId?: string;
  /** Kobo, as a decimal string. Never a JSON number: a JSON number is a double. */
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
