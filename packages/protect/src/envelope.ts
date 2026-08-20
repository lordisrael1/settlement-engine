/**
 * Envelope encryption, done in the application rather than by the disk.
 *
 * Disk encryption protects against somebody carrying the server out of the building, which
 * is not how this data leaks. The three ways it actually leaks are a `pg_dump` somebody
 * took to debug something, a read replica nobody remembered was there, and a backup on
 * object storage with the wrong ACL. Every one of them reads the bytes through Postgres or
 * through a file Postgres wrote, and every one of them is defeated by the same thing:
 * ciphertext in the column, and the key somewhere the database has never heard of.
 *
 * The shape is the standard one, and it is standard because each part earns its place:
 *
 *   **AES-256-GCM per record.** Authenticated, so a ciphertext that has been altered fails
 *   to decrypt rather than decrypting to something else. `crypto.createCipheriv` is in the
 *   Node standard library, so this adds no dependency.
 *
 *   **A fresh data key per record, wrapped by a root key.** Only the wrapped key is stored.
 *   Rotation re-wraps data keys instead of re-encrypting payloads, which is why
 *   `evidence_blobs` is a mutable table by design — rotating a root key over a hundred
 *   thousand evidence rows must not mean rewriting a hundred thousand payloads.
 *
 *   **Additional authenticated data, which is the evidence id.** A ciphertext cannot be
 *   lifted out of one row and dropped into another: decryption under the wrong id fails.
 *   Without it, a database write anybody can make would let one document's bytes be served
 *   as another document's evidence, which is precisely the thing evidence exists to rule
 *   out.
 *
 * `KeyRing` is deliberately the shape of a KMS `Encrypt`/`Decrypt` pair — a key id, an
 * opaque wrapped blob, and an encryption context — so a deployment on AWS KMS, GCP KMS or
 * Vault transit writes one adapter and changes nothing else. The implementation here holds
 * a root key in the process, which is the honest option for a deployment that has not
 * chosen a KMS yet, and is explicitly not the destination (ADR-0063).
 */

import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const KEY_BYTES = 32;
const NONCE_BYTES = 12;

/**
 * Where root keys live and what they can do: wrap a data key, and unwrap one.
 *
 * Note what is absent — anything that decrypts a payload, anything that lists keys, and
 * anything that deletes one. Key destruction is not a power this service has, deliberately:
 * the service can read evidence and cannot make evidence unreadable, and separating those
 * is what makes a compromised service credential a data-exposure problem rather than a
 * data-loss one.
 */
export interface KeyRing {
  /** The key that wraps *new* data keys. Recorded with each blob so rotation is visible. */
  readonly activeKeyId: string;
  wrap(dataKey: Buffer, context: EncryptionContext): Promise<{ keyId: string; wrapped: Buffer }>;
  unwrap(wrapped: Buffer, keyId: string, context: EncryptionContext): Promise<Buffer>;
}

/**
 * The binding between a key operation and the thing it is for.
 *
 * Passed to a KMS as its encryption context and used here as GCM additional data, which is
 * the same guarantee under two names: an unwrap that does not name the same evidence id
 * fails. In CloudTrail it is also what turns a `Decrypt` call into a readable audit line —
 * "this principal decrypted evidence 9f3a…", logged by a system this one cannot write to.
 */
export type EncryptionContext = Readonly<Record<string, string>>;

/** A payload encrypted directly under a key somebody already holds. */
export interface SealedBytes {
  readonly ciphertext: Buffer;
  readonly nonce: Buffer;
  readonly authTag: Buffer;
}

/** One encrypted payload, as it is stored. Every field is needed to get the bytes back. */
export interface Sealed extends SealedBytes {
  /** Which root key wrapped this record's data key. Rotation makes this vary across rows. */
  readonly keyId: string;
  readonly wrappedKey: Buffer;
}

export class DecryptionFailed extends Error {
  constructor(message: string, options?: { cause: unknown }) {
    super(message, options);
    this.name = 'DecryptionFailed';
  }
}

/**
 * Encrypt one payload under a data key that exists only for it.
 *
 * The data key is generated, used once and never stored — only its wrapped form is. There
 * is no path by which a plaintext data key reaches the database, which is what makes
 * "the database holds no key material" a structural statement rather than a habit.
 */
export async function seal(
  keyRing: KeyRing,
  plaintext: Buffer,
  context: EncryptionContext,
): Promise<Sealed> {
  const dataKey = randomBytes(KEY_BYTES);
  const { ciphertext, nonce, authTag } = sealWithKey(dataKey, plaintext, context);

  const { keyId, wrapped } = await keyRing.wrap(dataKey, context);
  // Not a defence against an attacker, who is not in this process — a defence against the
  // data key outliving its use in a heap snapshot or a core dump.
  dataKey.fill(0);

  return { ciphertext, nonce, authTag, keyId, wrappedKey: wrapped };
}

/**
 * Get the bytes back, or fail loudly.
 *
 * There is no partial success and no fallback. A payload that will not authenticate has
 * either been altered or been paired with the wrong evidence id, and both of those are the
 * question this whole mechanism exists to answer — so the answer is an exception, not a
 * best effort.
 */
export async function unseal(
  keyRing: KeyRing,
  sealed: Sealed,
  context: EncryptionContext,
): Promise<Buffer> {
  const dataKey = await keyRing.unwrap(sealed.wrappedKey, sealed.keyId, context);

  try {
    return openWithKey(dataKey, sealed, context);
  } catch (error) {
    throw new DecryptionFailed(
      `Evidence sealed under key "${sealed.keyId}" did not authenticate. Either the stored ` +
        `bytes were altered, or they are being read under a different evidence id from the ` +
        `one they were written under.`,
      { cause: error },
    );
  } finally {
    dataKey.fill(0);
  }
}

/**
 * Encrypt under a key the caller supplies, with no wrapping and no key ring.
 *
 * The primitive `seal` is built from, exposed because one caller genuinely needs it: an
 * export archive is sealed under a key handed to the requester once and never stored, so
 * there is nothing to wrap and nobody here can open it afterwards. That is the property
 * that makes "delivered as an encrypted archive" mean something — the stored archive is
 * unreadable to the database, to a backup of it, and to this service.
 */
export function sealWithKey(
  key: Buffer,
  plaintext: Buffer,
  context: EncryptionContext,
): SealedBytes {
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, nonce);
  cipher.setAAD(aad(context));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { ciphertext, nonce, authTag: cipher.getAuthTag() };
}

/** The other half of `sealWithKey`. Throws on any alteration, as GCM is meant to. */
export function openWithKey(
  key: Buffer,
  sealed: SealedBytes,
  context: EncryptionContext,
): Buffer {
  const decipher = createDecipheriv(ALGORITHM, key, sealed.nonce);
  decipher.setAAD(aad(context));
  decipher.setAuthTag(sealed.authTag);
  return Buffer.concat([decipher.update(sealed.ciphertext), decipher.final()]);
}

/** A fresh 256-bit key. For an archive nobody stores, or a data key nobody keeps. */
export function freshKey(): Buffer {
  return randomBytes(KEY_BYTES);
}

/** The encryption context, flattened to bytes, in an order that does not depend on insertion. */
function aad(context: EncryptionContext): Buffer {
  const pairs = Object.entries(context)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`);
  return Buffer.from(pairs.join(''), 'utf8');
}

// ── The key ring a deployment without a KMS uses ────────────────────────────

/**
 * A root key held in the process, from configuration.
 *
 * The honest option when no KMS has been chosen, and no more than that. What it gives up,
 * stated plainly so nobody has to work it out later: the key is in the process environment,
 * so anything that can read the environment can read every evidence blob; key use produces
 * no independent audit trail, so the only record of a decryption is one this system writes
 * about itself; and destroying a key means editing configuration rather than making an API
 * call somebody else's logs record.
 *
 * What it keeps: the ciphertext in the database is unreadable to a `pg_dump`, a replica or
 * a leaked backup, which is the exposure that actually happens. Swapping in a KMS adapter
 * changes this file and nothing else (ADR-0063).
 */
export function localKeyRing(keys: readonly LocalKey[], activeKeyId: string): KeyRing {
  if (keys.length === 0) {
    throw new Error('A key ring with no keys cannot encrypt anything.');
  }

  const byId = new Map(keys.map((key) => [key.keyId, key.key]));
  const active = byId.get(activeKeyId);
  if (!active) {
    throw new Error(
      `The active key id "${activeKeyId}" is not among the configured keys ` +
        `(${[...byId.keys()].join(', ')}). Evidence would be written under a key nothing ` +
        `can unwrap.`,
    );
  }

  return {
    activeKeyId,

    async wrap(dataKey, context) {
      const nonce = randomBytes(NONCE_BYTES);
      const cipher = createCipheriv(ALGORITHM, active, nonce);
      cipher.setAAD(aad(context));
      const wrapped = Buffer.concat([cipher.update(dataKey), cipher.final()]);
      // nonce ‖ tag ‖ wrapped key, so the wrapped blob is one opaque column exactly as a
      // KMS ciphertext blob is.
      return { keyId: activeKeyId, wrapped: Buffer.concat([nonce, cipher.getAuthTag(), wrapped]) };
    },

    async unwrap(wrapped, keyId, context) {
      const key = byId.get(keyId);
      if (!key) {
        throw new DecryptionFailed(
          `Evidence was sealed under key "${keyId}", which this deployment does not hold. A ` +
            `retired key must stay configured for as long as anything sealed under it is ` +
            `still within its retention.`,
        );
      }

      const nonce = wrapped.subarray(0, NONCE_BYTES);
      const tag = wrapped.subarray(NONCE_BYTES, NONCE_BYTES + 16);
      const body = wrapped.subarray(NONCE_BYTES + 16);

      try {
        const decipher = createDecipheriv(ALGORITHM, key, nonce);
        decipher.setAAD(aad(context));
        decipher.setAuthTag(tag);
        return Buffer.concat([decipher.update(body), decipher.final()]);
      } catch (error) {
        throw new DecryptionFailed(
          `The data key sealed under "${keyId}" did not unwrap.`,
          { cause: error },
        );
      }
    },
  };
}

export interface LocalKey {
  readonly keyId: string;
  /** Exactly 32 bytes. Anything else is a configuration error, not a shorter key. */
  readonly key: Buffer;
}

/**
 * Parse one `id:base64` root key.
 *
 * Rejects a short key rather than stretching it. A 16-byte secret padded to 32 bytes is a
 * 16-byte secret that looks like a 128-bit-stronger one in every subsequent conversation,
 * and the whole point of this file is that the claims it supports are true.
 */
export function parseLocalKey(spec: string): LocalKey {
  const separator = spec.indexOf(':');
  if (separator <= 0) {
    throw new Error(
      `A root key is written "<key-id>:<base64>"; "${spec.slice(0, 12)}…" has no key id. The ` +
        `id is stored with every blob, and is how a rotated key is told from its predecessor.`,
    );
  }

  const keyId = spec.slice(0, separator);
  const key = Buffer.from(spec.slice(separator + 1), 'base64');

  if (key.byteLength !== KEY_BYTES) {
    throw new Error(
      `Root key "${keyId}" decodes to ${key.byteLength} bytes; AES-256 needs exactly ` +
        `${KEY_BYTES}. Generate one with: openssl rand -base64 32`,
    );
  }

  return { keyId, key };
}

/** Constant-time equality for two buffers of any length. Used by the export token check. */
export function equalBytes(a: Buffer, b: Buffer): boolean {
  return a.byteLength === b.byteLength && timingSafeEqual(a, b);
}
