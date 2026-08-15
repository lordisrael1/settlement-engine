import type { Money, TransactionId, TransactionState } from '@recon/canon';
import { format } from '@recon/canon';

export class LedgerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/**
 * Law 1. Thrown before the write is attempted, so the caller gets a message naming the
 * amount that went missing rather than a Postgres error code. The database enforces the
 * same rule independently at COMMIT — this check is for humans, that one is for safety.
 */
export class UnbalancedTransactionError extends LedgerError {
  constructor(
    readonly transactionId: TransactionId,
    readonly imbalance: Money,
  ) {
    super(
      `LAW_1_VIOLATION: transaction "${transactionId}" does not balance — ` +
        `entries sum to ${format(imbalance)}, not zero. ` +
        `A transaction that does not sum to zero claims money came from nowhere.`,
    );
  }
}

/** The database rejected the write because an invariant trigger fired. */
export class LawViolationError extends LedgerError {
  constructor(
    readonly law: 1 | 2,
    detail: string,
  ) {
    super(`Law ${law} violated in the database: ${detail}`);
  }
}

export class UnknownTransactionError extends LedgerError {
  constructor(readonly transactionId: TransactionId) {
    super(`No such transaction: "${transactionId}"`);
  }
}

export class InvalidStateTransitionError extends LedgerError {
  constructor(
    readonly transactionId: TransactionId,
    readonly from: TransactionState,
    readonly to: TransactionState,
  ) {
    super(
      `Transaction "${transactionId}" cannot move from ${from} to ${to}. ` +
        `${from === 'settled' || from === 'reversed' ? `${from} is terminal.` : ''}`.trim(),
    );
  }
}

/** Recognise the invariant triggers by the prefix they raise with. */
export function asLawViolation(error: unknown): LawViolationError | null {
  const message = error instanceof Error ? error.message : '';
  if (message.includes('LAW_1_VIOLATION')) return new LawViolationError(1, message);
  if (message.includes('LAW_2_VIOLATION')) return new LawViolationError(2, message);
  return null;
}
