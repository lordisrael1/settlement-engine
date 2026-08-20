import { createHash } from 'node:crypto';

/**
 * Who is asking, verified rather than claimed.
 *
 * Until now this service held one shared key and asked callers to name themselves in an
 * `X-Recon-Operator` header, which it recorded as an unverified claim (ADR-0052). That was
 * honest and it was also nearly worthless: an audit record naming an operator who was named
 * by the operator answers "what did somebody type?" and not "who did this?". It cost
 * nothing while every audited action was a write the ledger constrained anyway. It stops
 * being tolerable the moment a request can return a customer's name and email, because then
 * the access log is the only control there is (ADR-0066).
 *
 * So a key belongs to a principal, and the principal is what gets written down.
 *
 * **This is not OIDC, and it is not pretending to be.** Static per-principal keys are
 * weaker than an identity provider: they do not expire on their own, they do not carry
 * group membership, and revoking one is a deploy. What they do give is the property the
 * access log actually needs — two operators are two principals, and no configuration change
 * can make them the same one. When an IdP arrives, `authenticate` below is the function that
 * changes, and nothing that consumes a principal changes with it.
 */

/**
 * What a principal is allowed to do beyond the ordinary management endpoints.
 *
 * Deliberately a very short list. Everything a principal can do by holding a valid key is
 * the same as it ever was; these two name the operations that hand over personal data, and
 * they exist so that the reconciliation operator who reads balances all day is not also,
 * silently, able to export a hundred provider payloads.
 */
export const GRANTS = ['evidence.raw', 'evidence.export'] as const;
export type Grant = (typeof GRANTS)[number];

export interface Principal {
  /** The name that goes in the audit record. An operator's id, a job's name. */
  readonly name: string;
  readonly grants: ReadonlySet<Grant>;
}

export class PrincipalConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PrincipalConfigurationError';
  }
}

/**
 * The credential store: a key's digest to the principal that holds it.
 *
 * Keyed by digest rather than searched, which is both faster and the reason there is no
 * timing side channel to worry about. A comparison loop over N principals leaks how far
 * down the list a near-miss got; a hash lookup takes the same path for every input, and the
 * digest being compared is of the *presented* value, so it tells an attacker nothing they
 * did not already supply.
 */
export class Principals {
  private readonly byDigest: ReadonlyMap<string, Principal>;

  private constructor(byDigest: Map<string, Principal>) {
    this.byDigest = byDigest;
  }

  /**
   * Parse `RECON_API_KEYS`: a comma-separated list of `principal:secret:grant|grant`.
   *
   *     RECON_API_KEYS=amaka@example.com:s3cr3t…:evidence.raw|evidence.export,cron-nightly:k2…:
   *
   * The grants segment may be empty and the trailing colon may be omitted. Splitting on the
   * first two colons only, because a principal is frequently an email address and a secret
   * frequently is not chosen by us.
   */
  static fromEnv(raw: string | undefined): Principals {
    if (!raw || raw.trim() === '') {
      throw new PrincipalConfigurationError(
        'RECON_API_KEYS is not set. The management endpoints expose balances, ingestion, ' +
          'the resolution path and — now — evidence, so there is deliberately no way to run ' +
          'them unauthenticated. Write it as a comma-separated list of ' +
          '"principal:secret:grant|grant", for example:\n\n' +
          '    RECON_API_KEYS=amaka@example.com:$(openssl rand -hex 24):evidence.raw\n',
      );
    }

    const byDigest = new Map<string, Principal>();
    const names = new Set<string>();

    for (const entry of raw.split(',').map((part) => part.trim()).filter(Boolean)) {
      const firstColon = entry.indexOf(':');
      if (firstColon <= 0) {
        throw new PrincipalConfigurationError(
          `"${entry.slice(0, 20)}…" is not "principal:secret:grants". Every key belongs to a ` +
            `named principal, because an access log full of "api" is a log of nothing.`,
        );
      }

      const name = entry.slice(0, firstColon);
      const rest = entry.slice(firstColon + 1);
      const secondColon = rest.indexOf(':');
      const secret = secondColon === -1 ? rest : rest.slice(0, secondColon);
      const grantSpec = secondColon === -1 ? '' : rest.slice(secondColon + 1);

      if (secret.length < 16) {
        throw new PrincipalConfigurationError(
          `The key for "${name}" is ${secret.length} characters. A key short enough to guess ` +
            `is a key that will be; use at least 16.`,
        );
      }
      if (names.has(name)) {
        throw new PrincipalConfigurationError(
          `"${name}" appears twice in RECON_API_KEYS. Two keys for one principal makes the ` +
            `access log ambiguous about which credential was used, which is most of the ` +
            `reason to have principals at all.`,
        );
      }

      const grants = new Set<Grant>();
      for (const grant of grantSpec.split('|').map((part) => part.trim()).filter(Boolean)) {
        if (!(GRANTS as readonly string[]).includes(grant)) {
          throw new PrincipalConfigurationError(
            `"${grant}" is not a grant. The list is: ${GRANTS.join(', ')}. A typo that ` +
              `silently granted nothing would be discovered by an operator who could not do ` +
              `their job; a typo that silently granted everything would not be discovered.`,
          );
        }
        grants.add(grant as Grant);
      }

      names.add(name);
      byDigest.set(digest(secret), { name, grants });
    }

    if (byDigest.size === 0) {
      throw new PrincipalConfigurationError('RECON_API_KEYS parsed to no principals at all.');
    }

    return new Principals(byDigest);
  }

  /** Build directly, for tests and for a deployment that gets its keys from somewhere else. */
  static of(entries: readonly { name: string; secret: string; grants?: readonly Grant[] }[]) {
    return new Principals(
      new Map(
        entries.map((entry) => [
          digest(entry.secret),
          { name: entry.name, grants: new Set(entry.grants ?? []) },
        ]),
      ),
    );
  }

  /** The principal holding this key, or `null`. The whole of the authentication decision. */
  authenticate(presented: string | undefined): Principal | null {
    if (typeof presented !== 'string' || presented === '') return null;
    return this.byDigest.get(digest(presented)) ?? null;
  }

  get size(): number {
    return this.byDigest.size;
  }
}

function digest(secret: string): string {
  return createHash('sha256').update(secret, 'utf8').digest('hex');
}
