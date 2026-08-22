import assert from 'node:assert/strict';
import { test } from 'node:test';

import type {
  BankStatementLine,
  BusinessCalendar,
  LedgerTransaction,
  MatchResult,
  Money,
  Payout,
  SettlementAdjustment,
  SettlementLine,
} from '@recon/canon';
import { ANY_CHANNEL, feeFor, money, NO_LINEAGE, reasonKind, ZERO } from '@recon/canon';

import { allocate, confirm } from './match.js';
import type { PolicyLookup } from './policy.js';

/**
 * Both stages are pure, so these tests need nothing but arguments — no database, no clock,
 * no fixtures on disk. The intellectual core of the system is the cheapest part of it to
 * interrogate, and that is deliberate.
 */

const T0 = new Date('2026-08-12T09:00:00Z');
const VALUE_DATE = new Date('2026-08-13T09:00:00Z');
const ASOF = new Date('2026-08-13T12:00:00Z');

const CALENDAR: BusinessCalendar = {
  timeZone: 'Africa/Lagos',
  cutOffMinutes: 17 * 60,
  settlementBusinessDays: 1,
  weekend: [0, 6],
  holidayCalendars: [],
  graceMinutes: 24 * 60,
};

const CARD = {
  percentBasisPoints: 150,
  flatKobo: 0n,
  flatWaivedBelowKobo: null,
  capKobo: null,
  vatBasisPoints: 750,
};

const CARD_CONTRACT = {
  contractId: 'test-contract',
  channel: ANY_CHANNEL,
  effectiveFrom: new Date(0),
} as const;

const policy: PolicyLookup = () => ({
  calendar: CALENDAR,
  expectedFee: (gross) => feeFor(CARD, gross, CARD_CONTRACT),
  bankChargeAllowance: 10_000n, // ₦100
  reserveReleaseDays: 90,
  // Off by default in this suite: most cases here are about one credit meeting one
  // inflow, and set-level pairing would quietly rescue the ambiguity a few of them are
  // asserting. The cases that exercise it turn it on explicitly.
  pairEqualAmounts: false,
});

const noRateCard: PolicyLookup = () => ({
  calendar: CALENDAR,
  expectedFee: null,
  bankChargeAllowance: 0n,
  pairEqualAmounts: false,
  reserveReleaseDays: null,
});

function promise(id: string, gross: bigint, occurredAt = T0): LedgerTransaction {
  return {
    transactionId: id,
    state: 'authorized',
    source: 'alpha',
    reference: id,
    channel: 'card',
    occurredAt,
    recordedAt: occurredAt,
    entries: [
      { entryId: `${id}#0`, transactionId: id, accountId: 'psp_receivable', amount: money(gross) },
      {
        entryId: `${id}#1`,
        transactionId: id,
        accountId: 'merchant_revenue',
        amount: money(-gross),
      },
    ],
  };
}

function payout(
  reference: string,
  gross: bigint,
  adjustments: readonly SettlementAdjustment[],
): Payout {
  const deducted = adjustments.reduce((total, a) => total + a.amount.kobo, 0n);
  return {
    payoutReference: reference,
    source: 'alpha',
    status: 'reported',
    gross: money(gross),
    expectedNet: money(gross - deducted),
    adjustments,
    reportedAt: VALUE_DATE,
    valueDate: VALUE_DATE,
    evidenceId: 'evidence-1',
    lineage: NO_LINEAGE,
    idempotencyKey: `payout:alpha:${reference}`,
  };
}

const deduction = (
  kind: SettlementAdjustment['kind'],
  kobo: bigint,
): SettlementAdjustment => ({ kind, amount: money(kobo), narration: kind });

function credit(
  key: string,
  amount: bigint,
  options: { narration?: string; valueDate?: Date; direction?: 'credit' | 'debit' } = {},
): BankStatementLine {
  const narration = options.narration ?? 'INBOUND TRANSFER';
  return {
    reference: key,
    bankAccountId: 'gtb-0001',
    direction: options.direction ?? 'credit',
    amount: money(amount),
    balanceAfter: null,
    valueDate: options.valueDate ?? VALUE_DATE,
    narration,
    narrationTokens: narration.toUpperCase().match(/[A-Z0-9][A-Z0-9_-]{5,}/g) ?? [],
    statedReference: null,
    evidenceId: 'evidence-bank',
    lineage: NO_LINEAGE,
    idempotencyKey: key,
  };
}

const allocateWith = (
  transactions: readonly LedgerTransaction[],
  payouts: readonly Payout[],
  lines: readonly SettlementLine[] = [],
  policyFor: PolicyLookup = policy,
  allocated = new Map<string, Money>(),
) => allocate({ transactions, allocated, payouts, lines, policyFor, asOf: ASOF });

const only = (results: readonly MatchResult[]): MatchResult => {
  assert.equal(results.length, 1, `expected one result, got ${results.length}`);
  return results[0]!;
};

// ── Stage two: the PSP's report meets the ledger ────────────────────────────

/**
 * The shape the two-way design could not express: one payout, several payments, and the
 * PSP telling us so. The arithmetic confirms what we were told rather than discovering it.
 */
test('one payout covering several payments is matched and books nothing', () => {
  const result = allocateWith(
    [promise('pay-1', 300_000n), promise('pay-2', 700_000n), promise('pay-3', 500_000n)],
    [payout('PO-1', 1_000_000n, [deduction('fee', 15_000n)])],
  );

  const prepared = result.prepared;
  assert.equal(prepared.length, 1);
  assert.equal(prepared[0]!.result.reason, 'PAYOUT_MATCH');
  assert.equal(reasonKind(prepared[0]!.result.reason), 'match');
  assert.deepEqual([...prepared[0]!.result.transactionIds].sort(), ['pay-1', 'pay-2']);
  assert.deepEqual(prepared[0]!.result.payoutReferences, ['PO-1']);
  // Nothing is confirmed, so nothing may book. The inflow is a claim, not cash.
  assert.equal(prepared[0]!.inflow.derived, false);
  assert.equal(prepared[0]!.inflow.expectedNet.kobo, 985_000n);
});

/**
 * The deductions ADR, at the point it matters. A ₦57,500 shortfall is not "the fee" — it
 * is a fee, a tax, a reserve and a penalty, and each books to the account that describes
 * it. Reserves are an asset: the PSP is holding our money, not keeping it.
 */
test('every deduction is carried to its own account, not summed into a fee', () => {
  const result = allocateWith(
    [promise('pay-1', 1_000_000n)],
    [
      payout('PO-2', 1_000_000n, [
        deduction('fee', 15_000n),
        deduction('tax', 1_125n),
        deduction('reserve', 40_000n),
        deduction('penalty', 1_375n),
      ]),
    ],
  );

  assert.deepEqual(
    result.prepared[0]!.inflow.deductions.map((d) => [d.accountId, d.amount.kobo]),
    [
      ['fees_expense', 15_000n],
      ['taxes_withheld', 1_125n],
      ['psp_reserve', 40_000n],
      ['penalties', 1_375n],
    ],
  );
  assert.equal(result.prepared[0]!.inflow.expectedNet.kobo, 942_500n);
});

/**
 * A report whose declared net does not equal its own itemised deductions has something in
 * it nobody has told us about. Matching payments to it would blame them for a discrepancy
 * that is in the file.
 */
test('a payout that does not add up is refused before any matching', () => {
  const unbalanced: Payout = {
    ...payout('PO-3', 1_000_000n, [deduction('fee', 15_000n)]),
    expectedNet: money(900_000n), // ₦850 short of gross less the declared fee
  };

  const result = allocateWith([promise('pay-1', 1_000_000n)], [unbalanced]);

  assert.equal(result.prepared.length, 0);
  assert.ok(result.exceptions.some((finding) => finding.reason === 'PAYOUT_UNBALANCED'));
});

/**
 * Partial settlement: a PSP settles half a payment now and half when a hold lifts. The
 * two-way design had no way to say this and would have called it a mismatch — escalating
 * something that is going perfectly well.
 */
test('a payment settled in part keeps its remainder outstanding', () => {
  const first = allocateWith(
    [promise('pay-1', 1_000_000n)],
    [payout('PO-4', 400_000n, [])],
    [],
    noRateCard,
  );

  // Only ₦4,000 of the ₦10,000 receivable is spoken for.
  assert.equal(first.prepared[0]!.allocations[0]!.amount.kobo, 400_000n);

  // A later run, told what the first one allocated, sees the remainder and nothing else.
  const second = allocateWith(
    [promise('pay-1', 1_000_000n)],
    [payout('PO-5', 600_000n, [])],
    [],
    noRateCard,
    new Map([['pay-1', money(400_000n)]]),
  );

  assert.equal(second.prepared[0]!.allocations[0]!.amount.kobo, 600_000n);
  assert.equal(second.prepared[0]!.result.reason, 'PAYOUT_MATCH');
});

test('a payout that matches no combination of payments is escalated, not forced', () => {
  const result = allocateWith(
    [promise('pay-1', 300_000n)],
    [payout('PO-6', 999_999n, [])],
    [],
    noRateCard,
  );

  assert.equal(result.prepared.length, 0);
  assert.ok(result.exceptions.some((f) => f.reason === 'PHANTOM_CREDIT'));
});

/**
 * The most important refusal in the system. Two combinations sum to the payout, so there
 * is no way to know which payments it covered — and settling the wrong ones leaves the
 * right ones to escalate later as mysteries nobody can reconstruct.
 */
test('an ambiguous payout is refused rather than guessed', () => {
  const result = allocateWith(
    [promise('pay-1', 500_000n), promise('pay-2', 500_000n), promise('pay-3', 500_000n)],
    [payout('PO-7', 1_000_000n, [])],
    [],
    noRateCard,
  );

  assert.equal(result.prepared.length, 0);
  assert.equal(result.deferred.length, 3, 'no promise was claimed');
});

test('a promise inside its window waits; past it, it escalates', () => {
  const waiting = allocateWith([promise('pay-1', 1_000_000n)], []);
  assert.equal(only(waiting.deferred).reason, 'PENDING_T_PLUS_N');
  assert.equal(waiting.exceptions.length, 0);

  const late = allocate({
    transactions: [promise('pay-1', 1_000_000n)],
    allocated: new Map(),
    payouts: [],
    lines: [],
    policyFor: policy,
    asOf: new Date('2026-08-20T12:00:00Z'),
  });
  assert.equal(only(late.exceptions).reason, 'MISSING_SETTLEMENT');
});

// ── Stage three: the bank statement meets the report ────────────────────────

const inflowOf = (
  transactions: readonly LedgerTransaction[],
  payouts: readonly Payout[],
  policyFor: PolicyLookup = policy,
) => allocateWith(transactions, payouts, [], policyFor).prepared.map((p) => p.inflow);

/**
 * The claim the three-way design exists to make: a PSP payout is confirmed by an
 * *independent* bank credit, and only then does anything book.
 */
test('a bank credit naming the payout confirms it', () => {
  const inflows = inflowOf(
    [promise('pay-1', 1_000_000n)],
    [payout('PO-2026-0008', 1_000_000n, [deduction('fee', 15_000n)])],
  );

  const result = confirm({
    inflows,
    bankLines: [credit('bank-1', 985_000n, { narration: 'TRF FROM ALPHA REF PO-2026-0008' })],
    policyFor: policy,
    asOf: ASOF,
  });

  assert.equal(result.confirmed.length, 1);
  assert.equal(result.confirmed[0]!.result.reason, 'BANK_CONFIRMED');
  assert.equal(result.confirmed[0]!.result.confidence, 1);
  assert.deepEqual(result.confirmed[0]!.result.bankCreditKeys, ['bank-1']);
});

test('a credit matching exactly one expected amount confirms it, at lower confidence', () => {
  const inflows = inflowOf(
    [promise('pay-1', 1_000_000n)],
    [payout('PO-9', 1_000_000n, [deduction('fee', 15_000n)])],
  );

  const result = confirm({
    inflows,
    bankLines: [credit('bank-1', 985_000n)],
    policyFor: policy,
    asOf: ASOF,
  });

  assert.equal(result.confirmed[0]!.result.reason, 'BANK_CONFIRMED');
  assert.equal(result.confirmed[0]!.result.confidence, 0.85, 'inferred, not stated');
});

/**
 * A reported payout the bank has not seen is the most common real state in Nigerian
 * settlement, and it is neither matched nor missing. Before this design it had nowhere to
 * sit.
 */
test('a reported payout with no bank credit is awaiting, not settled', () => {
  const inflows = inflowOf(
    [promise('pay-1', 1_000_000n)],
    [payout('PO-10', 1_000_000n, [deduction('fee', 15_000n)])],
  );

  const result = confirm({ inflows, bankLines: [], policyFor: policy, asOf: ASOF });

  assert.equal(result.confirmed.length, 0);
  assert.equal(only(result.deferred).reason, 'AWAITING_BANK_CREDIT');
  assert.equal(reasonKind('AWAITING_BANK_CREDIT'), 'explanation');
});

test('a payout the bank never confirms escalates once it is overdue', () => {
  const inflows = inflowOf(
    [promise('pay-1', 1_000_000n)],
    [payout('PO-11', 1_000_000n, [deduction('fee', 15_000n)])],
  );

  const result = confirm({
    inflows,
    bankLines: [],
    policyFor: policy,
    asOf: new Date('2026-08-20T12:00:00Z'),
  });

  assert.equal(only(result.exceptions).reason, 'MISSING_SETTLEMENT');
});

/**
 * Correspondent banks take small charges nobody announces. Within an allowance somebody
 * chose deliberately, that is a bank charge with its own account; beyond it, it is a
 * discrepancy, and the difference between the two is the whole point of the allowance
 * being a number rather than a shrug.
 */
test('a credit short by a bank charge books the charge', () => {
  const inflows = inflowOf(
    [promise('pay-1', 1_000_000n)],
    [payout('PO-12', 1_000_000n, [deduction('fee', 15_000n)])],
  );

  const result = confirm({
    inflows,
    bankLines: [credit('bank-1', 979_750n)], // ₦52.50 short
    policyFor: policy,
    asOf: ASOF,
  });

  const confirmed = result.confirmed[0]!;
  assert.equal(confirmed.result.reason, 'BANK_CHARGE');
  assert.deepEqual(
    confirmed.deductions.map((d) => [d.accountId, d.amount.kobo]),
    [
      ['fees_expense', 15_000n],
      ['bank_charges', 5_250n],
    ],
  );
});

test('a credit short by more than a bank charge is a discrepancy, not a charge', () => {
  const inflows = inflowOf(
    [promise('pay-1', 1_000_000n)],
    [payout('PO-13', 1_000_000n, [deduction('fee', 15_000n)])],
  );

  const result = confirm({
    inflows,
    bankLines: [credit('bank-1', 500_000n)],
    policyFor: policy,
    asOf: ASOF,
  });

  assert.equal(result.confirmed.length, 0);
  assert.ok(result.exceptions.some((f) => f.reason === 'UNIDENTIFIED_CREDIT'));
});

/**
 * Two credits, one payout. The second is money we may have to send back, and it must not
 * quietly confirm anything — the partial unique index in the schema says the same thing a
 * second time, in the database.
 *
 * It is reported as `DUPLICATE_BANK_CREDIT` rather than `UNIDENTIFIED_CREDIT`. Both are
 * refusals to book, so no money moves either way; the difference is entirely in what the
 * human is told. "We appear to have been paid this twice, here is the first credit" is a
 * morning's work; "money we cannot identify" files the most consequential bank event in the
 * system beside a stray ₦42 credit.
 */
test('a duplicated bank credit cannot confirm the same payout twice', () => {
  const inflows = inflowOf(
    [promise('pay-1', 1_000_000n)],
    [payout('PO-2026-0014', 1_000_000n, [deduction('fee', 15_000n)])],
  );

  const result = confirm({
    inflows,
    bankLines: [
      credit('bank-1', 985_000n, { narration: 'TRF REF PO-2026-0014' }),
      credit('bank-2', 985_000n, { narration: 'TRF REF PO-2026-0014' }),
    ],
    policyFor: policy,
    asOf: ASOF,
  });

  assert.equal(result.confirmed.length, 1);
  assert.deepEqual(
    result.exceptions.map((f) => [f.reason, f.bankCreditKeys[0]]),
    [['DUPLICATE_BANK_CREDIT', 'bank-2']],
  );
  // And it points at the credit it duplicates, so the reader does not have to go looking.
  assert.deepEqual(result.exceptions[0]!.considered, [
    {
      candidateId: 'bank-1',
      kind: 'bank_credit',
      difference: money(0n),
      rejectedBecause: 'already_claimed',
    },
  ]);
});

/**
 * Two payouts of the same amount on the same day is ordinary. Picking the first would
 * settle the wrong one and leave the right one to escalate later as an inexplicable
 * absence.
 */
test('a credit that fits two payouts equally well confirms neither', () => {
  const inflows = inflowOf(
    [promise('pay-1', 1_000_000n), promise('pay-2', 1_000_000n)],
    [payout('PO-15', 1_000_000n, [deduction('fee', 15_000n)]), payout('PO-16', 1_000_000n, [deduction('fee', 15_000n)])],
  );

  const result = confirm({
    inflows,
    bankLines: [credit('bank-1', 985_000n)],
    policyFor: policy,
    asOf: ASOF,
  });

  assert.equal(result.confirmed.length, 0);
  assert.equal(only(result.exceptions).reason, 'UNIDENTIFIED_CREDIT');
});

test('money the bank cannot attach to anything reaches a human immediately', () => {
  const result = confirm({
    inflows: [],
    bankLines: [credit('bank-1', 4_242n, { narration: 'MISC' })],
    policyFor: policy,
    asOf: ASOF,
  });

  assert.equal(only(result.exceptions).reason, 'UNIDENTIFIED_CREDIT');
  assert.equal(reasonKind('UNIDENTIFIED_CREDIT'), 'exception');
});

/** Money cannot be credited before the PSP says it sent it. */
test('a credit dated before the payout is not treated as its confirmation', () => {
  const inflows = inflowOf(
    [promise('pay-1', 1_000_000n)],
    [payout('PO-17', 1_000_000n, [deduction('fee', 15_000n)])],
  );

  const result = confirm({
    inflows,
    bankLines: [credit('bank-1', 985_000n, { valueDate: new Date('2026-08-01T09:00:00Z') })],
    policyFor: policy,
    asOf: ASOF,
  });

  assert.equal(result.confirmed.length, 0);
});

/** A debit is not a settlement. Filtering it here keeps stage three about incoming money. */
test('debits never confirm anything', () => {
  const inflows = inflowOf(
    [promise('pay-1', 1_000_000n)],
    [payout('PO-18', 1_000_000n, [deduction('fee', 15_000n)])],
  );

  const result = confirm({
    inflows,
    bankLines: [credit('bank-1', 985_000n, { direction: 'debit' })],
    policyFor: policy,
    asOf: ASOF,
  });

  assert.equal(result.confirmed.length, 0);
  assert.equal(only(result.deferred).reason, 'AWAITING_BANK_CREDIT');
});

// ── The laws ────────────────────────────────────────────────────────────────

/**
 * Determinism. The partition is a function of the inputs, not of the order they arrived in.
 * Shuffle both sides and nothing may change — otherwise a replay proves nothing.
 */
test('the same inputs produce the same partition, whatever the input order', () => {
  const transactions = [
    promise('pay-1', 300_000n),
    promise('pay-2', 700_000n),
    promise('pay-3', 250_000n),
  ];
  const payouts = [
    payout('PO-A', 1_000_000n, [deduction('fee', 15_000n)]),
    payout('PO-B', 250_000n, [deduction('fee', 3_750n)]),
  ];

  const forward = allocateWith(transactions, payouts);
  const backward = allocateWith([...transactions].reverse(), [...payouts].reverse());

  assert.deepEqual(backward, forward);
  assert.equal(forward.prepared.length, 2);
});

/**
 * The canonical boundary, as a test. The matcher is handed a calendar, a fee model and an
 * allowance, and is
 * never told which source produced anything. Rename every source and the partition is
 * identical — because there is no source name in there to branch on.
 */
test('renaming the source changes nothing', () => {
  const build = (source: string) => {
    const transaction = { ...promise('pay-1', 1_000_000n), source };
    const movement = { ...payout('PO-C', 1_000_000n, [deduction('fee', 15_000n)]), source };
    const result = allocateWith([transaction], [movement]);
    // The conclusions, not the records. An inflow legitimately remembers which source it
    // came from — that is what a later policy lookup needs. What must not vary is what the
    // matcher *decided*.
    return {
      conclusions: result.prepared.map((prepared) => prepared.result),
      allocations: result.prepared.map((prepared) => prepared.allocations),
      deferred: result.deferred,
      exceptions: result.exceptions,
    };
  };

  assert.deepEqual(build('omega'), build('alpha'));
});

/**
 * An unprofiled source is not silently trusted with an invented calendar. Its items
 * escalate on the first run — nobody ever declared how long to wait, and waiting forever
 * is not a decision we get to make on their behalf.
 */
test('a source with no profile escalates rather than waiting forever', () => {
  const result = allocate({
    transactions: [promise('pay-1', 1_000_000n)],
    allocated: new Map(),
    payouts: [],
    lines: [],
    policyFor: () => null,
    asOf: ASOF,
  });

  assert.equal(result.deferred.length, 0);
  assert.equal(only(result.exceptions).reason, 'MISSING_SETTLEMENT');
});

// ── Apportionment ───────────────────────────────────────────────────────────

/**
 * The question gross allocation cannot answer: what did *this* payment cost?
 *
 * The PSP charged the batch, not the payments, so any per-payment number is a rule we
 * chose — pro rata by gross, largest remainder, ties by transaction id. The rule is stated
 * in `apportion.ts`; this is the rule doing its job.
 */
test('a batch fee is split across the payments it was charged on', () => {
  const result = allocateWith(
    [promise('pay-1', 300_000n), promise('pay-2', 700_000n)],
    [payout('PO-E', 1_000_000n, [deduction('fee', 15_000n), deduction('tax', 1_125n)])],
  );

  const allocations = result.prepared[0]!.allocations;
  assert.deepEqual(
    allocations.map((a) => [a.transactionId, a.amount.kobo, a.net.kobo]),
    [
      // ₦150 fee splits ₦45 / ₦105. The ₦11.25 tax splits 337.5 / 787.5 kobo, and the
      // spare kobo goes to `pay-1` — equal remainders, tie broken by transaction id.
      ['pay-1', 300_000n, 295_162n], // 300,000 − 4,500 − 338
      ['pay-2', 700_000n, 688_713n], // 700,000 − 10,500 − 787
    ],
  );

  // Each deduction adds back to its own total exactly — no kobo invented, none lost.
  const shareOf = (accountId: string) =>
    allocations
      .flatMap((a) => a.deductions)
      .filter((d) => d.accountId === accountId)
      .reduce((total, d) => total + d.amount.kobo, 0n);

  assert.equal(shareOf('fees_expense'), 15_000n);
  assert.equal(shareOf('taxes_withheld'), 1_125n);
});

/**
 * The kobo that will not divide has to go somewhere, and "wherever the map iterated first"
 * is not a decision anybody can reproduce. Largest remainder decides, and the transaction id
 * breaks the tie, so the same inputs always hand the same kobo to the same payment.
 */
test('an indivisible kobo is given away by a rule, not by iteration order', () => {
  const forward = allocateWith(
    [promise('pay-a', 100_000n), promise('pay-b', 100_000n), promise('pay-c', 100_000n)],
    [payout('PO-F', 300_000n, [deduction('fee', 100n)])], // ₦1 across three equal payments
  );
  const backward = allocateWith(
    [promise('pay-c', 100_000n), promise('pay-b', 100_000n), promise('pay-a', 100_000n)],
    [payout('PO-F', 300_000n, [deduction('fee', 100n)])],
  );

  const shares = (result: ReturnType<typeof allocateWith>) =>
    result.prepared[0]!.allocations.map((a) => [a.transactionId, a.net.kobo]);

  assert.deepEqual(shares(forward), [
    ['pay-a', 99_966n], // 34 kobo — the spare one, by id
    ['pay-b', 99_967n],
    ['pay-c', 99_967n],
  ]);
  assert.deepEqual(shares(backward), shares(forward), 'input order changes nothing');
});

// ── The contract that explained it ──────────────────────────────────────────

/**
 * Rates are renegotiated and rate cards are corrected. Recomputing a March decision against
 * today's table can reach a different answer than the one we acted on — which is exactly
 * what effective-dated contracts exist to prevent — so the contract that priced each
 * promise is recorded with the conclusion rather than re-derived from it.
 */
test('a conclusion names the fee contract that explained each promise', () => {
  const result = allocateWith(
    [promise('pay-1', 1_000_000n)],
    [payout('PO-G', 1_000_000n, [deduction('fee', 15_000n)])],
  );

  assert.deepEqual(result.prepared[0]!.result.explainedBy, [
    {
      transactionId: 'pay-1',
      contractId: 'test-contract',
      channel: ANY_CHANNEL,
      expectedFee: money(15_000n),
      expectedVat: money(1_125n),
      // What it actually cost: this promise's share of the batch fee.
      observedFee: money(15_000n),
    },
  ]);
});

/**
 * "We matched this on amounts alone" is a conclusion, and a conclusion left unwritten is
 * indistinguishable later from one nobody reached. So a promise no contract covered is
 * explained explicitly, with a null contract rather than an absent explanation.
 */
test('a promise no contract covers is explained as exactly that', () => {
  const result = allocateWith(
    [promise('pay-1', 1_000_000n)],
    [payout('PO-H', 1_000_000n, [deduction('fee', 15_000n)])],
    [],
    noRateCard,
  );

  assert.deepEqual(result.prepared[0]!.result.explainedBy, [
    {
      transactionId: 'pay-1',
      contractId: null,
      channel: null,
      expectedFee: null,
      expectedVat: null,
      observedFee: money(15_000n),
    },
  ]);
});

test('an inflow with no deductions still balances', () => {
  const result = allocateWith(
    [promise('pay-1', 1_000_000n)],
    [payout('PO-D', 1_000_000n, [])],
    [],
    noRateCard,
  );
  assert.deepEqual(result.prepared[0]!.inflow.deductions, []);
  assert.equal(result.prepared[0]!.inflow.expectedNet.kobo, 1_000_000n);
  assert.equal(ZERO.kobo, 0n);
});

// ── The bounded search says when it did not look ────────────────────────────

/**
 * The distinction ADR-0070 exists for.
 *
 * `PHANTOM_CREDIT` is an assertion: we compared every combination of your promises against
 * this payout and none of them fit — which points at a missing webhook, a duplicated
 * reference, a real data problem. A truncated search that reports it is asserting arithmetic
 * nobody performed, and sends a person hunting for a problem that does not exist.
 */
test('a payout batching more promises than the bound escalates as unlooked-at, not unmatched', () => {
  // Twenty-five promises against a bound of twenty-four. The payout's gross is genuinely the
  // sum of the first three, so the old truncating search would have *found* it — which is
  // exactly why the size of the pool, not the solvability of the target, has to be the test.
  const promises = Array.from({ length: 25 }, (_, index) =>
    promise(`pay-${index}`, BigInt(100_000 + index * 1_000)),
  );

  const result = allocateWith(promises, [payout('PO-BIG', 303_000n, [])], [], noRateCard);

  const escalated = only(result.exceptions);
  assert.equal(escalated.reason, 'BATCH_TOO_LARGE');
  assert.equal(reasonKind(escalated.reason), 'exception');
  assert.deepEqual(escalated.payoutReferences, ['PO-BIG']);
  assert.equal(result.prepared.length, 0, 'nothing may be prepared from a search that never ran');

  // And the working says what it is. Every candidate carries `not_attempted`, never
  // `amount_differs`: the second would be a claim about a comparison that did not happen.
  assert.ok(escalated.considered.length > 0);
  for (const candidate of escalated.considered) {
    assert.equal(candidate.rejectedBecause, 'not_attempted');
  }
});

test('a payout inside the bound still escalates as unmatched when nothing fits', () => {
  const result = allocateWith(
    [promise('pay-1', 100_000n), promise('pay-2', 200_000n)],
    [payout('PO-ODD', 777_777n, [])],
    [],
    noRateCard,
  );

  const escalated = only(result.exceptions);
  assert.equal(escalated.reason, 'PHANTOM_CREDIT', 'we looked, and nothing fitted');
  assert.deepEqual(
    escalated.considered.map((candidate) => candidate.rejectedBecause),
    ['amount_differs', 'amount_differs'],
  );
});

// ── Two identical credits, two identical payouts ────────────────────────────

const pairing: PolicyLookup = () => ({
  calendar: CALENDAR,
  expectedFee: null,
  bankChargeAllowance: 0n,
  reserveReleaseDays: 90,
  pairEqualAmounts: true,
});

/**
 * Two payouts that *net* to the same figure, which is the shape that reaches stage three.
 *
 * Note the grosses differ: two identical grosses would be ambiguous one stage earlier, in the
 * subset search, and would never produce a pair of inflows to argue about. Equal nets from
 * unequal grosses is the ordinary case — a fee, a tax, a rounding — and it is what a bank
 * credit actually sees.
 */
const sameNetInflows = (policyFor: PolicyLookup = pairing) =>
  inflowOf(
    [promise('pay-1', 500_000n), promise('pay-2', 600_000n)],
    [payout('PO-A', 500_000n, []), payout('PO-B', 600_000n, [deduction('fee', 100_000n)])],
    policyFor,
  );

/**
 * The ordinary Tuesday of a fixed-price business, and the shape that used to fill the queue.
 *
 * Two payouts netting the same figure on the same day arrive as two identical credits. Each
 * credit alone is ambiguous; the *set* is not. See ADR-0072 for why this is a finding rather
 * than a guess: every member carries the same amount, so each booking's entries are identical
 * whichever way round the bijection falls.
 */
test('two identical credits and two same-net payouts are paired rather than escalated', () => {
  const inflows = sameNetInflows();
  assert.equal(inflows.length, 2);

  const result = confirm({
    inflows,
    bankLines: [
      credit('bank-2', 500_000n, { valueDate: new Date('2026-08-14T09:00:00Z') }),
      credit('bank-1', 500_000n, { valueDate: new Date('2026-08-13T09:00:00Z') }),
    ],
    policyFor: pairing,
    asOf: ASOF,
  });

  assert.equal(result.confirmed.length, 2);
  assert.equal(result.exceptions.length, 0, 'neither is a mystery');

  // FIFO by value date, so the answer is the one a human would give and is the same answer
  // every time (determinism).
  const byCredit = new Map(result.confirmed.map((c) => [c.credit.idempotencyKey, c.result]));
  const first = byCredit.get('bank-1');
  const second = byCredit.get('bank-2');

  assert.deepEqual(
    result.confirmed.map((c) => [c.credit.idempotencyKey, c.inflow.key]).sort(),
    [
      ['bank-1', 'PO-A'],
      ['bank-2', 'PO-B'],
    ],
  );

  // The first is the set pairing, and it says so: 0.7, below the 0.85 of a unique amount,
  // because which member of the set this row is remains a convention rather than a finding.
  // It is also the only successful match in this engine that keeps its working.
  assert.equal(first?.confidence, 0.7);
  assert.equal(first?.reason, 'BANK_CONFIRMED');
  assert.equal(first?.considered.length, 1);
  assert.equal(first?.considered[0]!.rejectedBecause, 'ambiguous');

  // The second needs no pairing at all: its twin has been claimed, so exactly one inflow now
  // matches its amount and the ordinary uniqueness rule answers it. The set pairing does the
  // least work it can, which is the property that keeps it from reaching past its own case.
  assert.equal(second?.confidence, 0.85);
  assert.deepEqual(second?.considered, []);
});

/**
 * The refusal that keeps the pairing honest. Three credits against two inflows means one of
 * the credits is something else, and pairing any of them is choosing which mystery to ignore.
 */
test('three credits against two same-net payouts escalates all three', () => {
  const inflows = sameNetInflows();

  const result = confirm({
    inflows,
    bankLines: [
      credit('bank-1', 500_000n),
      credit('bank-2', 500_000n),
      credit('bank-3', 500_000n),
    ],
    policyFor: pairing,
    asOf: ASOF,
  });

  assert.equal(result.confirmed.length, 0);
  assert.equal(result.exceptions.length, 3);
  for (const escalated of result.exceptions) {
    assert.equal(escalated.reason, 'UNIDENTIFIED_CREDIT');
  }
});

test('a source that has not enabled set pairing still escalates both', () => {
  const inflows = sameNetInflows(noRateCard);

  const result = confirm({
    inflows,
    bankLines: [credit('bank-1', 500_000n), credit('bank-2', 500_000n)],
    policyFor: noRateCard,
    asOf: ASOF,
  });

  assert.equal(result.confirmed.length, 0);
  assert.equal(result.exceptions.length, 2);
});

/** A named credit is better evidence and must never be pre-empted by the arithmetic. */
test('a credit that names its payout wins over the set pairing', () => {
  const inflows = inflowOf(
    [promise('pay-1', 500_000n), promise('pay-2', 600_000n)],
    [
      payout('PO-ALPHA-1', 500_000n, []),
      payout('PO-ALPHA-2', 600_000n, [deduction('fee', 100_000n)]),
    ],
    pairing,
  );

  const result = confirm({
    inflows,
    // The later credit names the *earlier* payout, so FIFO pairing would get it backwards.
    bankLines: [
      credit('bank-1', 500_000n, { valueDate: new Date('2026-08-13T09:00:00Z') }),
      credit('bank-2', 500_000n, {
        narration: 'TRF REF PO-ALPHA-1',
        valueDate: new Date('2026-08-14T09:00:00Z'),
      }),
    ],
    policyFor: pairing,
    asOf: ASOF,
  });

  const named = result.confirmed.find((c) => c.credit.idempotencyKey === 'bank-2');
  assert.equal(named?.inflow.key, 'PO-ALPHA-1');
  assert.equal(named?.result.confidence, 1, 'the bank told us; nothing beats that');
});

// ── A refund for part of a payment ──────────────────────────────────────────

function settlementLine(
  reference: string,
  gross: bigint,
  status: SettlementLine['status'],
): SettlementLine {
  return {
    reference,
    source: 'alpha',
    payoutReference: null,
    merchantId: 'merchant-under-test',
    channel: 'card',
    gross: money(gross),
    fee: ZERO,
    net: money(gross),
    status,
    settledAt: VALUE_DATE,
    reasonHints: [],
    evidenceId: 'evidence-settlement',
    lineage: NO_LINEAGE,
    idempotencyKey: `settlement:alpha:${reference}`,
  };
}

/**
 * A customer cancels one line of a four-item basket. ADR-0069: booking the whole ₦10,000 back
 * would say the PSP owes us nothing while it still owes us ₦7,000, and the ₦7,000 that does
 * settle later would arrive against a promise the ledger had closed.
 */
test('a refund smaller than the payment takes back only what came back', () => {
  const result = allocateWith(
    [promise('pay-1', 1_000_000n)],
    [],
    [settlementLine('pay-1', 300_000n, 'reversed')],
    noRateCard,
  );

  assert.equal(result.prepared.length, 1);
  const prepared = result.prepared[0]!;
  assert.equal(prepared.result.reason, 'PARTIAL_REVERSAL');
  assert.equal(reasonKind(prepared.result.reason), 'explanation');
  assert.equal(prepared.allocations[0]!.amount.kobo, 300_000n, 'only what came back');
  // The receivable stays whole: it is what the booking compares against to decide whether the
  // promise's story has ended, and shrinking it would make every partial look total.
  assert.equal(prepared.allocations[0]!.receivable.kobo, 1_000_000n);

  // …and the rest is still owed, so it is still waiting rather than missing.
  const waiting = result.deferred.find((r) => r.transactionIds.includes('pay-1'));
  assert.equal(waiting?.reason, 'PARTIAL_SETTLEMENT');
});

test('a refund for the whole payment is still a whole reversal', () => {
  const result = allocateWith(
    [promise('pay-1', 1_000_000n)],
    [],
    [settlementLine('pay-1', 1_000_000n, 'reversed')],
    noRateCard,
  );

  assert.equal(result.prepared[0]!.result.reason, 'REVERSAL');
  assert.equal(result.prepared[0]!.result.confidence, 1);
  assert.equal(result.prepared[0]!.allocations[0]!.amount.kobo, 1_000_000n);
});

/**
 * Two shapes that are not refunds at all, and are refused rather than booked. Both are parse
 * errors wearing a plausible face: a line that reverses nothing, and one that gives back more
 * than was ever charged.
 */
test('a reversal of nothing, or of more than was charged, escalates', () => {
  for (const gross of [0n, 2_000_000n]) {
    const result = allocateWith(
      [promise('pay-1', 1_000_000n)],
      [],
      [settlementLine('pay-1', gross, 'reversed')],
      noRateCard,
    );
    assert.equal(result.prepared.length, 0, `gross ${gross} must not book`);
    assert.equal(
      result.exceptions.some((r) => r.reason === 'AMOUNT_MISMATCH'),
      true,
      `gross ${gross} must escalate`,
    );
  }
});
