/**
 * @recon/ingest — the anti-corruption boundary.
 *
 * Three halves, which is one more than it sounds like it should be, and the third is the
 * whole point:
 *
 *   the promise    webhooks              → CanonicalPayment
 *   the claim      PSP settlement files  → Payout + SettlementLine[]
 *   the proof      bank statements       → BankStatementLine[]
 *
 * The first two arrive from parties with an interest in the answer. Only the third is our
 * own bank telling us about our own account, and nothing downstream may book cash without
 * it. Keeping all three behind one boundary means the reconciler compares three canonical
 * records and never learns that one came from a CSV, one from a signed webhook, and one
 * from a JSON envelope with a nested data array.
 *
 * The PSP halves stand on `@pay-normalize/*`, which already contains the genuinely hard
 * knowledge: four signature schemes, five amount conventions, per-provider timezone rules,
 * and the status ordering that makes out-of-order delivery safe. What this package adds is
 * the last translation into our language, plus the things a stateless normalisation
 * library deliberately does not have — a business calendar, a fee contract, a named
 * deduction, and the hash of the file it all came from.
 *
 * Note what is absent: any dependency on `@recon/ledger-core`. Ingest's job ends when it
 * has produced a clean canonical record. Deciding what the ledger does about it belongs to
 * a layer that is allowed to know ledgers exist.
 */

export { ingestWebhook, type WebhookIngestInput, type WebhookIngestResult } from './webhook.js';

export {
  ingestSettlement,
  NoSettlementAdapterError,
  flutterwaveSettlements,
  monnifySettlements,
  nombaSettlements,
  toSettlementLine,
  toPayout,
  fromParseResults,
  type Normalized,
  type RejectedRow,
  type RowInterpretation,
  type SettlementContext,
  type SettlementIngestResult,
  type SettlementSource,
} from './settlement/index.js';

export {
  ingestBankStatement,
  BANK_STATEMENT_FORMAT,
  BANK_PARSER_VERSION,
  type BankStatementContext,
  type BankStatementIngestResult,
} from './bank.js';

export { dedupe, type Deduped } from './dedupe.js';

export {
  SOURCES,
  SOURCE_IDS,
  sourceProfile,
  publishedContracts,
  UnknownSourceError,
  type SourceProfile,
} from './sources.js';

export {
  calendar,
  NIGERIA_HOLIDAYS_2026,
  CUT_OFF_5PM_WAT,
  CUT_OFF_10PM_WAT,
  ONE_DAY_GRACE,
  FOUR_HOURS_GRACE,
} from './calendar.js';

export {
  publishedContract,
  PAYSTACK_PUBLISHED_NGN,
  FLUTTERWAVE_PUBLISHED_NGN,
  MONNIFY_PUBLISHED_NGN,
} from './fees.js';

export { evidenceOf, sha256, type EvidenceContext } from './evidence.js';
export { toMoney } from './kobo.js';
