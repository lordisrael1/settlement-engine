import { createHash } from 'node:crypto';

import type { Evidence, EvidenceKind, SourceId } from '@recon/canon';

/**
 * Every canonical record this package produces is traceable to the bytes it came from.
 *
 * The identity is the SHA-256 of those bytes, which means uploading the same export twice
 * produces one evidence record without anybody having to remember, and means "is this the
 * file you used?" is a question anyone holding the file can answer without asking us.
 *
 * `parserVersion` is part of the record because the parser is part of the reasoning. When
 * a settlement adapter is corrected, every conclusion the old one reached is suspect — and
 * findable, but only because we wrote down which one ran.
 */
export interface EvidenceContext {
  readonly kind: EvidenceKind;
  readonly source: SourceId;
  readonly filename: string | null;
  /** An operator's id, a cron job's name, an API client — who put this in front of us. */
  readonly receivedFrom: string;
  readonly receivedAt: Date;
  /**
   * Where the bytes were also put — an object-store URI, a vault path.
   *
   * Optional because a small deployment keeps them in the database and needs no second
   * copy. Supplied by whoever did the storing, because only they know where it went; this
   * layer records the locator and never resolves it, which keeps ingest free of a network.
   */
  readonly storageLocation?: string | null;
}

export function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function evidenceOf(
  bytes: Buffer,
  context: EvidenceContext,
  parserVersion: string,
): Evidence {
  return {
    evidenceId: sha256(bytes),
    kind: context.kind,
    source: context.source,
    filename: context.filename,
    byteLength: bytes.byteLength,
    storageLocation: context.storageLocation ?? null,
    receivedFrom: context.receivedFrom,
    receivedAt: context.receivedAt,
    parserVersion,
  };
}
