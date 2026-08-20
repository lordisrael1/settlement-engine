import type { MerchantId, SourceId } from '@recon/canon';

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
   * The management credential. Webhooks do **not** use it — a PSP has no key of ours and
   * authenticates by signing the bytes it sends (ADR-0052).
   */
  readonly apiKey: string;

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
  const apiKey = env['RECON_API_KEY'];
  if (!apiKey) {
    // Refusing to start is the point. A service that quietly serves balances and books
    // resolutions with no credential because a variable was missing is worse than one that
    // does not come up, and the second failure is the one somebody notices.
    throw new ConfigurationError(
      'RECON_API_KEY is not set. The management endpoints expose balances, ingestion and ' +
        'the resolution path; there is deliberately no way to run them unauthenticated.',
    );
  }
  if (apiKey.length < 16) {
    throw new ConfigurationError(
      `RECON_API_KEY is ${apiKey.length} characters. A key short enough to guess is a key ` +
        `that will be; use at least 16.`,
    );
  }

  return {
    host: env['RECON_HOST'] ?? '0.0.0.0',
    port: number(env, 'PORT', 8080),
    apiKey,
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
