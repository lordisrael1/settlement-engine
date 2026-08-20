import type {
  AccountId,
  BankStatementLine,
  FeeExplanation,
  IdempotencyKey,
  LedgerTransaction,
  MatchResult,
  Money,
  PaymentChannel,
  Payout,
  Reference,
  RejectedCandidate,
  SettlementLine,
  SourceId,
  TransactionId,
  TransactionState,
} from '@recon/canon';
import {
  equals,
  isCredit,
  isOverdue,
  MAX_CANDIDATES,
  NO_LINKS,
  payoutArithmetic,
  subtract,
  sum,
  ZERO,
} from '@recon/canon';

import {
  derivedKey,
  inflowFromLines,
  inflowFromPayout,
  withApportionment,
  type AllocationDraft,
  type ExpectedInflow,
  type InflowAllocation,
} from './inflow.js';
import { policyOf, type PolicyLookup, type SourcePolicy } from './policy.js';
import { uniqueSubsetSummingTo, type SubsetLimits, DEFAULT_SUBSET_LIMITS } from './subset.js';

/**
 * The matching pipeline, in the two stages the money actually moves in.
 *
 *   `allocate`  the PSP's report meets the ledger. Which promises does this payout
 *               cover, and what was deducted? **Books nothing.**
 *   `confirm`   the bank statement meets the PSP's report. Did the money actually
 *               arrive? This is the only stage that produces a cash booking.
 *
 * Splitting them is the whole design. A single-stage matcher that books on a settlement
 * report is asserting that a PSP's description of its own future behaviour is cash in the
 * bank — and every payout that is reported and never sent, returned two days later, or
 * credited short of a correspondent-bank charge is invisible to it.
 *
 * Both stages are pure functions of their arguments. No clock, no database, no network:
 * `asOf` is passed in, so the same inputs produce the same partition on any day, on any
 * machine, however many times they are run. A reconciliation that cannot be replayed is a
 * reconciliation that cannot be audited.
 *
 * And nothing in here learns a source's name in a form it could branch on. Everything
 * per-source arrives as a `SourcePolicy` — a calendar, a fee model, an allowance — so the
 * canonical boundary holds structurally rather than by convention.
 */

/**
 * Confidences, and why each is what it is. Humans triage a queue by these, so they have to
 * mean more than "big number good".
 */
const CONFIDENCE = {
  /** The PSP named the payout and the arithmetic confirmed it. Nothing is stronger. */
  payout: 1,
  /** Both sides name the same reference and the same gross. */
  exact: 1,
  /** As above, once a dated fee contract is applied — the contract is the only assumption. */
  feeAdjusted: 0.99,
  /** Same reference and gross; only the fee surprises us. Linkage certain, arithmetic not. */
  feeVariance: 0.9,
  /** No shared reference: inferred from an exact, uniquely-solvable sum inside the window. */
  batch: 0.8,
  /** The bank's narration carried the payout's own reference. */
  bankByReference: 1,
  /** The amount and date fit exactly one expected inflow, and nothing else. */
  bankByAmount: 0.85,
  /** As above, less a charge the bank did not announce. */
  bankCharge: 0.75,
  reversal: 1,
  chargeback: 1,
  /** "Not yet" is a conclusion, not a guess: the deadline is arithmetic on declared data. */
  pending: 1,
  /** We have no explanation at all. Saying so with confidence would be a contradiction. */
  none: 0,
} as const;

/**
 * A ledger transaction that opened a receivable — a promise waiting for its money.
 *
 * Identified by what it did to the books, not by a flag: a transaction is a promise if it
 * debited `psp_receivable`. Settlement bookings and reversals credit that account, so they
 * are excluded automatically and no downstream code has to remember which is which.
 */
export interface OpenPromise {
  readonly transactionId: TransactionId;
  readonly source: SourceId;
  readonly reference: Reference;
  readonly occurredAt: Date;
  readonly state: TransactionState;
  /**
   * The rail it arrived on, where the promise knows. Drives which fee contract prices it,
   * since card and transfer are rarely the same rate.
   */
  readonly channel: PaymentChannel | null;
  /** What the receivable was opened at. */
  readonly gross: Money;
  /** How much of it earlier runs already allocated. */
  readonly allocated: Money;
}

const RECEIVABLE: AccountId = 'psp_receivable';

export function receivableOf(transaction: LedgerTransaction): Money {
  const legs = transaction.entries
    .filter((entry) => entry.accountId === RECEIVABLE)
    .map((entry) => entry.amount);
  return legs.length === 0 ? ZERO : sum(legs);
}

export function promisesIn(
  transactions: readonly LedgerTransaction[],
  allocatedByTransaction: ReadonlyMap<TransactionId, Money> = new Map(),
): OpenPromise[] {
  return transactions
    .map((transaction) => ({ transaction, gross: receivableOf(transaction) }))
    .filter(({ gross }) => gross.kobo > 0n)
    .map(({ transaction, gross }) => ({
      transactionId: transaction.transactionId,
      source: transaction.source,
      reference: transaction.reference,
      occurredAt: transaction.occurredAt,
      state: transaction.state,
      channel: transaction.channel,
      gross,
      allocated: allocatedByTransaction.get(transaction.transactionId) ?? ZERO,
    }));
}

/** What is still owed on a promise: what it opened at, less what is already spoken for. */
export function outstanding(promise: OpenPromise): Money {
  return subtract(promise.gross, promise.allocated);
}

// ── Stage two: the PSP's report meets the ledger ────────────────────────────

export interface AllocateInput {
  /** Ledger transactions to consider. Non-promises are ignored, so extras are safe. */
  readonly transactions: readonly LedgerTransaction[];
  readonly allocated: ReadonlyMap<TransactionId, Money>;
  readonly payouts: readonly Payout[];
  readonly lines: readonly SettlementLine[];
  readonly policyFor: PolicyLookup;
  readonly asOf: Date;
  readonly limits?: SubsetLimits;
}

export interface PreparedInflow {
  readonly inflow: ExpectedInflow;
  readonly allocations: readonly InflowAllocation[];
  readonly result: MatchResult;
}

export interface AllocateResult {
  readonly asOf: Date;
  /** Inflows now waiting on the bank. These are recorded; none of them books. */
  readonly prepared: readonly PreparedInflow[];
  readonly deferred: readonly MatchResult[];
  readonly exceptions: readonly MatchResult[];
}

export function allocate(input: AllocateInput): AllocateResult {
  const limits = input.limits ?? DEFAULT_SUBSET_LIMITS;
  const policy = (source: SourceId): SourcePolicy => policyOf(input.policyFor, source);

  // Canonical order in, canonical order out. This is where the run's determinism comes
  // from; every step below iterates these arrays.
  const promises = promisesIn(input.transactions, input.allocated)
    .filter((promise) => outstanding(promise).kobo > 0n)
    .sort(byOccurrenceThenId);
  const payouts = [...input.payouts].sort(byKey((p) => p.payoutReference));
  const lines = [...input.lines].sort(byKey((l) => l.idempotencyKey));

  const claimed = new Map<TransactionId, Money>();
  const prepared: PreparedInflow[] = [];
  const deferred: MatchResult[] = [];
  const exceptions: MatchResult[] = [];

  const stillOwed = (promise: OpenPromise): Money =>
    subtract(outstanding(promise), claimed.get(promise.transactionId) ?? ZERO);

  // ── Payouts: the PSP named the movement ───────────────────────────────────
  for (const payout of payouts) {
    const arithmetic = payoutArithmetic(payout);
    if (!arithmetic.consistent) {
      // The report does not add up against its own itemised deductions. Matching payments
      // to it would blame them for a discrepancy that is in the file.
      exceptions.push({
        ...NO_LINKS,
        payoutReferences: [payout.payoutReference],
        reason: 'PAYOUT_UNBALANCED',
        confidence: CONFIDENCE.none,
      });
      continue;
    }

    const subset = solveAgainst(
      payout.gross,
      payout.expectedNet,
      promises.filter((promise) => promise.source === payout.source && stillOwed(promise).kobo > 0n),
      payout.valueDate,
      policy(payout.source),
      stillOwed,
      limits,
    );

    const inReach = promises.filter(
      (promise) => promise.source === payout.source && stillOwed(promise).kobo > 0n,
    );
    // A payout too small for any whole promise may still be settling part of one.
    const partial = subset
      ? null
      : partialCandidate(payout.gross, inReach, payout.valueDate, policy(payout.source), stillOwed);

    if (!subset && !partial) {
      exceptions.push({
        ...NO_LINKS,
        payoutReferences: [payout.payoutReference],
        reason: 'PHANTOM_CREDIT',
        confidence: CONFIDENCE.none,
        // What the subset search looked at. A payout that matches no combination is the
        // finding most likely to be a data problem rather than a fraud, and the promises it
        // came closest to are what tells the two apart.
        considered: nearestPromises(payout.gross, inReach, payout.valueDate, policy(payout.source), stillOwed),
      });
      continue;
    }

    const covered = partial ? [partial] : subset!;
    const drafts: AllocationDraft[] = partial
      ? [{ transactionId: partial.transactionId, receivable: partial.gross, amount: payout.gross }]
      : subset!.map((promise) => ({
          transactionId: promise.transactionId,
          receivable: promise.gross,
          amount: stillOwed(promise),
        }));
    for (const draft of drafts) {
      claimed.set(
        draft.transactionId,
        sum([claimed.get(draft.transactionId) ?? ZERO, draft.amount]),
      );
    }

    // The deductions belong to the movement; the promises inside it each carry a share.
    // Which share is a rule we chose — see `apportion.ts` — and it is applied here so that
    // the answer is recorded with the decision rather than recomputed later against a rule
    // that may since have changed.
    const inflow = inflowFromPayout(payout, drafts);
    const allocations = withApportionment(inflow.deductions, drafts);

    prepared.push({
      inflow,
      allocations,
      result: {
        ...NO_LINKS,
        transactionIds: allocations.map((a) => a.transactionId),
        payoutReferences: [payout.payoutReference],
        explainedBy: explainAllocations(covered, allocations, policy(payout.source)),
        reason: 'PAYOUT_MATCH',
        confidence: partial ? CONFIDENCE.batch : CONFIDENCE.payout,
      },
    });
  }

  // ── Lines: the source listed transactions and left the movement implicit ──
  const byReference = new Map<string, OpenPromise[]>();
  for (const promise of promises) {
    const key = referenceKey(promise.source, promise.reference);
    const bucket = byReference.get(key);
    if (bucket) bucket.push(promise);
    else byReference.set(key, [promise]);
  }

  const grouped = new Map<
    string,
    { lines: SettlementLine[]; drafts: AllocationDraft[]; explanations: FeeExplanation[] }
  >();

  for (const line of lines) {
    if (line.payoutReference !== null) continue; // already carried by a payout above

    const candidates = byReference.get(referenceKey(line.source, line.reference)) ?? [];
    // Two promises sharing one reference is itself a discrepancy. Picking one would be a
    // coin toss recorded as a fact.
    const promise = candidates.length === 1 ? candidates[0] : undefined;
    if (!promise || stillOwed(promise).kobo <= 0n) {
      exceptions.push({
        ...NO_LINKS,
        settlementKeys: [line.idempotencyKey],
        reason: 'PHANTOM_CREDIT',
        confidence: CONFIDENCE.none,
        // Two promises sharing one reference, or one already fully spoken for. Both are
        // ordinary data problems, and naming which is which saves the reader the query.
        considered: candidates.slice(0, MAX_CANDIDATES).map((candidate) => ({
          candidateId: candidate.transactionId,
          kind: 'transaction' as const,
          difference: subtract(line.gross, candidate.gross),
          rejectedBecause:
            candidates.length > 1 ? ('ambiguous' as const) : ('already_claimed' as const),
        })),
      });
      continue;
    }

    const conclusion = concludeByReference(promise, line, policy(line.source));
    if (!conclusion) {
      exceptions.push({
        ...NO_LINKS,
        transactionIds: [promise.transactionId],
        settlementKeys: [line.idempotencyKey],
        reason: 'AMOUNT_MISMATCH',
        confidence: CONFIDENCE.none,
        considered: [
          {
            candidateId: promise.transactionId,
            kind: 'transaction',
            difference: subtract(line.gross, promise.gross),
            rejectedBecause: 'wrong_state',
          },
        ],
      });
      continue;
    }

    // A reversal or a clawback never becomes an expected inflow: no money is coming, so
    // there is nothing for a bank statement to confirm. These book on their own.
    if (conclusion.reason === 'REVERSAL' || conclusion.reason === 'CHARGEBACK') {
      claimed.set(promise.transactionId, sum([claimed.get(promise.transactionId) ?? ZERO, promise.gross]));
      prepared.push({
        inflow: {
          key: line.idempotencyKey,
          source: line.source,
          derived: false,
          gross: promise.gross,
          expectedNet: ZERO,
          deductions: [],
          valueDate: line.settledAt,
          settlementKeys: [line.idempotencyKey],
          evidenceId: line.evidenceId,
        },
        allocations: [
          {
            transactionId: promise.transactionId,
            receivable: promise.gross,
            amount: promise.gross,
            deductions: [],
            net: promise.gross,
          },
        ],
        result: {
          ...NO_LINKS,
          transactionIds: [promise.transactionId],
          settlementKeys: [line.idempotencyKey],
          reason: conclusion.reason,
          confidence: conclusion.confidence,
        },
      });
      continue;
    }

    const amount = stillOwed(promise);
    claimed.set(promise.transactionId, sum([claimed.get(promise.transactionId) ?? ZERO, amount]));

    const key = derivedKey(line.source, line.settledAt);
    const group = grouped.get(key) ?? { lines: [], drafts: [], explanations: [] };
    group.lines.push(line);
    group.drafts.push({
      transactionId: promise.transactionId,
      receivable: promise.gross,
      amount,
    });
    // The contract that priced this line, kept with the conclusion it justified. A later
    // renegotiation must not be able to change the answer to "why did we accept this fee?"
    if (conclusion.explanation) group.explanations.push(conclusion.explanation);
    grouped.set(key, group);
  }

  for (const [, group] of [...grouped].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const first = group.lines[0]!;
    const inflow = inflowFromLines(first.source, first.settledAt, group.lines, group.drafts);
    const allocations = withApportionment(inflow.deductions, group.drafts);

    prepared.push({
      inflow,
      allocations,
      result: {
        ...NO_LINKS,
        transactionIds: allocations.map((a) => a.transactionId),
        settlementKeys: group.lines.map((line) => line.idempotencyKey),
        explainedBy: group.explanations,
        reason: 'BATCH_MATCH',
        confidence: CONFIDENCE.batch,
      },
    });
  }

  // ── What is left, and whether it is late enough to worry about ────────────
  for (const promise of promises) {
    if (stillOwed(promise).kobo <= 0n) continue;
    if (promise.state === 'settled' || promise.state === 'reversed') continue;

    const partly = (claimed.get(promise.transactionId) ?? ZERO).kobo > 0n;
    const result: MatchResult = {
      ...NO_LINKS,
      transactionIds: [promise.transactionId],
      reason: partly ? 'PARTIAL_SETTLEMENT' : 'PENDING_T_PLUS_N',
      confidence: CONFIDENCE.pending,
    };

    if (!isOverdue(policy(promise.source).calendar, promise.occurredAt, input.asOf)) {
      deferred.push(result);
    } else if (partly) {
      // Part of it arrived, so this is not a missing settlement — it is an outstanding
      // remainder, and saying "missing" would misdescribe a payment that is half paid.
      deferred.push(result);
    } else {
      exceptions.push({ ...result, reason: 'MISSING_SETTLEMENT', confidence: CONFIDENCE.none });
    }
  }

  return { asOf: input.asOf, prepared, deferred, exceptions };
}

// ── Stage three: the bank statement meets the PSP's report ──────────────────

/**
 * An inflow a bank credit already confirmed, in this run or an earlier one.
 *
 * Stage three needs these even though there is nothing left to do with them, because two of
 * the three bank-side exceptions are *about* them: a payout credited twice, and a payout
 * credited and then taken back. Without this, both look like money nobody can identify —
 * which is true but useless, and describes the wrong problem.
 */
export interface ConfirmedInflow {
  readonly key: string;
  readonly source: SourceId;
  /** What actually landed, per the bank — not what the PSP said would land. */
  readonly credited: Money;
  readonly confirmedBy: IdempotencyKey;
  readonly valueDate: Date | null;
}

export interface ConfirmInput {
  /** Inflows recorded by stage two that no bank credit has confirmed yet. */
  readonly inflows: readonly ExpectedInflow[];
  /**
   * Inflows already confirmed. Not candidates — evidence for recognising a second credit
   * for money we have already banked, and a debit taking one of them back.
   */
  readonly confirmedInflows?: readonly ConfirmedInflow[];
  readonly bankLines: readonly BankStatementLine[];
  readonly policyFor: PolicyLookup;
  readonly asOf: Date;
}

export interface Confirmation {
  readonly inflow: ExpectedInflow;
  readonly credit: BankStatementLine;
  /** The inflow's deductions, plus a bank charge when the credit came up short. */
  readonly deductions: readonly { accountId: AccountId; amount: Money }[];
  readonly result: MatchResult;
}

/**
 * Cash that arrived and then left again.
 *
 * The most alarming thing a bank statement can say, and the one the two-way design could
 * not see at all: we booked the money, told everyone the payment had settled, and the
 * payout bounced. It is recognised from a *debit*, which is why stage three cannot simply
 * filter the statement down to credits.
 */
export interface ReturnedPayout {
  readonly inflow: ConfirmedInflow;
  /** The statement line that took it back. */
  readonly debit: BankStatementLine;
  readonly result: MatchResult;
}

export interface ConfirmResult {
  readonly asOf: Date;
  /** These book. Nothing else in the system does. */
  readonly confirmed: readonly Confirmation[];
  /** These book too — as an exact negation of the confirmation they undo. */
  readonly returned: readonly ReturnedPayout[];
  readonly deferred: readonly MatchResult[];
  readonly exceptions: readonly MatchResult[];
}

export function confirm(input: ConfirmInput): ConfirmResult {
  const policy = (source: SourceId): SourcePolicy => policyOf(input.policyFor, source);

  const statement = [...input.bankLines].sort(byKey((line) => line.idempotencyKey));
  const credits = statement.filter(isCredit);
  // Debits are not noise to be filtered out. A returned payout is a debit, and it is the
  // most alarming thing a statement can say.
  const debits = statement.filter((line) => line.direction === 'debit');
  const inflows = [...input.inflows].sort(byKey((inflow) => inflow.key));
  const alreadyBanked = [...(input.confirmedInflows ?? [])].sort(byKey((inflow) => inflow.key));

  const spent = new Set<string>();
  /** Confirmed in *this* run, so a second credit in the same statement is recognisable. */
  const bankedHere: ConfirmedInflow[] = [];
  const confirmed: Confirmation[] = [];
  const returned: ReturnedPayout[] = [];
  const deferred: MatchResult[] = [];
  const exceptions: MatchResult[] = [];

  const banked = (): ConfirmedInflow[] => [...alreadyBanked, ...bankedHere];

  for (const credit of credits) {
    const available = inflows.filter((inflow) => !spent.has(inflow.key));

    // The bank quoted the payout's own reference in the narration. Nothing beats that —
    // and note the matcher does the resolving, against inflows it actually holds, rather
    // than a parser having decided at ingest time which token was a reference.
    const named = available.filter((inflow) => identifies(credit, inflow.key));

    const candidate =
      named.length === 1
        ? named[0]
        : named.length > 1
          ? undefined
          : uniqueByAmount(available, credit, policy);

    if (!candidate) {
      // Before calling it unidentified, ask the more specific question: is this the *same*
      // money arriving twice? A payout we have already banked, named again or matched
      // again by amount, is not a mystery — it is cash we may have to send back, and
      // saying "unidentified" would file the most consequential bank event in the system
      // under the same heading as a stray ₦42 credit.
      const duplicate = duplicateOf(credit, banked());
      if (duplicate) {
        exceptions.push({
          ...NO_LINKS,
          bankCreditKeys: [credit.idempotencyKey],
          payoutReferences: [duplicate.key],
          reason: 'DUPLICATE_BANK_CREDIT',
          confidence: CONFIDENCE.none,
          considered: [
            {
              candidateId: duplicate.confirmedBy,
              kind: 'bank_credit',
              difference: subtract(credit.amount, duplicate.credited),
              rejectedBecause: 'already_claimed',
            },
          ],
        });
        continue;
      }

      // A credit whose narration identifies nothing and whose amount matches nothing —
      // or matches several things equally well, which is the same problem wearing a
      // different hat. The near-misses travel with it: a human should not have to
      // rediscover what the matcher already looked at.
      exceptions.push({
        ...NO_LINKS,
        bankCreditKeys: [credit.idempotencyKey],
        reason: 'UNIDENTIFIED_CREDIT',
        confidence: CONFIDENCE.none,
        considered: nearestInflows(credit, inflows, spent, named, policy),
      });
      continue;
    }

    const shortfall = subtract(candidate.expectedNet, credit.amount);
    const allowance = policy(candidate.source).bankChargeAllowance;

    let deductions = [...candidate.deductions];
    let reason: MatchResult['reason'] = 'BANK_CONFIRMED';
    let confidence: number = named.length === 1 ? CONFIDENCE.bankByReference : CONFIDENCE.bankByAmount;

    if (shortfall.kobo !== 0n) {
      if (shortfall.kobo < 0n || shortfall.kobo > allowance) {
        // More than the bank could plausibly have taken, or more than was expected at all.
        // Booking it would need a plug entry, and a plug entry is where wrong money hides.
        exceptions.push({
          ...NO_LINKS,
          bankCreditKeys: [credit.idempotencyKey],
          payoutReferences: candidate.derived ? [] : [candidate.key],
          reason: 'AMOUNT_MISMATCH',
          confidence: CONFIDENCE.none,
          considered: [
            {
              candidateId: candidate.key,
              kind: candidate.derived ? 'settlement_line' : 'payout',
              difference: shortfall,
              rejectedBecause: 'amount_differs',
            },
          ],
        });
        continue;
      }
      deductions = [...deductions, { accountId: 'bank_charges', amount: shortfall }];
      reason = 'BANK_CHARGE';
      confidence = CONFIDENCE.bankCharge;
    }

    spent.add(candidate.key);
    bankedHere.push({
      key: candidate.key,
      source: candidate.source,
      credited: credit.amount,
      confirmedBy: credit.idempotencyKey,
      valueDate: credit.valueDate,
    });
    confirmed.push({
      inflow: candidate,
      credit,
      deductions,
      result: {
        ...NO_LINKS,
        settlementKeys: candidate.settlementKeys,
        payoutReferences: candidate.derived ? [] : [candidate.key],
        bankCreditKeys: [credit.idempotencyKey],
        reason,
        confidence,
      },
    });
  }

  // ── Debits: money that arrived and then left again ────────────────────────
  //
  // Only against payouts we have actually banked. A debit matching nothing is somebody
  // else's story — an outgoing payment, a standing order, a bank fee — and this system has
  // no opinion about those.
  for (const debit of debits) {
    const takenBack = returnedBy(debit, banked(), returned);
    if (!takenBack) continue;

    returned.push({
      inflow: takenBack,
      debit,
      result: {
        ...NO_LINKS,
        payoutReferences: [takenBack.key],
        bankCreditKeys: [debit.idempotencyKey],
        reason: 'RETURNED_PAYOUT',
        confidence: CONFIDENCE.bankByReference,
        considered: [
          {
            candidateId: takenBack.confirmedBy,
            kind: 'bank_credit',
            difference: subtract(debit.amount, takenBack.credited),
            rejectedBecause: 'already_claimed',
          },
        ],
      },
    });
  }

  // Inflows the bank has not confirmed. Reported is not received.
  for (const inflow of inflows) {
    if (spent.has(inflow.key)) continue;

    const result: MatchResult = {
      ...NO_LINKS,
      settlementKeys: inflow.settlementKeys,
      payoutReferences: inflow.derived ? [] : [inflow.key],
      reason: 'AWAITING_BANK_CREDIT',
      confidence: CONFIDENCE.pending,
    };

    const due = inflow.valueDate ?? input.asOf;
    if (isOverdue(policy(inflow.source).calendar, due, input.asOf)) {
      exceptions.push({ ...result, reason: 'MISSING_SETTLEMENT', confidence: CONFIDENCE.none });
    } else {
      deferred.push(result);
    }
  }

  return { asOf: input.asOf, confirmed, returned, deferred, exceptions };
}

/** Does this statement line name that movement — in a structured field, or in its prose? */
function identifies(line: BankStatementLine, key: string): boolean {
  return line.statedReference === key || line.narrationTokens.includes(key.toUpperCase());
}

/**
 * Is this credit the same money we have already banked?
 *
 * Named beats amount, as everywhere else. An unnamed credit for exactly what we already
 * received from a payout is treated as a duplicate too — the alternative is calling it
 * unidentified, which is technically true and files the most consequential bank event in
 * the system beside a stray ₦42 credit. A duplicate is not booked either way; the
 * difference is entirely in what the human is told.
 */
function duplicateOf(
  credit: BankStatementLine,
  banked: readonly ConfirmedInflow[],
): ConfirmedInflow | undefined {
  const named = banked.filter((inflow) => identifies(credit, inflow.key));
  if (named.length === 1) return named[0];

  const sameAmount = banked.filter((inflow) => equals(inflow.credited, credit.amount));
  return sameAmount.length === 1 ? sameAmount[0] : undefined;
}

/**
 * The confirmed payout this debit is taking back, or nothing.
 *
 * The amounts must agree exactly. A bank returning a payout returns the payout — a partial
 * return is not a thing that happens, and treating an approximate match as a return would
 * unwind a settlement on the strength of a coincidence. One debit undoes one confirmation,
 * so anything already claimed by an earlier debit in the same statement is excluded.
 */
function returnedBy(
  debit: BankStatementLine,
  banked: readonly ConfirmedInflow[],
  already: readonly ReturnedPayout[],
): ConfirmedInflow | undefined {
  const claimed = new Set(already.map((entry) => entry.inflow.key));
  const open = banked.filter(
    (inflow) => !claimed.has(inflow.key) && equals(inflow.credited, debit.amount),
  );
  if (open.length === 0) return undefined;

  const named = open.filter((inflow) => identifies(debit, inflow.key));
  if (named.length === 1) return named[0];
  // Unnamed: only when exactly one banked payout is for this amount. Two would mean
  // guessing which settlement to unwind, and unwinding the wrong one is worse than
  // escalating both.
  return named.length === 0 && open.length === 1 ? open[0] : undefined;
}

/**
 * The inflows this credit came closest to, and why each was not taken.
 *
 * The working, kept. "₦12,000 credited, matches nothing" is a mystery somebody has to
 * reconstruct from scratch; "the nearest was PO-91 at ₦11,950 — ₦50 out — and PO-88 fits
 * exactly but was already claimed by another credit" is a decision they can make now.
 *
 * Ordered by how close, and capped, because a list of every open inflow is not an
 * explanation — it is a haystack with a note attached.
 */
function nearestInflows(
  credit: BankStatementLine,
  inflows: readonly ExpectedInflow[],
  spent: ReadonlySet<string>,
  named: readonly ExpectedInflow[],
  policyFor: (source: SourceId) => SourcePolicy,
): RejectedCandidate[] {
  const ambiguous = new Set(named.length > 1 ? named.map((inflow) => inflow.key) : []);

  return [...inflows]
    .map((inflow) => {
      const difference = subtract(inflow.expectedNet, credit.amount);
      const magnitude = difference.kobo < 0n ? -difference.kobo : difference.kobo;

      const rejectedBecause: RejectedCandidate['rejectedBecause'] = ambiguous.has(inflow.key)
        ? 'ambiguous'
        : spent.has(inflow.key)
          ? 'already_claimed'
          : !notBefore(credit, inflow)
            ? 'outside_window'
            : 'amount_differs';

      return {
        candidate: {
          candidateId: inflow.key,
          kind: (inflow.derived ? 'settlement_line' : 'payout') as RejectedCandidate['kind'],
          difference,
          rejectedBecause,
        },
        magnitude,
        // A candidate whose amount fits and lost for another reason is far more
        // interesting than one that is merely nearest, so it sorts first.
        exact: magnitude <= policyFor(inflow.source).bankChargeAllowance ? 0 : 1,
      };
    })
    .sort((a, b) => (a.exact !== b.exact ? a.exact - b.exact : compareBigint(a.magnitude, b.magnitude)))
    .slice(0, MAX_CANDIDATES)
    .map((entry) => entry.candidate);
}

/**
 * The promises a payout came closest to, and why the search rejected each.
 *
 * A payout that matches no combination of promises is the finding most likely to be a data
 * problem rather than a fraud — a webhook we never received, a payment recorded under a
 * different reference, a promise that a previous payout already claimed. Which of those it
 * is shows in the near-misses, so they travel with the exception rather than being
 * recomputed by whoever picks it up.
 */
function nearestPromises(
  target: Money,
  candidates: readonly OpenPromise[],
  valueDate: Date | null,
  policy: SourcePolicy,
  owed: (promise: OpenPromise) => Money,
): RejectedCandidate[] {
  return [...candidates]
    .map((promise) => {
      const difference = subtract(owed(promise), target);
      const magnitude = difference.kobo < 0n ? -difference.kobo : difference.kobo;
      return {
        candidate: {
          candidateId: promise.transactionId,
          kind: 'transaction' as const,
          difference,
          rejectedBecause: !withinReach(promise, valueDate, policy)
            ? ('outside_window' as const)
            : ('amount_differs' as const),
        },
        magnitude,
      };
    })
    .sort((a, b) => compareBigint(a.magnitude, b.magnitude))
    .slice(0, MAX_CANDIDATES)
    .map((entry) => entry.candidate);
}

function compareBigint(a: bigint, b: bigint): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * The one inflow this credit could be, by amount, or nothing.
 *
 * Requiring uniqueness is the whole value. Two payouts of the same amount on the same day
 * is ordinary, and picking the first would settle the wrong one — leaving the right one to
 * escalate later as an inexplicable absence, long after anybody could reconstruct what
 * happened.
 */
function uniqueByAmount(
  inflows: readonly ExpectedInflow[],
  credit: BankStatementLine,
  policyFor: (source: SourceId) => SourcePolicy,
): ExpectedInflow | undefined {
  // The credit may arrive slightly short of what was promised, because a correspondent
  // bank took a charge nobody announced. The search window is the source's own allowance,
  // so a rail with no allowance still requires the amounts to agree exactly.
  const fits = inflows.filter((inflow) => {
    if (!notBefore(credit, inflow)) return false;
    if (equals(inflow.expectedNet, credit.amount)) return true;

    const shortfall = subtract(inflow.expectedNet, credit.amount);
    return shortfall.kobo > 0n && shortfall.kobo <= policyFor(inflow.source).bankChargeAllowance;
  });
  return fits.length === 1 ? fits[0] : undefined;
}

/** Money cannot be credited before the PSP says it sent it. */
function notBefore(credit: BankStatementLine, inflow: ExpectedInflow): boolean {
  if (inflow.valueDate === null) return true;
  return credit.valueDate.getTime() >= inflow.valueDate.getTime() - 24 * 60 * 60_000;
}

interface Conclusion {
  readonly reason: MatchResult['reason'];
  readonly confidence: number;
  /** The contract that priced it, where pricing was involved at all. */
  readonly explanation?: FeeExplanation;
}

/**
 * What each promise in a movement was expected to cost, and what it appears to have cost.
 *
 * The expectation comes from the contract in force *at the payment's own moment*, for the
 * payment's own channel — the whole point of dated, scoped contracts. The observation comes
 * from apportionment: the payout charged the batch, and this promise's share of that charge
 * is what it cost by the rule we chose.
 *
 * Recorded whether or not the two agree, and recorded with `contractId: null` when no
 * contract covered the payment at all. "We matched this on amounts alone" is a conclusion,
 * and a conclusion left unwritten is indistinguishable later from one nobody reached.
 */
function explainAllocations(
  promises: readonly OpenPromise[],
  allocations: readonly InflowAllocation[],
  policy: SourcePolicy,
): FeeExplanation[] {
  const byTransaction = new Map(allocations.map((a) => [a.transactionId, a]));

  return promises.map((promise) => {
    const allocation = byTransaction.get(promise.transactionId);
    const predicted = policy.expectedFee
      ? policy.expectedFee(
          allocation?.amount ?? promise.gross,
          promise.occurredAt,
          promise.channel ?? 'unknown',
        )
      : null;

    const share = (accountId: AccountId): Money | null => {
      const entries = allocation?.deductions.filter((d) => d.accountId === accountId) ?? [];
      return entries.length === 0 ? null : sum(entries.map((entry) => entry.amount));
    };

    return {
      transactionId: promise.transactionId,
      contractId: predicted?.contractId ?? null,
      channel: predicted?.channel ?? null,
      expectedFee: predicted?.fee ?? null,
      expectedVat: predicted?.vat ?? null,
      observedFee: share('fees_expense'),
    };
  });
}

/**
 * Both sides name the same event. What do they say about it, and do they agree?
 *
 * Status is read first, because "the money came back" and "the money is coming" are
 * different events that happen to share a reference. Status is a typed canonical field —
 * `reasonHints` are evidence for a human and are never parsed to reach a decision (ADR-0010).
 */
function concludeByReference(
  promise: OpenPromise,
  line: SettlementLine,
  policy: SourcePolicy,
): Conclusion | null {
  const awaiting = promise.state === 'authorized' || promise.state === 'exception';

  switch (line.status) {
    case 'reversed':
      return awaiting ? { reason: 'REVERSAL', confidence: CONFIDENCE.reversal } : null;

    case 'chargeback':
      // A clawback presupposes money that already landed. Against a promise still waiting
      // for its first payout there is nothing to claw back.
      return promise.state === 'settled'
        ? { reason: 'CHARGEBACK', confidence: CONFIDENCE.chargeback }
        : null;

    case 'settled':
      return awaiting ? concludeAmounts(promise, line, policy) : null;
  }
}

/**
 * Does the money add up?
 *
 * Agreement on the **gross** is what the first tier asks for, not agreement on the net.
 * The gross is the number both sides observed independently — what the customer paid —
 * while the net is downstream of deductions only one side chose. When the grosses agree,
 * the fee is a fact we accept whatever its size; when they do not, the dated fee contract
 * gets one chance to explain the whole difference, and failing that we say so rather than
 * inventing a story.
 */
function concludeAmounts(
  promise: OpenPromise,
  line: SettlementLine,
  policy: SourcePolicy,
): Conclusion {
  // The line states its own channel, which is better information than the promise's: the
  // settlement report is the source describing what it actually processed. Fall back to the
  // promise's, then to `unknown`, which finds a blended contract or nothing.
  const channel = line.channel ?? promise.channel ?? 'unknown';
  const predicted = policy.expectedFee
    ? policy.expectedFee(promise.gross, promise.occurredAt, channel)
    : null;

  const explanation: FeeExplanation = {
    transactionId: promise.transactionId,
    contractId: predicted?.contractId ?? null,
    channel: predicted?.channel ?? null,
    expectedFee: predicted?.fee ?? null,
    expectedVat: predicted?.vat ?? null,
    observedFee: line.fee,
  };

  if (equals(line.gross, promise.gross)) {
    return predicted === null || equals(predicted.total, line.fee)
      ? { reason: 'EXACT_MATCH', confidence: CONFIDENCE.exact, explanation }
      : { reason: 'FEE_VARIANCE', confidence: CONFIDENCE.feeVariance, explanation };
  }

  if (predicted !== null && equals(subtract(promise.gross, predicted.total), line.net)) {
    return { reason: 'FEE_ADJUSTED_MATCH', confidence: CONFIDENCE.feeAdjusted, explanation };
  }

  return { reason: 'AMOUNT_MISMATCH', confidence: CONFIDENCE.none, explanation };
}

/**
 * Which promises does this movement cover?
 *
 * Two targets are tried, in order of how little they assume. First the gross: a PSP that
 * reports the movement's gross lets us match with no fee contract at all. Failing that,
 * the expected net, with each promise reduced by the fee its contract predicts — which
 * needs the contract to be right, and is exactly the transformation-aware matching that
 * turns a file full of apparent mismatches into a file full of matches.
 */
function solveAgainst(
  gross: Money,
  expectedNet: Money,
  candidates: readonly OpenPromise[],
  valueDate: Date | null,
  policy: SourcePolicy,
  owed: (promise: OpenPromise) => Money,
  limits: SubsetLimits,
): readonly OpenPromise[] | null {
  const reachable = candidates.filter((promise) => withinReach(promise, valueDate, policy));
  if (reachable.length === 0) return null;

  const byGross = uniqueSubsetSummingTo(reachable, (p) => owed(p).kobo, gross.kobo, limits);
  if (byGross.kind === 'unique') return byGross.subset;
  if (byGross.kind === 'undecidable') return null;

  const model = policy.expectedFee;
  if (!model) return null;

  const byNet = uniqueSubsetSummingTo(
    reachable,
    (promise) => {
      const predicted = model(owed(promise), promise.occurredAt, promise.channel ?? 'unknown');
      return predicted ? subtract(owed(promise), predicted.total).kobo : owed(promise).kobo;
    },
    expectedNet.kobo,
    limits,
  );
  return byNet.kind === 'unique' ? byNet.subset : null;
}

/**
 * The one promise this movement could be settling *part* of, or nothing.
 *
 * A PSP that pays half a payment now and half when a dispute hold lifts produces a payout
 * smaller than any single receivable, which no subset of whole promises can ever sum to.
 * Without this, that entirely ordinary event is a `PHANTOM_CREDIT` and somebody gets
 * woken for a settlement that is going exactly to plan.
 *
 * The uniqueness requirement is what keeps it safe: taking part of a promise is a stronger
 * claim than taking all of one, because the leftover stays open and will be matched again
 * later. Two candidates that could each absorb the payout means we cannot know whose
 * remainder we are creating, so neither is touched.
 */
function partialCandidate(
  gross: Money,
  candidates: readonly OpenPromise[],
  valueDate: Date | null,
  policy: SourcePolicy,
  owed: (promise: OpenPromise) => Money,
): OpenPromise | null {
  if (gross.kobo <= 0n) return null;

  const roomy = candidates.filter(
    (promise) => withinReach(promise, valueDate, policy) && owed(promise).kobo > gross.kobo,
  );
  return roomy.length === 1 ? roomy[0]! : null;
}

/**
 * A source that does not disclose when the money moved (ADR-0019) leaves no timestamp to
 * reason against. Rather than substitute the run's own clock — the one input that would
 * make a replay disagree with the original run — such a movement is matched on arithmetic
 * alone, without a time filter.
 */
function withinReach(promise: OpenPromise, valueDate: Date | null, policy: SourcePolicy): boolean {
  if (valueDate === null) return true;
  if (promise.occurredAt.getTime() > valueDate.getTime()) return false;
  // A promise older than its own deadline plus grace is not part of this movement; it is a
  // separate problem that has already escalated.
  return !isOverdue(policy.calendar, promise.occurredAt, valueDate);
}

/** ASCII unit separator: a control character that cannot occur in an id or a reference. */
const SEPARATOR = String.fromCharCode(31);

function referenceKey(source: SourceId, reference: Reference): string {
  return [source, reference].join(SEPARATOR);
}

function byOccurrenceThenId(a: OpenPromise, b: OpenPromise): number {
  const byTime = a.occurredAt.getTime() - b.occurredAt.getTime();
  if (byTime !== 0) return byTime;
  return a.transactionId < b.transactionId ? -1 : a.transactionId > b.transactionId ? 1 : 0;
}

function byKey<T>(keyOf: (item: T) => string): (a: T, b: T) => number {
  return (a, b) => {
    const left = keyOf(a);
    const right = keyOf(b);
    return left < right ? -1 : left > right ? 1 : 0;
  };
}
