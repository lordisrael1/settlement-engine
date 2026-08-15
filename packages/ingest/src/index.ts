/**
 * @recon/ingest — the anti-corruption boundary.
 *
 * Two halves, one job: turn the messy outside world into canonical events, exactly once,
 * at the edge.
 *
 *   the promise half   webhooks     → CanonicalPayment
 *   the money half     settlements  → SettlementLine[]
 *
 * Both halves stand on `@pay-normalize/*`, which already contains the genuinely hard
 * knowledge: four signature schemes, five amount conventions, per-provider timezone
 * rules, and the status ordering that makes out-of-order delivery safe. What this
 * package adds is the last translation into our language, plus the two things a
 * stateless normalisation library deliberately does not have — an expected settlement
 * window and an expected fee, per source, as data.
 *
 * Note what is absent: any dependency on `@recon/ledger-core`. Ingest's job ends when it
 * has produced a clean canonical event. Deciding what the ledger does about that event
 * belongs to a layer that is allowed to know ledgers exist.
 */

export { ingestWebhook, type WebhookIngestInput, type WebhookIngestResult } from './webhook.js';

export {
  ingestSettlement,
  NoSettlementAdapterError,
  flutterwaveSettlements,
  monnifySettlements,
  nombaSettlements,
  toSettlementLine,
  fromParseResults,
  type Normalized,
  type RejectedRow,
  type SettlementIngestResult,
  type SettlementSource,
} from './settlement/index.js';

export { dedupe, type Deduped } from './dedupe.js';

export {
  SOURCES,
  SOURCE_IDS,
  sourceProfile,
  UnknownSourceError,
  type SourceProfile,
} from './sources.js';

export { feeModel, type FeeModel, type RateCard } from './fees.js';
export { toMoney } from './kobo.js';
