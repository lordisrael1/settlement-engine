import type {
  BusinessCalendar,
  FeeContract,
  MerchantId,
  Money,
  SourceId,
} from '@recon/canon';
import type { AccountId } from '@recon/canon';

/**
 * What a simulated day looks like from outside the system.
 *
 * A scenario is **files and deliveries**, not canonical records. That distinction is the
 * whole value: a simulator that handed the matcher a `Payout` object would exercise the
 * matcher and skip the boundary, and the boundary is where a real settlement export goes
 * wrong — a fee type nobody has seen, a net that disagrees with its own itemisation, a
 * currency we do not keep books in. So the simulator impersonates the provider all the way
 * down to the bytes, and every record downstream is one the real ingest layer produced.
 *
 * Everything here is a pure function of the seed. No clock, no `randomUUID`, no filesystem
 * (Law 5) — a scenario is data, and the same seed is the same bytes forever.
 */

/** One inbound webhook delivery, signed the way its provider signs. */
export interface SimulatedDelivery {
  readonly source: SourceId;
  /** Signature headers included. Ready to hand to `ingestWebhook` or POST at the service. */
  readonly headers: Readonly<Record<string, string>>;
  /** The bytes, which are what the signature is over. Never re-serialise these. */
  readonly body: Buffer;
  /** The provider's own reference, for narration in a report. */
  readonly reference: string;
}

/** One uploaded file: a PSP settlement export, or a bank statement. */
export interface SimulatedFile {
  /** The PSP, or the bank — evidence is uniform about who sent it. */
  readonly source: SourceId;
  readonly filename: string;
  readonly bytes: Buffer;
}

/**
 * What each planted anomaly is, named at the moment it is planted.
 *
 * Declared by construction, never derived by running the engine. Ground truth computed from
 * the thing under test is not ground truth — it is the engine agreeing with itself, which it
 * will do just as cheerfully when it is wrong.
 */
export interface GroundTruth {
  /**
   * The one credit nobody can explain: cash in our account, attached to no payout.
   *
   * The exit criterion of Phase 8 is that this — and nothing else — reaches a human.
   */
  readonly phantomCreditKeys: readonly string[];
  /** Payouts a bank credit confirms. These book cash, fees, taxes and any clawback. */
  readonly confirmedPayouts: readonly string[];
  /**
   * Reported, not yet credited, and **not yet late**: inside its settlement window.
   *
   * The single most common real state in Nigerian settlement, and the one a queue must not
   * contain. A calendar is the only thing separating this from a missing settlement, and
   * getting it wrong is how an exception queue becomes something nobody opens.
   */
  readonly stragglerPayouts: readonly string[];
  /** Promises undone before any money came. These book against `reversals`. */
  readonly reversedPayments: readonly string[];
  /** Which contract must have priced each payment — the fee-change assertion. */
  readonly pricedBy: readonly { readonly reference: string; readonly contractId: string }[];
  /**
   * Where the books must land, to the kobo, once every file has been ingested and
   * reconciled.
   *
   * A far stronger claim than "no exceptions were raised". A queue can be empty because
   * everything matched, or because everything was quietly mis-booked into one account that
   * happens to balance — and only this tells the two apart.
   */
  readonly balances: Readonly<Partial<Record<AccountId, bigint>>>;
}

export interface Scenario {
  /** The one number needed to reproduce this exactly. Printed by every failure. */
  readonly seed: number;
  readonly merchantId: MerchantId;
  /** The instant reconciliation is taken at. Every date below is placed relative to it. */
  readonly asOf: Date;
  /**
   * The dated contracts this scenario's fees were computed from, including the
   * renegotiation partway through. The harness saves these instead of the published rate
   * cards, because the point is that history is priced at its own rates.
   */
  readonly feeContracts: readonly FeeContract[];
  readonly deliveries: readonly SimulatedDelivery[];
  readonly settlements: readonly SimulatedFile[];
  readonly statements: readonly SimulatedFile[];
  readonly truth: GroundTruth;
}

/**
 * The knobs. Everything absent has a default, because a scenario that needs eleven
 * arguments to describe one ordinary Tuesday is a scenario nobody will write a second test
 * with.
 */
export interface ScenarioOptions {
  readonly seed: number;
  readonly merchantId?: MerchantId;
  readonly asOf?: Date;
  /**
   * The settlement calendar per source, supplied rather than looked up.
   *
   * The simulator has to know when money is genuinely late to plant a straggler that is
   * pending rather than overdue, and it must use *the system's own* answer to that question
   * — not a second implementation that can drift from it. Handed in for the same reason the
   * matcher is handed a calendar: nothing here branches on a source's name to find one.
   */
  readonly calendarFor: (source: SourceId) => BusinessCalendar;
  /** The provider secrets to sign with. The harness must verify against the same ones. */
  readonly secrets: Readonly<Record<SourceId, string>>;
  /** Which of our accounts the statements are about. */
  readonly bankAccountId?: string;
  readonly bank?: SourceId;
}

/** Integer kobo as the decimal naira string every one of these file formats carries. */
export function naira(kobo: bigint): string {
  const negative = kobo < 0n;
  const magnitude = negative ? -kobo : kobo;
  const whole = magnitude / 100n;
  const fraction = magnitude % 100n;
  return `${negative ? '-' : ''}${whole}.${fraction.toString().padStart(2, '0')}`;
}

/** Whole days, as milliseconds, for placing a scenario around its `asOf`. */
export function daysBefore(asOf: Date, days: number): Date {
  return new Date(asOf.getTime() - days * 24 * 60 * 60_000);
}

export type { Money };
