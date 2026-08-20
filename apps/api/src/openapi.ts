import type { FastifySchema } from 'fastify';

/**
 * The API description, and one decision about how it is produced.
 *
 * Paths, methods, parameters and request-body schemas are **generated** from the routes
 * themselves, so the parts of a specification that rot fastest cannot rot: a route added
 * without documentation fails a test, and a body schema changed in `management.ts` changes
 * here on the next build.
 *
 * Responses are **described here rather than attached to the routes**, and that is not a
 * shortcut — it is the point. Fastify's `schema.response` is not documentation; it is a
 * serialiser, and `fast-json-stringify` drops any property the schema does not name. In a
 * service whose responses carry money, that turns "somebody documented an endpoint slightly
 * incompletely" into "an amount silently stopped being returned", with no error anywhere and
 * a passing build. Documentation must not be able to reshape a payload.
 *
 * So these travel through `@fastify/swagger`'s `transform`, which runs when the specification
 * is generated and never at request time. The runtime behaviour of every route is byte-for-byte
 * what it was before this file existed, which is the property that made it safe to add.
 *
 * The same reasoning as ADR-0025, one layer out: a description that looks right and is
 * quietly wrong is worse than one that is honestly absent, so the parts that can be derived
 * are derived and the parts that cannot are written down where a reviewer can see them.
 */

export const OPENAPI_DOCUMENT = {
  openapi: '3.1.0',
  info: {
    title: 'Reconciliation',
    version: '0.0.0',
    description:
      'Three records, and the arithmetic between them.\n\n' +
      'A **payment** is a promise made by a webhook. A **settlement** is a PSP saying what it ' +
      'intends to send. A **bank statement line** is the only proof that cash moved. This ' +
      'service accepts all three and reconciles them; it never treats the second as the third.\n\n' +
      '### Amounts\n' +
      'Every amount crosses this boundary as a **decimal string of kobo**, never a JSON number. ' +
      'A JSON number is an IEEE double, and a double is not a ledger amount. Responses carry a ' +
      '`formatted` field beside every amount so that no consumer divides by 100 in JavaScript.\n\n' +
      '### Two ways of being authentic\n' +
      'A PSP holds no credential of ours and never will — it proves who it is by signing the ' +
      'bytes it sends. An operator holds a key belonging to a named principal. Confusing the two ' +
      'means either handing a shared secret to every provider or accepting unsigned money ' +
      'movements from anyone who guessed a URL (ADR-0052).\n\n' +
      '### Nothing books cash but a bank statement\n' +
      '`POST /ingest/settlement/:source` stores a claim by a party with an interest in the ' +
      'answer. It books nothing, says so in its own response, and is not a substitute for the ' +
      'statement (ADR-0027).',
  },
  servers: [{ url: 'http://localhost:8080', description: 'docker compose up' }],
  tags: [
    { name: 'Health', description: 'Up, and the one number that separates up from working.' },
    { name: 'Webhooks', description: 'The inbound rail nobody schedules but the provider. Signature-authenticated; accepted durably and interpreted afterwards.' },
    { name: 'Ingest', description: 'The two slow rails — what a PSP says it is sending, and what the bank says arrived — plus the queue that notices when their formats move.' },
    { name: 'Reconciliation', description: 'Running the matcher, and what it concluded.' },
    { name: 'Exceptions', description: 'Differences nobody has explained yet, and the one write a human makes.' },
    { name: 'Evidence', description: 'The documents reasoned from. Separately authorised and separately logged, because exfiltration is a read and every other control in this system governs writes.' },
  ],
  components: {
    securitySchemes: {
      apiKey: {
        type: 'apiKey',
        in: 'header',
        name: 'X-API-Key',
        description:
          'A per-principal key, as `principal:secret:grant|grant` in `RECON_API_KEYS`. Two grants ' +
          'exist beyond ordinary access: `evidence.raw` and `evidence.export`. A reconciliation ' +
          'operator who works the queue all day has no reason to hold either, and an audit log ' +
          'where everybody could have done everything narrows nothing down (ADR-0066).',
      },
      providerSignature: {
        type: 'apiKey',
        in: 'header',
        name: 'x-paystack-signature',
        description:
          'Not a credential this service issues. Each provider signs the raw request bytes with a ' +
          'shared secret using its own scheme and its own header — HMAC-SHA512 hex here, ' +
          'HMAC-SHA256 base64 there — and that knowledge lives inside the connector. The header ' +
          'named here is one example; the actual header varies by source.',
      },
      exportToken: {
        type: 'apiKey',
        in: 'query',
        name: 'token',
        description:
          'The single-use, short-lived token *is* the credential, and it travels in the path. ' +
          'Requiring a management key as well would mean an export could only be collected by ' +
          'somebody who already had access to the system it was exported from, which is very ' +
          'nearly the opposite of what an export is for.',
      },
    },
  },
  security: [{ apiKey: [] }],
} as const;

const ERROR = {
  type: 'object',
  properties: {
    error: { type: 'string', description: "The engine's own words, written for the person who tripped the rule." },
    code: { type: 'string', description: 'The domain error name, e.g. `UnbookableResolutionError`.' },
  },
  required: ['error'],
} as const;

const MONEY = {
  type: 'object',
  description:
    'An amount. `kobo` is a **decimal string**, never a JSON number — a JSON number is a ' +
    'double and a double is not a ledger amount. `formatted` rides along so that no consumer ' +
    'divides by 100 in JavaScript and turns an exact integer back into a float.',
  properties: {
    kobo: { type: 'string', pattern: '^-?[0-9]+$', examples: ['1183200'] },
    currency: { type: 'string', examples: ['NGN'] },
    formatted: { type: 'string', examples: ['₦11,832.00'] },
  },
  required: ['kobo', 'currency', 'formatted'],
} as const;

const REJECTED_ROW = {
  type: 'object',
  description:
    'A row that will not become a canonical record. Row-isolated on purpose: one mangled row ' +
    'in a five-thousand-row export must not cost you the other four thousand nine hundred and ' +
    'ninety-nine, so this appears inside a 201 rather than turning the upload into an error.',
  properties: {
    kind: {
      type: 'string',
      enum: ['malformed', 'not-a-settlement'],
      description:
        '`malformed` — structurally unusable, or its own numbers disagree. ' +
        '`not-a-settlement` — perfectly valid and not money arriving: a pending row, a debit, ' +
        'a currency this ledger does not keep books in.',
    },
    reason: { type: 'string' },
    raw: { description: 'The row as it arrived.' },
  },
} as const;

const ANOMALY_KIND = {
  type: 'string',
  enum: ['unknown_field', 'unknown_value', 'unknown_shape', 'malformed_rows'],
  description:
    'Ordered by how early it fires. `unknown_field` is the earliest warning available and ' +
    'arrives while everything still works — providers extend a format long before they break ' +
    'it. `malformed_rows` fires last, by which time the others have usually been true for weeks.',
} as const;

const DRIFT = {
  type: 'object',
  description:
    'Ways this file was not the file the parser expected (ADR-0067). Separate from `rejected`: ' +
    'a rejected row is a statement about that row, an anomaly is a statement about the format, ' +
    'keyed so the same drift seen next week is the same record rather than a new alert.',
  properties: {
    raised: { type: 'array', items: { type: 'string' }, description: 'Drift never seen before.' },
    recurring: { type: 'array', items: { type: 'string' } },
    reopened: {
      type: 'array',
      items: { type: 'string' },
      description: 'Drift that had resolved and has come back — a different conversation from `raised`.',
    },
    cleared: {
      type: 'array',
      items: { type: 'string' },
      description: 'Anomalies this source is no longer showing, closed without anybody clicking anything.',
    },
    observed: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          key: { type: 'string' },
          kind: ANOMALY_KIND,
          detail: { type: 'string', examples: ['$.data[].settlement_fee'] },
          occurrences: { type: 'integer' },
          rowsInFile: { type: 'integer' },
          firstSeenAt: {
            type: 'object',
            properties: { rowNumber: { type: ['integer', 'null'] }, path: { type: ['string', 'null'] } },
          },
          sample: { type: ['string', 'null'] },
          severity: { type: 'integer', minimum: 1, maximum: 3 },
        },
      },
    },
  },
} as const;

const STORED = {
  type: 'object',
  properties: { stored: { type: 'integer' }, duplicates: { type: 'integer' } },
} as const;

/** Errors that any authenticated route can return, described once. */
const UNAUTHORIZED = {
  description: 'No `X-API-Key`, or one that matches no principal. The two are deliberately indistinguishable.',
  content: { 'application/json': { schema: ERROR } },
} as const;

const json = (description: string, schema: unknown) =>
  ({ description, content: { 'application/json': { schema } } }) as const;

const problem = (description: string) =>
  ({ description, content: { 'application/json': { schema: ERROR } } }) as const;

/**
 * A file, as bytes.
 *
 * Every upload rail takes the artifact itself rather than a JSON array of records: the bytes
 * are the evidence, their SHA-256 is its identity, and a client that re-shaped an export
 * before sending it has destroyed the only artifact anybody can check a conclusion against
 * six months later (ADR-0033).
 */
const BINARY_BODY = {
  required: true,
  content: { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } },
} as const;

/**
 * What each operation returns, keyed by `METHOD /url` as Fastify knows it.
 *
 * Merged into the generated specification by `transform`. Nothing here is ever compiled into
 * a serialiser, so an omission is a gap in the docs and never a missing field in a response.
 */
export const OPERATIONS: Readonly<Record<string, Partial<FastifySchema> & Record<string, unknown>>> = {
  'GET /health': {
    response: {
      200: json(
        'Up, and working. `inbox.pending` is the number that separates the two: a service ' +
          'accepting deliveries and quietly not working them answers 200 all day.',
        {
          type: 'object',
          properties: {
            status: { type: 'string', examples: ['ok'] },
            database: { type: 'string', examples: ['reachable'] },
            inbox: { type: 'object', additionalProperties: true },
          },
        },
      ),
      503: problem('Postgres is unreachable. Not healthy, however cheerfully it could otherwise answer.'),
    },
  },

  'POST /webhooks/:source': {
    requestBody: {
      required: true,
      description:
        'The provider’s **raw bytes**, exactly as sent. Signatures are computed over bytes, ' +
        'and `JSON.parse` followed by re-serialising produces different ones — reordered keys, ' +
        'different whitespace, different unicode escaping — so a JSON body parser anywhere ' +
        'upstream rejects perfectly valid payloads.',
      content: { 'application/json': { schema: { type: 'string', format: 'binary' } } },
    },
    response: {
      200: json(
        'Accepted durably and nothing more (ADR-0050). The promise made to the provider is ' +
          '"we safely received this" — the only one keepable in milliseconds at a thousand ' +
          'deliveries a second, and the only one that stays true when the matcher is busy. ' +
          '`200` rather than the more accurate `202` because providers are not uniformly ' +
          'generous about which 2xx they accept, and being right about the verb is not worth ' +
          'a retry storm.',
        {
          type: 'object',
          properties: {
            accepted: { type: 'boolean' },
            deliveryId: { type: 'string' },
            duplicate: { type: 'boolean', description: 'A redelivery absorbed. Worth counting from outside.' },
          },
        },
      ),
      401: problem('Signature verification failed. No detail — anything more specific is a hint to whoever is guessing.'),
      404: problem('No adapter for this source.'),
      413: problem('Over `RECON_WEBHOOK_BYTES` (256 KB). This is the one unauthenticated write in the system.'),
      422: problem(
        'Authentic, and carrying a card number or sensitive authentication data. Refused at the ' +
          'door, before the durable insert — so there is nothing anybody has to go and delete (ADR-0066).',
      ),
      503: problem(
        'No `RECON_WEBHOOK_SECRET_<SOURCE>` configured, so the delivery cannot be authenticated. ' +
          'Nothing stored; the provider’s retry will land once it is set. Distinct from 404 on ' +
          'purpose — "never heard of this provider" and "misconfigured for one we have" lead to ' +
          'different phone calls.',
      ),
    },
  },

  'POST /ingest/settlement/:source': {
    requestBody: BINARY_BODY,
    response: {
      201: json('Stored. Books nothing — a PSP report is a claim by a party with an interest in the answer (ADR-0027).', {
        type: 'object',
        properties: {
          evidenceId: { type: 'string', description: 'SHA-256 of the bytes. Re-uploading the same file is a no-op by construction.' },
          format: { type: 'string', examples: ['flutterwave-settlements-api-v4'] },
          parserVersion: { type: 'string', examples: ['flutterwave-settlements/2'] },
          payouts: { type: 'object', additionalProperties: true },
          lines: STORED,
          rejected: { type: 'array', items: REJECTED_ROW },
          drift: DRIFT,
          degraded: {
            type: 'string',
            description:
              'Present only when this file drifted badly enough to say so out loud. The file is ' +
              'still admitted and whatever parsed is still stored — a bank adding a column must ' +
              'not stop the morning’s reconciliation — but a cron job that checks nothing else ' +
              'can still tell this 201 from a quiet Tuesday’s.',
          },
          booked: { type: 'string' },
        },
      }),
      400: problem('Empty body. The request body is the settlement file itself.'),
      401: UNAUTHORIZED,
      404: problem('`UnknownSourceError` — no adapter for this source.'),
      413: problem('Over `RECON_UPLOAD_BYTES` (32 MB).'),
      422: problem('`CardDataRefused` — the export carries a PAN or sensitive authentication data. Refused before an evidence record exists.'),
      501: problem(
        '`NoSettlementAdapterError`. Paystack’s settlement export has no fixture-verified ' +
          'column layout, so there is no parser — and inventing one from documentation produces ' +
          'a parser that looks right and books the wrong amounts (ADR-0025). Its webhook half ' +
          'works fully.',
      ),
    },
  },

  'POST /ingest/bank': {
    requestBody: BINARY_BODY,
    response: {
      201: json('Stored. This is the only evidence that can book cash — run `POST /reconcile/runs` next.', {
        type: 'object',
        properties: {
          evidenceId: { type: 'string' },
          format: { type: 'string', examples: ['recon-bank-statement-v1'] },
          parserVersion: { type: 'string' },
          lines: STORED,
          rejected: { type: 'array', items: REJECTED_ROW },
          drift: DRIFT,
          degraded: { type: 'string' },
          booked: { type: 'string' },
        },
      }),
      400: problem('Empty body. The request body is the statement file itself.'),
      401: UNAUTHORIZED,
      413: problem('Over `RECON_UPLOAD_BYTES` (32 MB).'),
      422: problem('`CardDataRefused`. A statement is the one artifact a human exported by hand from a portal, which is how the wrong export gets uploaded.'),
    },
  },

  'GET /balances': {
    response: {
      200: json('Derived from entries, never from a column somebody incremented.', {
        type: 'object',
        properties: {
          balances: {
            type: 'array',
            items: {
              type: 'object',
              description:
                'The account’s meaning travels with its balance, because "psp_receivable: ₦48,500" ' +
                'is a number and "money promised by PSPs and not yet in our hands" is an answer.',
              properties: {
                accountId: { type: 'string' },
                type: { type: ['string', 'null'] },
                meaning: { type: ['string', 'null'] },
                kobo: { type: 'string' },
                currency: { type: 'string' },
                formatted: { type: 'string' },
              },
            },
          },
        },
      }),
      401: UNAUTHORIZED,
    },
  },

  'GET /deliveries/:deliveryId': {
    response: {
      200: json(
        'What became of a webhook we acknowledged. The inbox’s promise is that a delivery is ' +
          'never lost between "200" and "booked", and a promise nobody can check is a slogan.',
        {
          type: 'object',
          properties: {
            deliveryId: { type: 'string' },
            source: { type: 'string' },
            state: { type: 'string', examples: ['booked'] },
            attempts: { type: 'integer' },
            detail: { type: ['string', 'null'] },
            lastError: { type: ['string', 'null'] },
            transactionId: { type: ['string', 'null'] },
            receivedAt: { type: 'string', format: 'date-time' },
            processedAt: { type: ['string', 'null'], format: 'date-time' },
            held: {
              type: 'object',
              description:
                'What is still held of the provider’s payload. Without this, the one question a ' +
                'data-protection request actually asks — "do you still have my details?" — was ' +
                'answerable only by somebody with database access (ADR-0064).',
              properties: { content: { type: 'string' }, redactedAt: { type: ['string', 'null'] } },
            },
          },
        },
      ),
      401: UNAUTHORIZED,
      404: problem('No such delivery.'),
    },
  },

  'POST /reconcile/runs': {
    response: {
      201: json(
        'What the run did, rather than everything it looked at — the run object carries every ' +
          'match and rejected candidate it considered, which is megabytes on a busy day and not ' +
          'what the caller asked. Bounded by `RECON_RECONCILE_LIMIT`: subset-sum over an ' +
          'unbounded set of open promises is how a matcher stops returning (ADR-0053).',
        {
          type: 'object',
          properties: {
            asOf: { type: 'string', format: 'date-time' },
            allocated: { type: 'array', items: { type: 'object', properties: { reason: { type: 'string' }, count: { type: 'integer' } } } },
            confirmed: { type: 'array', items: { type: 'object', additionalProperties: true } },
            deferred: { type: 'array', items: { type: 'object', additionalProperties: true } },
            exceptions: { type: 'array', items: { type: 'object', additionalProperties: true } },
            booked: { type: 'array', items: { type: 'object', additionalProperties: true } },
            failures: { type: 'array', items: { type: 'object', additionalProperties: true } },
            queue: { type: 'object', additionalProperties: true },
          },
        },
      ),
      401: UNAUTHORIZED,
    },
  },

  'GET /reconciliation/summary': {
    response: {
      200: json('Totals, conclusions by reason, and what is still awaiting bank credit.', {
        type: 'object',
        properties: {
          from: { type: 'string', format: 'date-time' },
          to: { type: 'string', format: 'date-time' },
          totals: { type: 'object', additionalProperties: true },
          conclusions: { type: 'object', additionalProperties: true },
          queue: { type: 'array', items: { type: 'object', additionalProperties: true } },
          awaitingBankCredit: { type: 'object', properties: { count: { type: 'integer' }, expectedNet: MONEY } },
          banked: { type: 'object', properties: { transactions: { type: 'integer' }, credited: MONEY } },
        },
      }),
      400: problem('`from` and `to` must be ISO-8601 instants.'),
      401: UNAUTHORIZED,
    },
  },

  'GET /exceptions': {
    response: {
      200: json(
        'Differences nobody has explained yet, worst first — sorted by what the problem is ' +
          'rather than when it arrived, because a queue ordered by arrival buries the alarming ' +
          'entries under the routine ones.',
        { type: 'object', properties: { exceptions: { type: 'array', items: { type: 'object', additionalProperties: true } } } },
      ),
      400: problem('`limit` must be an integer between 1 and 1000.'),
      401: UNAUTHORIZED,
    },
  },

  'GET /exceptions/:key': {
    response: {
      200: json(
        'The exception, plus its whole history. Nothing here was ever overwritten: raised on ' +
          'Tuesday, acknowledged by a named person on Wednesday, resolved by evidence on ' +
          'Thursday (ADR-0043).',
        {
          type: 'object',
          properties: {
            exception: { type: 'object', additionalProperties: true },
            history: { type: 'array', items: { type: 'object', additionalProperties: true } },
          },
        },
      ),
      401: UNAUTHORIZED,
      404: problem('No such exception.'),
    },
  },

  'POST /exceptions/:key/resolve': {
    response: {
      201: json('The decision, the compensating entry, and the closing of the queue item — one transaction.', {
        type: 'object',
        properties: {
          resolutionKey: { type: 'string' },
          bookedTransactionId: { type: ['string', 'null'] },
          exceptionClosed: { type: 'boolean' },
        },
      }),
      400: problem('Schema violation. Amounts must be decimal strings; a JSON number is a double.'),
      401: UNAUTHORIZED,
      404: problem('No such exception.'),
      409: problem(
        'The exception is no longer open — cleared by evidence between your read and your write. ' +
          'A settlement file beat the operator to it, which is the machine doing its job.',
      ),
      422: problem(
        'Refused on the merits, and the message names the money and the rule. ' +
          '`UnapprovedResolutionError` (maker-checker, ADR-0042) · `UnbookableResolutionError` ' +
          '(a resolution may not move `bank_account`) · `UnbalancedTransactionError` · ' +
          '`LawViolationError`.',
      ),
    },
  },

  'GET /ingest/anomalies': {
    response: {
      200: json(
        'The drift queue: foreign formats that have moved, worst first (ADR-0067). Separate from ' +
          '`/exceptions` because an exception is a money difference a person answers with a ' +
          'resolution, and this is a statement about a parser with no amount and nothing to resolve.',
        {
          type: 'object',
          properties: {
            anomalies: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  key: { type: 'string' },
                  source: { type: 'string' },
                  kind: ANOMALY_KIND,
                  detail: { type: 'string' },
                  state: { type: 'string', enum: ['open', 'acknowledged', 'resolved'] },
                  severity: { type: 'integer', minimum: 1, maximum: 3 },
                  since: { type: 'string', format: 'date-time' },
                  firstSeen: {
                    type: 'string',
                    format: 'date-time',
                    description:
                      'When this drift was first seen, across every file. The column that turns an ' +
                      'anomaly into a diagnosis: a field that first appeared the day the fee ' +
                      'variances began is an explanation.',
                  },
                  lastSeen: { type: 'string', format: 'date-time' },
                  filesAffected: { type: 'integer' },
                  timesRaised: { type: 'integer' },
                  occurrences: { type: 'integer' },
                  rowsInFile: { type: 'integer' },
                  share: {
                    type: 'number',
                    description:
                      'The share of the most recent file that showed it. One malformed row in five ' +
                      'thousand and four thousand in five thousand are the same kind and different ' +
                      'events; only this tells them apart.',
                  },
                  evidenceId: { type: ['string', 'null'] },
                  parserVersion: { type: ['string', 'null'] },
                  format: { type: ['string', 'null'] },
                  firstPath: { type: ['string', 'null'] },
                  sample: { type: ['string', 'null'] },
                },
              },
            },
          },
        },
      ),
      400: problem('`limit` must be an integer between 1 and 1000.'),
      401: UNAUTHORIZED,
    },
  },

  'POST /ingest/anomalies/:key/acknowledge': {
    response: {
      200: json('Owned. Still drifting, but no longer unowned — and it stays acknowledged when the next file shows the same drift.', {
        type: 'object',
        properties: { acknowledged: { type: 'string' }, by: { type: 'string' } },
      }),
      401: UNAUTHORIZED,
      409: problem('No such anomaly, or it is not in a state that can be acknowledged.'),
    },
  },

  'GET /evidence/:id': {
    response: {
      200: json(
        'Metadata and the access log. No grant required, because none of it is personal data — ' +
          'which is exactly why the bytes live behind a different endpoint.',
        {
          type: 'object',
          properties: {
            evidenceId: { type: 'string' },
            kind: { type: 'string', enum: ['psp_settlement', 'bank_statement', 'webhook'] },
            source: { type: 'string' },
            filename: { type: ['string', 'null'] },
            byteLength: { type: 'integer' },
            receivedFrom: { type: 'string' },
            receivedAt: { type: 'string', format: 'date-time' },
            parserVersion: { type: 'string', description: 'The parser is part of the reasoning. When an adapter is corrected, every conclusion the old one reached is suspect — and findable.' },
            storageLocation: { type: ['string', 'null'] },
            held: {
              type: 'object',
              additionalProperties: true,
              description: '"Purged on schedule" and "we cannot find it" are different answers leading to very different conversations.',
            },
            access: { type: 'array', items: { type: 'object', additionalProperties: true } },
          },
        },
      ),
      401: UNAUTHORIZED,
      404: problem('No such evidence.'),
    },
  },

  'GET /evidence/:id/raw': {
    response: {
      200: {
        description:
          'The bytes. `x-recon-evidence-content` says whether these are the original or a ' +
          'redacted copy — the one header that stops a redacted copy being presented, six months ' +
          'from now, as what the provider sent.',
        headers: {
          'x-recon-evidence-content': { schema: { type: 'string', enum: ['original', 'redacted'] } },
          'x-recon-hash-matches-id': { schema: { type: 'string', enum: ['true', 'false'] } },
        },
        content: { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } },
      },
      400: problem(
        'A `reason` is required. An access record with a name and no reason answers half the ' +
          'question an auditor asks, and this endpoint exists to answer the other half.',
      ),
      401: UNAUTHORIZED,
      403: problem('This key does not hold the `evidence.raw` grant. The refusal is recorded.'),
      404: problem('No such evidence.'),
      410: problem(
        'The bytes were destroyed on schedule. The *record* — hash, lineage, parser version, and ' +
          'every conclusion drawn from it — is still here (ADR-0065). Deliberately not a 404: ' +
          '"destroyed on schedule" and "never heard of it" are different facts and only one means ' +
          'somebody should go looking.',
      ),
    },
  },

  'POST /evidence/:id/exports': {
    response: {
      201: json(
        'A copy, sealed. `url` and `archiveKey` are returned exactly once and nothing stores ' +
          'either — an export whose link or key was lost is re-requested, never recovered, which ' +
          'is correct for a credential and correct for a copy of somebody’s personal data.',
        {
          type: 'object',
          properties: {
            exportId: { type: 'string' },
            content: { type: 'string', enum: ['original', 'redacted'] },
            byteLength: { type: 'integer' },
            expiresAt: { type: 'string', format: 'date-time' },
            url: { type: 'string' },
            archiveKey: { type: 'string' },
            archiveFormat: { type: 'string', examples: ['aes-256-gcm; nonce(12) ‖ tag(16) ‖ ciphertext; aad=export_id'] },
          },
        },
      ),
      400: problem('Schema violation — `reason` is required.'),
      401: UNAUTHORIZED,
      403: problem('This key does not hold the `evidence.export` grant.'),
      422: problem('`UnapprovedExportError` — an original needs a second named approver, measured against the same policy a write-off is (ADR-0042).'),
    },
  },

  'GET /evidence/exports/:token': {
    response: {
      200: {
        description: 'The sealed archive. AES-256-GCM under the key returned when the export was approved, with the export id as additional data — so the file is useless to a proxy, a cache, or anybody it is forwarded to.',
        content: { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } },
      },
      404: problem('No such export — the same answer a token that never existed gets. Guessing must learn nothing.'),
      410: problem(
        'Expired, or already collected. Each export may be collected once, and saying which is ' +
          'a deliberate leak of one bit: if a link has been used and the person holding it did ' +
          'not use it, they need to know today rather than at the next audit.',
      ),
    },
  },
};
