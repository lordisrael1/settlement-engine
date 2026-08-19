import type { FeeContract, Money, RateCard, SourceId } from '@recon/canon';
import { feeFor, isOverdue, money } from '@recon/canon';

import { random } from './random.js';
import {
  daysBefore,
  type GroundTruth,
  type Scenario,
  type ScenarioOptions,
  type SimulatedDelivery,
  type SimulatedFile,
} from './scenario.js';
import {
  bankStatementFile,
  flutterwaveCharge,
  flutterwaveSettlementFile,
  nombaPayment,
  nombaTransactionFile,
  signed,
  type SettlementRow,
  type StatementRow,
} from './wire.js';

/**
 * One ordinary, messy Tuesday — generated rather than hand-written.
 *
 * The scenario contains, deliberately and by name: a renegotiated fee contract with payments
 * on both sides of it, a reversal, a chargeback, a correspondent-bank charge nobody
 * announced, a payout that is reported and not yet credited, and exactly one credit that
 * belongs to nobody. Everything except the last must be explained without a human. That is
 * the whole claim of the system, and this is the file that makes it falsifiable.
 *
 * Two properties matter more than realism, and both are deliberate:
 *
 *   **Determinism.** Every draw comes from the seed. A red build hands you one integer that
 *   reproduces the exact bytes on any machine (Law 5). An adversarial suite you cannot
 *   reproduce has not found a bug; it has produced a rumour.
 *
 *   **Ground truth by construction.** What each anomaly *is* is decided here, as it is
 *   planted, and never derived by asking the engine. Truth computed from the thing under
 *   test is the engine agreeing with itself, which it does just as readily when it is wrong.
 */

/**
 * Fixed, because the calendar is not what is being varied.
 *
 * Weekends and cut-offs decide whether money is late, and moving the anchor with the seed
 * would make a red build mean "something is wrong" or "this seed landed on a Sunday" with no
 * way to tell them apart. Amounts, counts and groupings vary; the clock does not.
 */
const DEFAULT_ASOF = new Date('2026-08-18T09:00:00.000Z');

/** Uncapped in practice at these sizes; the cap is carried because real cards have one. */
const CARD_BEFORE: RateCard = {
  percentBasisPoints: 140,
  flatKobo: 0n,
  flatWaivedBelowKobo: null,
  capKobo: 200_000n,
  vatBasisPoints: 750,
};

/** The renegotiation. Volume grew, the rate came down, and March must not be repriced. */
const CARD_AFTER: RateCard = { ...CARD_BEFORE, percentBasisPoints: 110 };

/**
 * Amounts are multiples of ₦100, carrying a distinct power-of-two **kobo** salt.
 *
 * This is the one piece of arithmetic in the simulator that exists for the matcher's
 * benefit rather than for realism, and it is load-bearing. A payout is matched by finding
 * the unique subset of promises summing to its gross — and the matcher refuses to guess when
 * two subsets fit equally well, correctly and by design. Amounts drawn naively collide:
 * ₦5,000 + ₦15,000 and ₦8,000 + ₦12,000 are the same payout, so a seed that happens to draw
 * both would escalate a payout that is going perfectly well, and the suite would be flaky for
 * a reason that is not a defect.
 *
 * So each promise carries `2^i` kobo on top of a whole-hundred-naira base. A subset's total
 * modulo ₦100 is then the sum of its salts, which identifies the subset uniquely — for up to
 * thirteen promises, since `2^13 - 1 = 8191` kobo still fits under ₦100. The amounts stay
 * entirely ordinary-looking (₦12,500.04), because odd kobo is what real Nigerian payment
 * amounts look like.
 *
 * Deliberately ambiguous batches are a *separate* scenario with its own assertion — the
 * matcher escalating there is the correct behaviour, and it deserves to be tested on purpose
 * rather than stumbled into by a seed.
 */
const MAX_SALTED_PROMISES = 13;

/** ₦5,000 to ₦50,000, in ₦100 steps. The floor keeps the phantom's band clear. */
const BASE_MIN_HUNDREDS = 50;
const BASE_MAX_HUNDREDS = 500;

/**
 * The phantom lives below every payout that could exist, by more than any bank charge.
 *
 * A credit is matched to an inflow when it is short of it by no more than the source's bank
 * charge allowance (₦100). With every batch holding at least two promises of at least
 * ₦5,000, no payout can net less than about ₦9,800 — so a phantom drawn from ₦1,000–₦4,000
 * cannot be confused with one by arithmetic, whatever the seed does. Reserved by construction
 * rather than checked afterwards and nudged, because a retry loop is a place for an
 * off-by-one to hide.
 */
const PHANTOM_MIN_HUNDREDS = 10;
const PHANTOM_MAX_HUNDREDS = 40;

const FLUTTERWAVE = 'flutterwave';
const NOMBA = 'nomba';

/**
 * A settlement window: payments on one day, the payout that carries them, and — usually —
 * the bank credit that proves it.
 */
interface Batch {
  readonly id: string;
  /** Days before `asOf` the payments occurred. */
  readonly paidDaysAgo: number;
  /** Days before `asOf` the PSP says the payout moves. */
  readonly payoutDaysAgo: number;
  /** Days before `asOf` the bank credited it, or `null` for the straggler. */
  readonly creditedDaysAgo: number | null;
  /** Which side of the renegotiation these payments fall on. */
  readonly repriced: boolean;
  readonly withChargeback: boolean;
  /** A correspondent-bank charge nobody announced. Explained, never escalated. */
  readonly bankChargeKobo: bigint;
}

const BATCHES: readonly Batch[] = [
  // Before the renegotiation, long settled. If today's rate were applied to it, every
  // payment in here would develop a fee variance that never happened.
  {
    id: 'A',
    paidDaysAgo: 40,
    payoutDaysAgo: 38,
    creditedDaysAgo: 37,
    repriced: false,
    withChargeback: false,
    bankChargeKobo: 0n,
  },
  // After it, and carrying the two things that make a settlement file interesting: a
  // clawback folded in beside the fees, and a credit that arrives short.
  {
    id: 'B',
    paidDaysAgo: 6,
    payoutDaysAgo: 4,
    creditedDaysAgo: 3,
    repriced: true,
    withChargeback: true,
    bankChargeKobo: 5_250n,
  },
  // Reported and not yet credited — and not yet late. The most common real state in
  // Nigerian settlement, and the one a queue must not contain.
  {
    id: 'C',
    paidDaysAgo: 2,
    payoutDaysAgo: 1,
    creditedDaysAgo: null,
    repriced: true,
    withChargeback: false,
    bankChargeKobo: 0n,
  },
];

export function generate(options: ScenarioOptions): Scenario {
  const asOf = options.asOf ?? DEFAULT_ASOF;
  const merchantId = options.merchantId ?? 'simulated-merchant';
  const bankAccountId = options.bankAccountId ?? 'gtb-3011';
  const bank = options.bank ?? 'gtbank';
  const seed = options.seed;
  const r = random(seed);

  /** The instant the rate changed. Half-open on both contracts, so nothing falls in a gap. */
  const renegotiatedAt = daysBefore(asOf, 30);

  const before: FeeContract = {
    contractId: `sim-${seed}-card-before`,
    source: FLUTTERWAVE,
    merchantId,
    channel: 'card',
    currency: 'NGN',
    effectiveFrom: new Date(0),
    effectiveTo: renegotiatedAt,
    rateCard: CARD_BEFORE,
    approvedBy: 'cfo@example.com',
    approvedAt: new Date(0),
  };
  const after: FeeContract = {
    ...before,
    contractId: `sim-${seed}-card-after`,
    effectiveFrom: renegotiatedAt,
    effectiveTo: null,
    rateCard: CARD_AFTER,
    approvedAt: renegotiatedAt,
  };

  const deliveries: SimulatedDelivery[] = [];
  const pricedBy: { reference: string; contractId: string }[] = [];
  const confirmedPayouts: string[] = [];
  const stragglerPayouts: string[] = [];

  const oldRows: SettlementRow[] = [];
  const recentRows: SettlementRow[] = [];
  const oldCredits: StatementRow[] = [];
  const recentCredits: StatementRow[] = [];

  let promisedKobo = 0n;
  let bankedKobo = 0n;
  let bankChargesKobo = 0n;
  let feesKobo = 0n;
  let taxesKobo = 0n;
  let chargebacksKobo = 0n;
  let dischargedKobo = 0n;

  let saltIndex = 0;

  for (const batch of BATCHES) {
    const contract = batch.repriced ? after : before;
    const paidOn = daysBefore(asOf, batch.paidDaysAgo);
    const valueDate = daysBefore(asOf, batch.payoutDaysAgo);

    const count = r.int(2, 3);
    let grossKobo = 0n;
    let feeKobo = 0n;
    let vatKobo = 0n;

    for (let index = 0; index < count; index += 1) {
      if (saltIndex >= MAX_SALTED_PROMISES) {
        throw new Error(
          `Scenario ${seed} wants more than ${MAX_SALTED_PROMISES} salted promises. Beyond ` +
            `that the kobo salt no longer fits under ₦100 and two different subsets of ` +
            `promises can sum to one payout — which the matcher would escalate, correctly, ` +
            `and this suite would read as a defect.`,
        );
      }

      const base = BigInt(r.int(BASE_MIN_HUNDREDS, BASE_MAX_HUNDREDS)) * 10_000n;
      const gross = base + (1n << BigInt(saltIndex));
      saltIndex += 1;

      // Before the 5pm Lagos cut-off, so a payment's effective settlement day is its own
      // day and the deadline arithmetic below does not depend on the hour drawn.
      const occurredAt = new Date(paidOn.getTime() + r.int(6, 14) * 60 * 60_000);
      const chargeId = `chg-sim${seed}-${batch.id}${index}`;

      const priced = feeFor(contract.rateCard, money(gross), contract);
      grossKobo += gross;
      feeKobo += priced.fee.kobo;
      vatKobo += priced.vat.kobo;
      promisedKobo += gross;

      deliveries.push(
        signed(
          FLUTTERWAVE,
          flutterwaveCharge({
            chargeId,
            reference: `ORD-${seed}-${batch.id}${index}`,
            grossKobo: gross,
            occurredAt,
            channel: 'card',
          }),
          secretFor(options, FLUTTERWAVE),
          chargeId,
        ),
      );

      pricedBy.push({
        reference: `payment:${FLUTTERWAVE}:charge:${chargeId}`,
        contractId: contract.contractId,
      });

      // The payout has to be able to reach this promise: dated after it, and inside its own
      // settlement window. Asserted rather than assumed, because a scenario whose premise is
      // wrong produces a failing test that blames the matcher.
      assertReachable(options, FLUTTERWAVE, occurredAt, valueDate, seed, batch.id);
    }

    const chargebackKobo = batch.withChargeback ? BigInt(r.int(5, 50)) * 10_000n : 0n;
    const payoutReference = `FLW-SETL-${seed}-${batch.id}`;
    const expectedNet = grossKobo - feeKobo - vatKobo - chargebackKobo;

    const row: SettlementRow = {
      payoutReference,
      grossKobo,
      feeKobo,
      vatKobo,
      chargebackKobo,
      reportedAt: valueDate,
      valueDate,
      chargeCount: count,
    };
    if (batch.creditedDaysAgo === null) recentRows.push(row);
    else if (batch.paidDaysAgo > 30) oldRows.push(row);
    else recentRows.push(row);

    if (batch.creditedDaysAgo === null) {
      // The straggler. Its promises are allocated, so they are not missing; the *inflow* is
      // simply unconfirmed, and must still be inside its window at `asOf`.
      assertPending(options, FLUTTERWAVE, valueDate, asOf, seed, payoutReference);
      stragglerPayouts.push(payoutReference);
      dischargedKobo += 0n;
      continue;
    }

    const creditedOn = daysBefore(asOf, batch.creditedDaysAgo);
    const credited = expectedNet - batch.bankChargeKobo;
    const statementRow: StatementRow = {
      id: `GTB-sim${seed}-${batch.id}`,
      amountKobo: credited,
      direction: 'credit',
      valueDate: creditedOn,
      // Truncated and shouty, the way a Nigerian bank narration is. The matcher resolves
      // the token against payouts it actually holds; the parser only says what it saw.
      narration: `TRF/FLW/SETTLEMENT/${payoutReference}`,
    };
    if (batch.paidDaysAgo > 30) oldCredits.push(statementRow);
    else recentCredits.push(statementRow);

    confirmedPayouts.push(payoutReference);
    bankedKobo += credited;
    bankChargesKobo += batch.bankChargeKobo;
    feesKobo += feeKobo;
    taxesKobo += vatKobo;
    chargebacksKobo += chargebackKobo;
    dischargedKobo += grossKobo;
  }

  // ── The reversal, on the rail that reports transactions rather than movements ──
  //
  // Nomba never names the payout carrying a transaction, so a reversal has to be recognised
  // from the row's own status. It books immediately and waits for no bank credit: no money
  // is coming, so there is nothing for a statement to confirm.
  const reversedId = `NMB-sim${seed}-R`;
  const reversedGross = BigInt(r.int(BASE_MIN_HUNDREDS, BASE_MAX_HUNDREDS)) * 10_000n + 7n;
  const reversedFee = 2_500n;
  const reversedAt = new Date(daysBefore(asOf, 3).getTime() + 10 * 60 * 60_000);

  deliveries.push(
    signed(
      NOMBA,
      nombaPayment({
        transactionId: reversedId,
        grossKobo: reversedGross,
        feeKobo: reversedFee,
        occurredAt: reversedAt,
      }),
      secretFor(options, NOMBA),
      reversedId,
    ),
  );
  promisedKobo += reversedGross;

  // ── The one thing a human ever sees ───────────────────────────────────────
  const phantomKobo =
    BigInt(r.int(PHANTOM_MIN_HUNDREDS, PHANTOM_MAX_HUNDREDS)) * 10_000n + BigInt(r.int(1, 99));
  const phantomId = `GTB-sim${seed}-PHANTOM`;
  recentCredits.push({
    id: phantomId,
    amountKobo: phantomKobo,
    direction: 'credit',
    valueDate: daysBefore(asOf, 1),
    // Names no payout, and the tokens in it resolve to nothing we hold. Real money, real
    // narration, and no idea whose it is.
    narration: 'NIP TRF FROM ADEBAYO VENTURES LIMITED OWO',
  });

  const settlements: SimulatedFile[] = [
    {
      source: FLUTTERWAVE,
      filename: `flutterwave-settlements-${seed}-earlier.json`,
      bytes: flutterwaveSettlementFile(oldRows),
    },
    {
      source: FLUTTERWAVE,
      filename: `flutterwave-settlements-${seed}-recent.json`,
      bytes: flutterwaveSettlementFile(recentRows),
    },
    {
      source: NOMBA,
      filename: `nomba-transactions-${seed}.json`,
      bytes: nombaTransactionFile([
        {
          transactionId: reversedId,
          netKobo: reversedGross - reversedFee,
          feeKobo: reversedFee,
          occurredAt: reversedAt,
          status: 'REVERSED',
        },
      ]),
    },
  ];

  const statements: SimulatedFile[] = [
    {
      source: bank,
      filename: `bank-statement-${seed}-earlier.json`,
      bytes: bankStatementFile(oldCredits),
    },
    {
      source: bank,
      filename: `bank-statement-${seed}-recent.json`,
      bytes: bankStatementFile(recentCredits),
    },
  ];

  const truth: GroundTruth = {
    phantomCreditKeys: [`bank:${bank}:${phantomId}`],
    confirmedPayouts,
    stragglerPayouts,
    reversedPayments: [`payment:${NOMBA}:transaction:${reversedId}`],
    pricedBy,
    balances: {
      // What was promised, less what the bank has now settled, less the one promise that
      // was undone before any money came.
      psp_receivable: promisedKobo - dischargedKobo - reversedGross,
      merchant_revenue: -promisedKobo,
      reversals: reversedGross,
      bank_account: bankedKobo,
      bank_charges: bankChargesKobo,
      fees_expense: feesKobo,
      taxes_withheld: taxesKobo,
      chargebacks: chargebacksKobo,
      psp_reserve: 0n,
      penalties: 0n,
      // The phantom credit is *not* booked to suspense. Nothing books it at all: it is a
      // statement line we cannot explain, and parking it in a holding account would be this
      // system asserting the money is ours.
      suspense: 0n,
    },
  };

  return { seed, merchantId, asOf, feeContracts: [before, after], deliveries, settlements, statements, truth };
}

/** Every arrival, as a flat list, for a harness that wants to permute them. */
export function arrivals(scenario: Scenario): readonly Arrival[] {
  return [
    { kind: 'webhooks', label: 'webhook deliveries', deliveries: scenario.deliveries },
    ...scenario.settlements.map(
      (file): Arrival => ({ kind: 'settlement', label: file.filename, file }),
    ),
    ...scenario.statements.map(
      (file): Arrival => ({ kind: 'statement', label: file.filename, file }),
    ),
  ];
}

export type Arrival =
  | { readonly kind: 'webhooks'; readonly label: string; readonly deliveries: readonly SimulatedDelivery[] }
  | { readonly kind: 'settlement'; readonly label: string; readonly file: SimulatedFile }
  | { readonly kind: 'statement'; readonly label: string; readonly file: SimulatedFile };

function secretFor(options: ScenarioOptions, source: SourceId): string {
  const secret = options.secrets[source];
  if (secret === undefined) {
    throw new Error(
      `No secret supplied for "${source}". A source with no secret cannot be signed, and ` +
        `a delivery that cannot be signed tests the 401 path and nothing else.`,
    );
  }
  return secret;
}

/**
 * A payout can only carry a promise it is dated after and still inside the window of.
 *
 * Checked here, when the scenario is built, so that a mistake in the *premise* fails loudly
 * with the seed attached — rather than surfacing three files later as a `PHANTOM_CREDIT` that
 * looks exactly like a defect in the matcher.
 */
function assertReachable(
  options: ScenarioOptions,
  source: SourceId,
  occurredAt: Date,
  valueDate: Date,
  seed: number,
  batch: string,
): void {
  const calendar = options.calendarFor(source);
  if (occurredAt.getTime() > valueDate.getTime()) {
    throw new Error(`Scenario ${seed} batch ${batch}: a payout dated before its own payment.`);
  }
  if (isOverdue(calendar, occurredAt, valueDate)) {
    throw new Error(
      `Scenario ${seed} batch ${batch}: the payout is dated past its payments' settlement ` +
        `window, so the matcher will not reach them. Move the batch closer together.`,
    );
  }
}

/** The straggler must be genuinely pending at `asOf` — late is a different scenario. */
function assertPending(
  options: ScenarioOptions,
  source: SourceId,
  valueDate: Date,
  asOf: Date,
  seed: number,
  payoutReference: string,
): void {
  if (isOverdue(options.calendarFor(source), valueDate, asOf)) {
    throw new Error(
      `Scenario ${seed}: payout ${payoutReference} was meant to be pending at asOf and is ` +
        `overdue. It would escalate as MISSING_SETTLEMENT and stop being a straggler.`,
    );
  }
}

export type { Money };
