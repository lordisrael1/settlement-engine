import type { MerchantId, SourceId } from '@recon/canon';
import { keyRingFromEnv, retentionFromEnv } from '@recon/protect';
import type { EvidenceVault } from '@recon/reconciler';

import { Principals } from './principals.js';

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
   * The shared secret a source signs its deliveries with, or `null` if we hold none.
   *
   * A lookup keyed by data, not a branch on a name: adding a source adds an environment
   * variable and nothing else (the canonical boundary).
   */
  readonly webhookSecret: (source: SourceId) => string | null;

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
    webhookSecret: (source) => env[`RECON_WEBHOOK_SECRET_${source.toUpperCase()}`] ?? null,
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
  };
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
