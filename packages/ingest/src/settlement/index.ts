import type { SourceId } from '@recon/canon';
import { refuseCardData } from '@recon/protect';

import { sourceProfile } from '../sources.js';
import type { SettlementContext, SettlementIngestResult } from './types.js';

export type {
  RejectedRow,
  SettlementContext,
  SettlementIngestResult,
  SettlementSource,
} from './types.js';
export {
  toSettlementLine,
  toPayout,
  fromParseResults,
  type Normalized,
  type RowInterpretation,
} from './normalize.js';
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
 * The single entry point the outside world uses. Which adapter runs, what shape the bytes
 * were in, whether the source reports payouts or bare transactions, and which quirks it
 * had to absorb are all invisible from here — canonical records come out either way, each
 * one carrying the hash of the file it came from.
 */
export function ingestSettlement(
  source: SourceId,
  payload: Buffer,
  context: SettlementContext,
): SettlementIngestResult {
  const profile = sourceProfile(source);
  if (!profile.settlement) throw new NoSettlementAdapterError(source);

  // Before the parser, because the evidence record is written from these bytes and an
  // export that carries a card number must not become a row anybody has to go and delete
  // (ADR-0066). Thrown rather than returned as a rejected row: a rejected row is one line
  // of a file we accepted, and this is a refusal of the file.
  refuseCardData(payload, `This ${source} settlement export`);

  return profile.settlement.ingest(payload, context);
}
