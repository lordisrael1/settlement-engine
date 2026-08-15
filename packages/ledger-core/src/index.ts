/**
 * @recon/ledger-core — the double-entry engine.
 *
 * The only path to writing money. Everything else in the system — ingest, the
 * reconciler, the API — must come through `postTransaction`, which is what makes Law 1
 * enforceable rather than merely intended.
 *
 * It knows accounts, entries and invariants. It knows nothing about Paystack, HTTP or
 * files, and must never learn.
 */

export { createPool, inTransaction, type Executor } from './pool.js';
export {
  runMigrations,
  syncAccounts,
  LEDGER_MIGRATIONS_DIR,
  type AppliedMigration,
} from './migrate.js';

export {
  postTransaction,
  entryId,
  type EntryInput,
  type PostTransactionInput,
  type PostTransactionResult,
} from './post.js';
export { reverse, reversalTransactionId } from './reverse.js';
export { bookAuthorizedPayment, UnbookablePaymentError } from './bookings.js';
export {
  currentState,
  transition,
  type TransitionInput,
  type TransitionResult,
} from './state.js';
export { getTransaction, listByState } from './read.js';

export {
  balance,
  allBalances,
  cachedBalance,
  verifyBalances,
  verifyConservation,
  type BalanceDiscrepancy,
} from './balance.js';

export {
  LedgerError,
  UnbalancedTransactionError,
  LawViolationError,
  UnknownTransactionError,
  InvalidStateTransitionError,
} from './errors.js';
