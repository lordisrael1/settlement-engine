import type {
  ApprovalPolicy,
  CanonicalPayment,
  IdempotencyKey,
  Money,
  Reference,
  Resolution,
  SourceId,
  TransactionId,
} from '@recon/canon';
import {
  add,
  approvalFailure,
  DEFAULT_APPROVAL_POLICY,
  format,
  isNegative,
  isZero,
  negate,
  RESOLUTION_FORBIDDEN_ACCOUNTS,
  subtract,
  sum,
} from '@recon/canon';

import { LedgerError } from './errors.js';
import { inTransaction, type Executor } from './pool.js';
import { postTransaction, type EntryInput, type PostTransactionResult } from './post.js';
import { transition } from './state.js';

/**
 * How our books record the events of this business.
 *
 * `postTransaction` is the mechanism — it will faithfully write any balanced set of
 * entries you hand it. This file is the *policy*: which accounts a given economic event
 * touches. Both belong to the ledger, because both are statements about our chart of
 * accounts, and neither has any idea which PSP the event came from.
 *
 * The rule that shapes everything below: **a PSP's word never moves `bank_account`.** A
 * settlement report is a claim about the future by a party with an interest in it. Only a
 * bank statement — our own bank, about our own account — books cash.
 */

export class UnbookablePaymentError extends LedgerError {
  constructor(payment: CanonicalPayment) {
    super(
      `Refusing to book payment "${payment.reference}" with status ${payment.status}. ` +
        `Only a SUCCESSFUL payment is a promise of money; booking anything else would ` +
        `put cash in the books that no one ever agreed to send.`,
    );
  }
}

/**
 * T+0. Record the promise: a customer has paid, and the PSP now owes us.
 *
 *   psp_receivable    +gross    (they owe us)
 *   merchant_revenue  −gross    (we earned it)
 *
 * Revenue is booked at **gross** — what the customer actually paid — and no fee is
 * booked at all. This is not an omission. At this moment the fee is genuinely unknown:
 * a rate card can change, a cap can apply, an international surcharge can land. Booking
 * an estimate would put a guess in the books and require a correction later, for
 * something we never had to assert in the first place. The fee is booked when the bank
 * confirms what actually arrived.
 *
 * The consequence is the most useful number in the business: at any instant,
 * `psp_receivable` is exactly the money promised but not yet in our hands.
 */
export async function bookAuthorizedPayment(
  db: Executor,
  payment: CanonicalPayment,
  recordedAt: Date,
): Promise<PostTransactionResult> {
  if (payment.status !== 'SUCCESSFUL') throw new UnbookablePaymentError(payment);

  return postTransaction(db, {
    transactionId: payment.idempotencyKey,
    source: payment.source,
    reference: payment.reference,
    occurredAt: payment.occurredAt,
    recordedAt,
    initialState: 'authorized',
    // The rail travels with the promise, because the fee it will attract is priced per
    // channel and reconstructing it later from narration is guesswork.
    channel: payment.channel,
    event: { type: 'PaymentAuthorized' },
    entries: [
      { accountId: 'psp_receivable', amount: payment.gross },
      { accountId: 'merchant_revenue', amount: negate(payment.gross) },
    ],
  });
}

/**
 * T+1 books nothing.
 *
 * There is deliberately no `bookPayoutReport` in this file. When a PSP reports a payout we
 * match payments to it, name its deductions and record all of it — in the reconciler's
 * tables, as a `Payout` with status `reported`. Not one entry is written, because nothing
 * economic has happened: the PSP has described its own intentions. A ledger that books on
 * intent is a ledger that reports cash it does not have.
 */

/**
 * A promise this settlement discharges, and how much of it.
 *
 * `receivable` is what the transaction opened the receivable at, read back from its own
 * entries rather than remembered. `amount` is how much of that this booking closes —
 * usually all of it, but a PSP may settle one payment across two payouts, and calling a
 * half-settled payment mismatched would escalate something that is going perfectly well.
 */
export interface DischargedPromise {
  readonly transactionId: TransactionId;
  readonly receivable: Money;
  readonly amount: Money;
}

/**
 * The bank evidence that lets any of this be booked at all.
 *
 * `transactionId` is not a field: the bank credit's idempotency key *is* the transaction
 * id (ADR-0014). One credit is one economic event, and giving the booking a second identity
 * would mean two uniqueness constraints that can disagree. With the equality, a
 * reconciliation that dies halfway and is retried cannot double-book — the second attempt
 * collides on the primary key.
 */
export interface BankConfirmation {
  /** The bank statement line's idempotency key, which becomes the transaction's id. */
  readonly creditKey: IdempotencyKey;
  readonly source: SourceId;
  readonly reference: Reference;
  /** The statement's value date: when the bank says the money landed. */
  readonly valueDate: Date;
  readonly recordedAt: Date;
  /** What the bank actually credited. Not what anybody said it would be. */
  readonly credited: Money;
}

export class ImplausibleSettlementError extends LedgerError {
  constructor(message: string) {
    super(message);
  }
}

/**
 * T+1/T+2. Book the cash — the only function in the system that may increase
 * `bank_account`.
 *
 *   bank_account    +credited            (the bank's own word for it)
 *   fees_expense    +fee                 ┐
 *   taxes_withheld  +tax                 │ every deduction, named, and booked
 *   psp_reserve     +reserve             │ to the account that describes it
 *   penalties       +penalty             ┘
 *   psp_receivable  −Σ discharged        (they no longer owe us this much)
 *
 * The deductions are the ones the reconciler could *name*, from the PSP's own itemised
 * report — never a residue computed by subtraction. If the named deductions plus the
 * credit do not equal the receivable being discharged, this refuses to post.
 *
 * That refusal is the whole point. The obvious alternative is to plug the difference into
 * `fees_expense` so it balances, which always works and is always a lie: an unexplained
 * ₦40,000 shortfall becomes an unusually expensive Tuesday that nobody investigates. A
 * transaction that will not balance without a plug is a transaction whose story we do not
 * know, and the honest response is to escalate rather than to write it down as though we
 * did.
 */
export async function bookBankConfirmedSettlement(
  db: Executor,
  confirmation: BankConfirmation,
  discharged: readonly DischargedPromise[],
  deductions: readonly EntryInput[],
): Promise<PostTransactionResult> {
  if (discharged.length === 0) {
    throw new ImplausibleSettlementError(
      `Refusing to book bank credit "${confirmation.creditKey}" against no promise at ` +
        `all. Money with nothing to discharge is a PHANTOM_CREDIT, not a settlement.`,
    );
  }

  if (isNegative(confirmation.credited)) {
    throw new ImplausibleSettlementError(
      `Refusing to book bank credit "${confirmation.creditKey}" of ` +
        `${format(confirmation.credited)}. A negative credit is a debit, and a debit is a ` +
        `returned payout — a different event with a different booking.`,
    );
  }

  const closing = sum(discharged.map((promise) => promise.amount));
  const named = sum(deductions.map((deduction) => deduction.amount));
  const unexplained = subtract(closing, add(confirmation.credited, named));

  if (!isZero(unexplained)) {
    throw new ImplausibleSettlementError(
      `Refusing to book bank credit "${confirmation.creditKey}": discharging ` +
        `${format(closing)} of receivable against ${format(confirmation.credited)} of cash ` +
        `and ${format(named)} of named deductions leaves ${format(unexplained)} ` +
        `unaccounted for. A booking that needs a plug entry to balance is a booking whose ` +
        `story we do not know.`,
    );
  }

  return inTransaction(db, async (client) => {
    const result = await postTransaction(client, {
      transactionId: confirmation.creditKey,
      source: confirmation.source,
      reference: confirmation.reference,
      occurredAt: confirmation.valueDate,
      recordedAt: confirmation.recordedAt,
      // The cash has landed. There is no later event this transaction waits for.
      initialState: 'settled',
      event: { type: 'SettlementBooked', causedBy: confirmation.reference },
      entries: nonZero([
        { accountId: 'bank_account', amount: confirmation.credited },
        ...deductions,
        { accountId: 'psp_receivable', amount: negate(closing) },
      ]),
    });

    if (result.outcome === 'posted') {
      for (const promise of discharged) {
        // A payment settled only in part is still waiting for the rest, so it keeps its
        // `authorized` state. Only a full discharge ends its story.
        if (!isZero(subtract(promise.receivable, promise.amount))) continue;
        await transition(client, {
          transactionId: promise.transactionId,
          to: 'settled',
          at: confirmation.recordedAt,
          causedBy: confirmation.creditKey,
        });
      }
    }

    return result;
  });
}

/**
 * A reserve came back.
 *
 *   bank_account  +credited
 *   psp_reserve   −credited
 *
 * The one bank credit that discharges no receivable, which is why it cannot go through
 * `bookBankConfirmedSettlement`: that function refuses an empty `discharged` list, correctly,
 * because money with nothing to discharge is a `PHANTOM_CREDIT` and not a settlement. A
 * release is neither. Nothing new is earned and nothing is settled — an asset we already held
 * changes which account it sits in, because the PSP finally sent it (ADR-0071).
 *
 * `returned` arrives as the deductions the inflow carried, which for a release are negative:
 * the PSP itemised `reserve_release: −₦100,000` and `adjustmentEntries` turned that into
 * `psp_reserve: −₦100,000`. Requiring them to cancel the credit exactly is the same refusal
 * `bookBankConfirmedSettlement` makes and for the same reason — a booking that needs a plug
 * to balance is a booking whose story we do not know.
 *
 * It still takes bank evidence. A PSP saying a reserve was released is a claim about its own
 * future behaviour, exactly like any other payout report, and the rule that only a bank
 * statement moves `bank_account` does not bend for money that was always ours.
 */
export async function bookReserveRelease(
  db: Executor,
  confirmation: BankConfirmation,
  returned: readonly EntryInput[],
): Promise<PostTransactionResult> {
  if (isNegative(confirmation.credited) || isZero(confirmation.credited)) {
    throw new ImplausibleSettlementError(
      `Refusing to book reserve release "${confirmation.creditKey}" of ` +
        `${format(confirmation.credited)}. A release of nothing is not an event, and a ` +
        `negative one is a debit — which is a withholding, and books the other way.`,
    );
  }

  const unexplained = add(confirmation.credited, sum(returned.map((entry) => entry.amount)));
  if (!isZero(unexplained)) {
    throw new ImplausibleSettlementError(
      `Refusing to book reserve release "${confirmation.creditKey}": ` +
        `${format(confirmation.credited)} of cash against ` +
        `${format(sum(returned.map((entry) => entry.amount)))} of named returns leaves ` +
        `${format(unexplained)} unaccounted for. A release that does not empty the accounts ` +
        `it claims to be releasing is a payout carrying something else as well, and it needs ` +
        `a person rather than a plug entry.`,
    );
  }

  return postTransaction(db, {
    transactionId: confirmation.creditKey,
    source: confirmation.source,
    reference: confirmation.reference,
    occurredAt: confirmation.valueDate,
    recordedAt: confirmation.recordedAt,
    initialState: 'settled',
    event: { type: 'ReserveReleased', causedBy: confirmation.reference },
    entries: nonZero([
      { accountId: 'bank_account', amount: confirmation.credited },
      ...returned,
    ]),
  });
}

/** The identity of any non-settlement event the reconciler books. */
export interface BookingEvent {
  readonly key: IdempotencyKey;
  readonly source: SourceId;
  readonly reference: Reference;
  readonly at: Date;
}

/**
 * The promise was undone before any money came.
 *
 *   reversals       +amount    (contra-income: income earned, then given back)
 *   psp_receivable  −amount    (they owe us nothing after all)
 *
 * Note what this does *not* do: touch `merchant_revenue`. The revenue was genuinely
 * earned at the moment the customer paid, and editing that credit away would erase the
 * fact that it ever happened. A contra-income account records the giving-back as its own
 * event, so gross revenue reporting survives the refund and an auditor sees both halves.
 *
 * This is the domain decision `reverse()` deliberately refuses to make (ADR-0024). That
 * primitive is an exact negation, correct without knowing what caused it; this one knows
 * it is looking at a refunded payment and books it as one.
 *
 * No bank evidence is required, and none is possible: nothing was ever credited, so there
 * is nothing for a statement to confirm.
 *
 * **Partial refunds book here too, and only the lifecycle differs.** `promise.amount` is
 * how much came back and `promise.receivable` is what the promise opened at; when they
 * differ, the entries are for the refunded part and the transaction stays `authorized`,
 * because the PSP still owes us the rest and a payout is still coming for it. Transitioning
 * to `reversed` on a ₦3,000 refund against a ₦10,000 charge would close a promise that is
 * ₦7,000 alive — and the ₦7,000 would resurface later as a settlement nobody could match
 * to anything (ADR-0069). The same test `bookBankConfirmedSettlement` already applies to a
 * part-settled promise, applied to the other direction.
 */
export async function bookReversal(
  db: Executor,
  event: BookingEvent,
  promise: DischargedPromise,
): Promise<PostTransactionResult> {
  if (isNegative(promise.amount) || isZero(promise.amount)) {
    throw new ImplausibleSettlementError(
      `Refusing to book reversal "${event.key}" of ${format(promise.amount)}. A refund of ` +
        `nothing, or of a negative amount, is a parsing error wearing a plausible face.`,
    );
  }

  const excess = subtract(promise.amount, promise.receivable);
  if (!isNegative(excess) && !isZero(excess)) {
    throw new ImplausibleSettlementError(
      `Refusing to book reversal "${event.key}" of ${format(promise.amount)} against a ` +
        `receivable of ${format(promise.receivable)}: ${format(excess)} more would be given ` +
        `back than was ever promised. Refunding more than was charged is a real event, and ` +
        `it is a goodwill payment rather than a reversal — it does not belong against this ` +
        `receivable.`,
    );
  }

  return inTransaction(db, async (client) => {
    const result = await postTransaction(client, {
      transactionId: event.key,
      source: event.source,
      reference: event.reference,
      occurredAt: event.at,
      recordedAt: event.at,
      initialState: 'settled',
      event: { type: 'ReversalBooked', causedBy: promise.transactionId },
      entries: [
        { accountId: 'reversals', amount: promise.amount },
        { accountId: 'psp_receivable', amount: negate(promise.amount) },
      ],
    });

    // Only a whole refund ends the promise's story. A partial one leaves it `authorized`,
    // waiting for the payout that carries the remainder.
    if (result.outcome === 'posted' && isZero(subtract(promise.receivable, promise.amount))) {
      await transition(client, {
        transactionId: promise.transactionId,
        to: 'reversed',
        at: event.at,
        causedBy: event.key,
      });
    }

    return result;
  });
}

/**
 * Money clawed back *after* it had already settled.
 *
 *   chargebacks   +amount
 *   bank_account  −amount    (the cash really has left the account)
 *
 * This one does move `bank_account` without a credit, and it must: the debit is itself
 * bank evidence. It comes from a statement line, not from a PSP's assertion.
 *
 * The original transaction is not transitioned, and that is the point: it reached
 * `settled`, which is terminal, and it stays there. A chargeback is not an un-settling —
 * it is a later economic event with its own transaction, born terminal because nothing
 * further is expected of it.
 */
export async function bookChargeback(
  db: Executor,
  event: BookingEvent,
  amount: Money,
): Promise<PostTransactionResult> {
  if (isNegative(amount) || isZero(amount)) {
    throw new ImplausibleSettlementError(
      `Refusing to book chargeback "${event.key}" of ${format(amount)}. A clawback of ` +
        `nothing, or of a negative amount, is a parsing error wearing a plausible face.`,
    );
  }

  return postTransaction(db, {
    transactionId: event.key,
    source: event.source,
    reference: event.reference,
    occurredAt: event.at,
    recordedAt: event.at,
    initialState: 'settled',
    event: { type: 'ChargebackBooked' },
    entries: [
      { accountId: 'chargebacks', amount },
      { accountId: 'bank_account', amount: negate(amount) },
    ],
  });
}

/**
 * The bank sent a payout back after we had already booked it as cash.
 *
 * An exact negation of the confirming transaction, written as its own event rather than by
 * unwinding the original (append-only). Every account it touched moves back, which means the
 * receivable reopens: the PSP still owes us, and the payments it covered go back to
 * waiting. Their lifecycle state is not rolled back here — `settled` is terminal, and the
 * fact that they were once settled is part of the history.
 */
export async function bookReturnedPayout(
  db: Executor,
  event: BookingEvent,
  original: readonly EntryInput[],
): Promise<PostTransactionResult> {
  return postTransaction(db, {
    transactionId: event.key,
    source: event.source,
    reference: event.reference,
    occurredAt: event.at,
    recordedAt: event.at,
    initialState: 'settled',
    event: { type: 'PayoutReturned', causedBy: event.reference },
    entries: original.map((entry) => ({
      accountId: entry.accountId,
      amount: negate(entry.amount),
    })),
  });
}

export class UnbookableResolutionError extends LedgerError {
  constructor(message: string) {
    super(message);
  }
}

/**
 * The compensating transaction a human decision produces.
 *
 * An operator finds the PSP's reserve notice and concludes that a ₦1,000 "unexplained
 * deduction" was a rolling reserve. The correct response is *not* to edit the original
 * booking — it recorded what we knew, and what we knew was wrong, and both of those are
 * facts. The response is a second transaction that moves ₦1,000 from `fees_expense` to
 * `psp_reserve`, carrying its own date, its own reason, and the name of the person who
 * concluded it. The original entries stand. An auditor sees the mistake and the correction,
 * which is strictly more information than seeing neither.
 *
 * Two refusals, and both are the design rather than defensiveness:
 *
 *   **A resolution may not touch `bank_account`.** Cash moves on bank evidence, and a
 *   human's conclusion is not bank evidence. An operator who believes the bank balance is
 *   wrong has found either a statement line we have not ingested — ingest it — or a genuine
 *   bank error, which is resolved with the bank and comes back as a statement line. Neither
 *   is fixed by typing a number, and the moment this is allowed "once, carefully", the
 *   three-way design is decoration.
 *
 *   **A resolution needing approval may not book without one.** Checked here as well as at
 *   the point of recording, because this is the function that actually moves value and a
 *   control enforced in only one place is one refactor away from not existing.
 *
 * The transaction's id is the resolution's key, so a retried request books once (idempotency).
 */
export async function bookResolutionAdjustment(
  db: Executor,
  resolution: Resolution,
  entries: readonly EntryInput[],
  policy: ApprovalPolicy = DEFAULT_APPROVAL_POLICY,
): Promise<PostTransactionResult> {
  if (entries.length === 0) {
    throw new UnbookableResolutionError(
      `Resolution "${resolution.resolutionKey}" has no entries to post. A decision that ` +
        `moves nothing is recorded as a decision, not as an empty transaction.`,
    );
  }

  const forbidden = entries.filter((entry) =>
    RESOLUTION_FORBIDDEN_ACCOUNTS.includes(entry.accountId),
  );
  if (forbidden.length > 0) {
    throw new UnbookableResolutionError(
      `Resolution "${resolution.resolutionKey}" would move ` +
        `${forbidden.map((entry) => format(entry.amount)).join(', ')} in and out of ` +
        `${forbidden.map((entry) => entry.accountId).join(', ')}. Cash moves on bank ` +
        `evidence, and a human conclusion is not bank evidence — ingest the statement line ` +
        `that proves it, or take the correction to the bank and ingest what comes back.`,
    );
  }

  const failure = approvalFailure(policy, resolution, true);
  if (failure) throw new UnbookableResolutionError(failure);

  return postTransaction(db, {
    transactionId: `resolution:${resolution.resolutionKey}`,
    source: 'resolution',
    reference: resolution.subjectId,
    // The decision's own timestamp, not the run's. A correction happened when the person
    // made it, and dating it to the batch that posted it would misreport the month.
    occurredAt: resolution.resolvedAt,
    recordedAt: resolution.resolvedAt,
    // Nothing further is expected of a correction; it is complete when it is posted.
    initialState: 'settled',
    event: { type: 'ResolutionRecorded', causedBy: resolution.subjectId },
    entries: nonZero(entries),
  });
}

/**
 * Drop zero-amount entries.
 *
 * A settlement with no fee is real — a zero-rated channel, a waived flat component — and
 * writing `fees_expense 0` for it would put a line in the permanent record that says
 * nothing. Dropping it changes no balance, because zero is zero.
 */
function nonZero(entries: readonly EntryInput[]): EntryInput[] {
  return entries.filter((entry) => !isZero(entry.amount));
}
