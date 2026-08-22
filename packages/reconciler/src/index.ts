/**
 * @recon/reconciler — the engine that explains the difference.
 *
 * Three records arrive from three directions: a webhook says a customer paid, a PSP report
 * says a payout is coming, and a bank statement says cash landed. This package decides
 * which of them are about the same money, names every difference between them, and writes
 * the ledger transaction that closes each one.
 *
 * Four ideas hold it together:
 *
 *   **Two stages, because money moves in two steps.** `allocate` matches promises to a
 *   PSP's reported payout and books nothing. `confirm` matches a bank credit to that
 *   payout and is the only thing in the system that books cash. A matcher that skipped the
 *   distinction would be asserting that a PSP's description of its own future behaviour is
 *   money in the bank.
 *
 *   **The matcher is pure.** Both stages are functions of their arguments — no clock, no
 *   database, no network. Same inputs, same partition, forever (determinism), which is what
 *   makes a reconciliation auditable rather than merely plausible.
 *
 *   **It never learns which source it is looking at.** Everything per-source arrives as a
 *   `SourcePolicy`: a business calendar, a dated fee model, a bank-charge allowance. There
 *   is no source name in here to branch on, so the canonical boundary holds structurally.
 *
 *   **It refuses to guess.** Two payouts that fit one credit equally well, a batch with
 *   two valid solutions, a shortfall bigger than a bank charge could be — all escalate.
 *   Guessing costs a week of nobody knowing anything is wrong; escalating costs five
 *   minutes.
 *
 * Read the files in this order:
 *   policy.ts     what the matcher is told about a source
 *   inflow.ts     the money we have been told to expect, however the source phrased it
 *   apportion.ts  how one batch deduction is split across the payments it was charged on
 *   subset.ts     the batching engine, and why it refuses to guess
 *   match.ts      the two stages themselves
 *   exceptions.ts the queue: differences with a lifecycle, and how they clear themselves
 *   store.ts      where the three records, the evidence and the conclusions live
 *   run.ts        loading, matching, booking
 *   summary.ts    what all of it added up to, over a period
 */

export {
  allocate,
  confirm,
  promisesIn,
  receivableOf,
  outstanding,
  type AllocateInput,
  type AllocateResult,
  type ConfirmedInflow,
  type ConfirmInput,
  type Confirmation,
  type ConfirmResult,
  type OpenPromise,
  type PreparedInflow,
  type ReturnedPayout,
} from './match.js';

export {
  acknowledge,
  clearVanished,
  collisionDraft,
  draftFrom,
  exceptionAt,
  exceptionHistory,
  openExceptions,
  raiseExceptions,
  resolveByHuman,
  resolveException,
  type ClearOutcome,
  type ClearScope,
  type ExceptionDraft,
  type QueueFilter,
  type RaiseOutcome,
  type SubjectWindow,
} from './exceptions.js';

export {
  derivedKey,
  inflowFromLines,
  inflowFromPayout,
  inflowShortfall,
  totalDeductions,
  withApportionment,
  type AllocationDraft,
  type ExpectedInflow,
  type InflowAllocation,
} from './inflow.js';

export {
  recordAnomalies,
  clearConformed,
  acknowledgeAnomaly,
  resolveAnomaly,
  openAnomalies,
  type AnomalyOutcome,
  type QueuedAnomaly,
} from './anomalies.js';

export {
  apportion,
  apportionDeductions,
  type AllocationBreakdown,
  type Apportionable,
} from './apportion.js';

export {
  UNPROFILED_SOURCE,
  policyOf,
  type PolicyLookup,
  type SourcePolicy,
} from './policy.js';

export {
  uniqueSubsetSummingTo,
  DEFAULT_SUBSET_LIMITS,
  type SubsetLimits,
  type SubsetOutcome,
} from './subset.js';

export {
  RECONCILER_MIGRATIONS_DIR,
  saveFeeContract,
  loadFeeContracts,
  recordPayouts,
  recordSettlementLines,
  recordBankLines,
  type BankLineCollision,
  type StoredBankLines,
  unallocatedPayouts,
  unallocatedSettlementLines,
  unmatchedBankLines,
  confirmedInflows,
  saveInflow,
  openInflows,
  confirmInflow,
  markPayoutReturned,
  allocatedByTransaction,
  allocationsOf,
  recordMatch,
  recordResolution,
  resolutionsFor,
  matchOf,
  UnapprovedResolutionError,
  type ResolutionOptions,
  type Stored,
} from './store.js';

export {
  attestBankBalance,
  bankPosition,
  lastAttestation,
  recordReserveMovement,
  reservePositions,
  unreleasedReserves,
  type BankAttestation,
  type BankPosition,
  type ReservePosition,
} from './reserves.js';

export {
  summarize,
  type ConclusionTally,
  type QueueTally,
  type ReconciliationSummary,
  type SummaryWindow,
} from './summary.js';

export {
  reconcile,
  type Booked,
  type BookingFailure,
  type ReconcileInput,
  type ReconciliationRun,
  type WindowReport,
} from './run.js';

export {
  accessLog,
  accessVolume,
  evidenceAt,
  readEvidenceBytes,
  recordAccess,
  recordEvidence,
  runRetention,
  type AccessRecord,
  type EvidenceAccess,
  type EvidenceBytes,
  type EvidenceRecord,
  type EvidenceVault,
  type RetentionAction,
  type RetentionOptions,
  type RetentionReport,
} from './evidence.js';

export {
  claimExport,
  issueExport,
  EvidenceUnavailableError,
  UnapprovedExportError,
  type ExportClaim,
  type ExportOptions,
  type IssuedExport,
} from './export.js';
