/**
 * Reading the key ring and the retention schedule out of the environment.
 *
 * Two deployables need both — the service encrypts what it ingests, the CLI runs the
 * retention command — and a control implemented twice is one chance to implement it twice
 * differently. So the parsing lives here, beside the things it produces, and the
 * deployables read it once at startup and pass it down as an argument like everything else.
 *
 * This file parses strings. It does not read `process.env` on its own, does not cache, and
 * does not decide anything: the environment arrives as a parameter so a test can run two
 * configurations in one process.
 */

import type { RetentionSchedule } from '@recon/canon';
import { DEFAULT_RETENTION } from '@recon/canon';

import { localKeyRing, parseLocalKey, type KeyRing } from './envelope.js';

export class ProtectionConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProtectionConfigurationError';
  }
}

type Env = Record<string, string | undefined>;

/**
 * The key ring, from `RECON_EVIDENCE_KEY` and any retired keys still needed to read old
 * blobs.
 *
 * Refusing to start without one is the point, exactly as it is for the API credential. The
 * alternative — falling back to storing evidence unencrypted when a variable is missing —
 * is a system that quietly stops doing the thing this whole package exists for, and the
 * failure would be discovered by an auditor rather than by a deploy.
 */
export function keyRingFromEnv(env: Env): KeyRing {
  const active = env['RECON_EVIDENCE_KEY'];
  if (!active) {
    throw new ProtectionConfigurationError(
      'RECON_EVIDENCE_KEY is not set. Evidence is encrypted per record before it is stored ' +
        'and there is deliberately no unencrypted path (ADR-0063), so there is nothing ' +
        'sensible to do without a key. Generate one with:\n\n' +
        '    echo "k1:$(openssl rand -base64 32)"\n',
    );
  }

  const keys = [parseLocalKey(active)];
  const retired = env['RECON_EVIDENCE_KEYS_RETIRED'];
  if (retired) {
    // A retired key stays configured for as long as anything sealed under it is still
    // within its retention. Dropping it early does not delete that evidence; it makes it
    // unreadable, which is worse, because nothing says so until somebody asks for it.
    for (const spec of retired.split(',').map((part) => part.trim()).filter(Boolean)) {
      keys.push(parseLocalKey(spec));
    }
  }

  const active_key = keys[0];
  if (!active_key) throw new ProtectionConfigurationError('RECON_EVIDENCE_KEY parsed to nothing.');

  return localKeyRing(keys, active_key.keyId);
}

/**
 * The retention schedule, from the environment, defaulting to `DEFAULT_RETENTION`.
 *
 * The defaults are a starting position and not a legal opinion. `RECON_RETENTION_*` exists
 * because the redacted horizon in particular is a figure a Nigerian deployment confirms
 * against CBN and FIRS record-keeping obligations with counsel, and nobody should have to
 * edit a TypeScript constant to record that answer (ADR-0065).
 */
export function retentionFromEnv(env: Env): RetentionSchedule {
  return {
    originalDays: days(env, 'RECON_RETENTION_ORIGINAL_DAYS', DEFAULT_RETENTION.originalDays),
    redactedDays: days(env, 'RECON_RETENTION_REDACTED_DAYS', DEFAULT_RETENTION.redactedDays),
    inboxOriginalDays: days(env, 'RECON_RETENTION_INBOX_DAYS', DEFAULT_RETENTION.inboxOriginalDays),
  };
}

function days(env: Env, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;

  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new ProtectionConfigurationError(
      `${name} must be a positive whole number of days; got "${raw}". A retention of zero ` +
        `is not a policy — it is a deletion, and one somebody should have to write down.`,
    );
  }
  return value;
}
