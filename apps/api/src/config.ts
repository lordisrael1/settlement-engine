import type { MerchantId, SourceId } from '@recon/canon';
import { keyRingFromEnv, retentionFromEnv } from '@recon/protect';
import { DEFAULT_SUBSET_LIMITS, type EvidenceVault, type SubsetLimits } from '@recon/reconciler';

import { Principals } from './principals.js';
import type { RateLimit } from './ratelimit.js';

/**
 * Everything the service needs to know that is not in the code.
 *
 * Read once, at startup, and handed to everything else as an argument — the same
 * discipline the packages apply to the clock. A route that reads `process.env` is a route
 * whose behaviour depends on ambient state nobody passed it, which is untestable in the
 * way that matters: you cannot run two configurations in one process.
 */
export interface Config {
  readonly host: string;
  readonly port: number;

  /**
   * Who may call the management endpoints, and what each of them may do.
   *
   * Webhooks do **not** use this — a PSP has no key of ours and authenticates by signing
   * the bytes it sends (ADR-0052). Per principal rather than one shared key, because the
   * evidence endpoints record who read what and a shared key makes that record say "api"
   * (ADR-0066).
   */
  readonly principals: Principals;

  /**
   * Where evidence keys come from, and how long each version of a document is kept.
   *
   * Read at startup and passed down, so a route never reaches for ambient state and a test
   * can run two schedules in one process (ADR-0063).
   */
  readonly vault: EvidenceVault;

  /**
   * How long an export link lives. Minutes, not days: a download link valid for a week is a
   * download link somebody forwards.
   */
  readonly exportTtlMs: number;

  /** Whose books these are. Fee contracts are negotiated per merchant. */
  readonly merchantId: MerchantId;
  /** Which of our own bank accounts a statement upload is about, when it does not say. */
  readonly bankAccountId: string;
  readonly bank: string;

  /**
   * The secrets a source's deliveries may be signed with, newest first. Empty if we hold
   * none.
   *
   * A lookup keyed by data, not a branch on a name: adding a source adds an environment
   * variable and nothing else (the canonical boundary).
   *
   * **A list, because rotation has an overlap.** A delivery is verified twice — once at the
   * door and once again by the worker that interprets it — and a secret rotated while a
   * backlog exists would fail the second check for every pending delivery signed with the
   * old one. The worker's answer to a signature that no longer verifies is `rejected`, which
   * is terminal: real payments, discarded, because a credential was rotated on a busy
   * afternoon. So `RECON_WEBHOOK_SECRET_<SOURCE>_PREVIOUS` is held alongside the current one
   * and tried too, and it is removed once the queue has drained (ADR-0073).
   */
  readonly webhookSecrets: (source: SourceId) => readonly string[];

  readonly drain: {
    /** How often a worker looks for deliveries it has not been told about. */
    readonly intervalMs: number;
    readonly batch: number;
    readonly maxAttempts: number;
  };

  readonly limits: {
    /**
     * Webhook bodies are small — a few kilobytes of JSON — and the endpoint is the one
     * unauthenticated write in the system. A generous limit there is an invitation.
     */
    readonly webhookBytes: number;
    /** Statement and settlement exports are not small. */
    readonly uploadBytes: number;
  };

  /** How many records one reconciliation run may consider. Bounded on purpose (ADR-0053). */
  readonly reconcileLimit: number;

  /**
   * How fast one caller may knock, per instance.
   *
   * The webhook rail is the one that needs it: unauthenticated by design, and the work of
   * deciding a delivery is unauthentic — buffering the body, HMAC-ing all of it — happens
   * before the 401. Per-process and in-memory, so this is the floor rather than the control;
   * the real limit belongs at a gateway that can see every replica's traffic. See
   * `ratelimit.ts`.
   */
  readonly rateLimits: {
    readonly webhook: RateLimit;
    readonly management: RateLimit;
  };

  /**
   * When the service should stop saying it is fine.
   *
   * `/health` reported the inbox depth and left the reader to decide what a big number
   * meant, which in practice means nobody decided: a monitor watching for a non-200 sees a
   * queue grow all weekend and never fires. These turn the numbers into a verdict the
   * monitor can act on without knowing anything about reconciliation.
   */
  readonly alerts: {
    /** A pending inbox deeper than this is a worker that has stopped, not a busy minute. */
    readonly inboxPending: number;
    /** Deliveries nobody will retry. The honest threshold is one. */
    readonly inboxFailed: number;
    /** How stale the oldest unworked delivery may get before it is an incident. */
    readonly inboxAgeMs: number;
    /** Open exceptions past which the queue is no longer a queue. */
    readonly openExceptions: number;
    /**
     * How long reconciliation may go unrun.
     *
     * Nothing surfaces an exception until a run happens, so a scheduler that died is a
     * system that has silently stopped reconciling while continuing to answer 200 to
     * everything (ADR-0074).
     */
    readonly reconcileAgeMs: number;
    /**
     * How long the books may go without a human comparing them to the bank's own portal.
     *
     * The one threshold here that is not about a process failing. Cash is booked on an
     * uploaded file and nothing proves that file came from the bank (ADR-0068), so the only
     * control over a fabricated statement is out-of-band and human — and an out-of-band
     * control nobody measures is one that quietly stops happening. This measures it.
     *
     * Checked only once a statement has actually been ingested: a database nobody has used
     * yet has no books to compare, and alerting about it would teach whoever set this up to
     * ignore the alert on their first afternoon.
     */
    readonly attestationAgeMs: number;
  };

  /**
   * How often to reconcile on our own, in milliseconds. Zero disables it.
   *
   * Off by default so that a second replica does not silently double the runs and so a
   * deployment driving reconciliation from its own cron is not fighting an internal timer.
   * A deployment that sets neither reconciles only when a person remembers to — which for a
   * system whose entire value is surfacing anomalies is the same as not having one.
   */
  readonly reconcileIntervalMs: number;

  /**
   * How much of a payout the bounded subset search may consider.
   *
   * Configurable because the shipped default of 24 is a *small-batch* bound and a provider
   * that reports payout totals without per-line references would push every large payout past
   * it. Raising it is not free: the search is exponential in this number, so `maxSteps` is
   * what actually stops it, and both move together. See ADR-0070 and PERFORMANCE.md.
   */
  readonly subsetLimits: SubsetLimits;
}

export class ConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigurationError';
  }
}

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): Config {
  if (env['RECON_API_KEY']) {
    // Not a fallback. One shared key cannot tell two operators apart, and the evidence
    // endpoints record who read what — so a deployment still setting the old variable is a
    // deployment whose access log would be a list of the word "api". Refusing to start with
    // the replacement named is the shortest path to it being set correctly.
    throw new ConfigurationError(
      'RECON_API_KEY is set and is no longer read. Keys now belong to named principals, ' +
        'because an audit record naming an operator who named themselves answers "what did ' +
        'somebody type?" rather than "who did this?" (ADR-0066). Replace it with ' +
        'RECON_API_KEYS, a comma-separated list of "principal:secret:grant|grant".',
    );
  }

  // Refusing to start is the point. A service that quietly serves balances and books
  // resolutions with no credential because a variable was missing is worse than one that
  // does not come up, and the second failure is the one somebody notices.
  const principals = Principals.fromEnv(env['RECON_API_KEYS']);

  return {
    host: env['RECON_HOST'] ?? '0.0.0.0',
    port: number(env, 'PORT', 8080),
    principals,
    // Throws when no key is configured. Evidence is encrypted before it is stored and there
    // is deliberately no unencrypted path, so there is nothing sensible to do without one.
    vault: { keyRing: keyRingFromEnv(env), retention: retentionFromEnv(env) },
    exportTtlMs: number(env, 'RECON_EXPORT_TTL_MS', 15 * 60 * 1000),
    merchantId: env['RECON_MERCHANT'] ?? 'default-merchant',
    bankAccountId: env['RECON_BANK_ACCOUNT'] ?? 'primary',
    bank: env['RECON_BANK'] ?? 'bank',
    webhookSecrets: (source) => {
      const name = source.toUpperCase();
      // Current first, so the overwhelmingly common case costs one HMAC. The previous secret
      // is tried only when the current one has already failed, which during a rotation is
      // exactly the backlog and nothing else.
      return [
        env[`RECON_WEBHOOK_SECRET_${name}`],
        env[`RECON_WEBHOOK_SECRET_${name}_PREVIOUS`],
      ].filter((secret): secret is string => typeof secret === 'string' && secret !== '');
    },
    drain: {
      intervalMs: number(env, 'RECON_DRAIN_INTERVAL_MS', 500),
      batch: number(env, 'RECON_DRAIN_BATCH', 100),
      maxAttempts: number(env, 'RECON_DRAIN_MAX_ATTEMPTS', 8),
    },
    limits: {
      webhookBytes: number(env, 'RECON_WEBHOOK_BYTES', 256 * 1024),
      uploadBytes: number(env, 'RECON_UPLOAD_BYTES', 32 * 1024 * 1024),
    },
    reconcileLimit: number(env, 'RECON_RECONCILE_LIMIT', 1000),
    rateLimits: {
      // High enough that a provider clearing a backlog after their own outage — which is
      // when the burstiest legitimate traffic arrives — is never refused. It is a ceiling on
      // abuse, not a shaping policy.
      webhook: {
        perWindow: optional(env, 'RECON_RATE_WEBHOOK_PER_MINUTE', 1200),
        windowMs: 60_000,
        maxKeys: number(env, 'RECON_RATE_MAX_KEYS', 10_000),
      },
      // Lower, because these are humans and scripts, and because one operator's runaway
      // loop must not crowd out another's.
      management: {
        perWindow: optional(env, 'RECON_RATE_MANAGEMENT_PER_MINUTE', 600),
        windowMs: 60_000,
        maxKeys: number(env, 'RECON_RATE_MAX_KEYS', 10_000),
      },
    },
    alerts: {
      inboxPending: optional(env, 'RECON_ALERT_INBOX_PENDING', 1000),
      // One. A failed delivery is a payment nobody will retry without a person, and there is
      // no number of those that is fine.
      inboxFailed: optional(env, 'RECON_ALERT_INBOX_FAILED', 1),
      inboxAgeMs: optional(env, 'RECON_ALERT_INBOX_AGE_MS', 15 * 60 * 1000),
      openExceptions: optional(env, 'RECON_ALERT_OPEN_EXCEPTIONS', 500),
      reconcileAgeMs: optional(env, 'RECON_ALERT_RECONCILE_AGE_MS', 26 * 60 * 60 * 1000),
      // A week. Long enough not to be a chore, short enough that a fabricated statement
      // cannot sit in the books for a quarter.
      attestationAgeMs: optional(env, 'RECON_ALERT_ATTESTATION_AGE_MS', 7 * 24 * 60 * 60 * 1000),
    },
    reconcileIntervalMs: optional(env, 'RECON_RECONCILE_INTERVAL_MS', 0),
    subsetLimits: {
      maxCandidates: number(
        env,
        'RECON_SUBSET_MAX_CANDIDATES',
        DEFAULT_SUBSET_LIMITS.maxCandidates,
      ),
      maxSubsetSize: number(env, 'RECON_SUBSET_MAX_SIZE', DEFAULT_SUBSET_LIMITS.maxSubsetSize),
      maxSteps: number(env, 'RECON_SUBSET_MAX_STEPS', DEFAULT_SUBSET_LIMITS.maxSteps),
    },
  };
}

/**
 * Like `number`, but zero is a value rather than a mistake.
 *
 * Every knob above uses zero to mean "off" — no rate limit, no scheduler, no alert — and
 * `number` rejects it, correctly, because a batch size of zero or a port of zero is a typo.
 * Two readers rather than one `allowZero` flag, so that the refusal stays loud where it
 * belongs.
 */
function optional(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;

  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new ConfigurationError(
      `${name} must be a non-negative integer (0 disables it); got "${raw}".`,
    );
  }
  return value;
}

function number(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;

  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new ConfigurationError(`${name} must be a positive integer; got "${raw}".`);
  }
  return value;
}
