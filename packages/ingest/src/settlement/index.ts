import type { SourceId } from '@recon/canon';

import { sourceProfile } from '../sources.js';
import type { SettlementIngestResult } from './types.js';

export type { RejectedRow, SettlementIngestResult, SettlementSource } from './types.js';
export { toSettlementLine, fromParseResults, type Normalized } from './normalize.js';
export {
  flutterwaveSettlements,
  monnifySettlements,
  nombaSettlements,
} from './adapters.js';

export class NoSettlementAdapterError extends Error {
  constructor(readonly source: SourceId) {
    super(
      `Source "${source}" has no settlement adapter. Its promise half works; its money ` +
        `half needs a fixture-verified export format before it can be parsed.`,
    );
    this.name = 'NoSettlementAdapterError';
  }
}

/**
 * Ingest a settlement payload for a source.
 *
 * The single entry point the outside world uses. Which adapter runs, what shape the
 * bytes were in, and which quirks it had to absorb are all invisible from here — the
 * result is `SettlementLine[]` either way.
 */
export function ingestSettlement(source: SourceId, payload: Buffer): SettlementIngestResult {
  const profile = sourceProfile(source);
  if (!profile.settlement) throw new NoSettlementAdapterError(source);
  return profile.settlement.ingest(payload);
}
