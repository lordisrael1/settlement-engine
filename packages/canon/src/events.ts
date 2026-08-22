/**
 * The event log — everything that happened, in the order it happened, never edited.
 *
 * The ledger and reconciliation tables record the *current* answers: what the balances are,
 * which payouts are confirmed, which exceptions are open. Each of them is append-only, so
 * each holds its own history. What none of them holds is the history of the whole system as
 * one ordered narrative — and that is the thing an auditor asks for. "Show me everything
 * that happened to this money, in order" currently means joining six tables and hoping.
 *
 * The log is written beside the ledger rather than instead of it. A log-first design, where
 * the primary write is an event insert and the ledger is folded from it, would move the
 * balance-zero invariant out of the database: today an unbalanced transaction is refused by a
 * deferred constraint trigger at `COMMIT` that no script can walk past, whereas under a
 * log-first design "balanced" becomes something application code promises. For a financial
 * ledger that trades a database-enforced invariant for an application-enforced one.
 *
 * So the log is written **in the same database transaction** as the state change that causes
 * it, and `replay` folds it into projections and asserts they equal the live state. Every
 * property wanted of an event log — replayable from genesis, auditable as one narrative,
 * provable rather than asserted — holds. What is not done is making the log the only writer.
 * The two records are written together and checked against each other, which is a stronger
 * position than either alone: a bug in the ledger writer and a bug in the event writer would
 * have to agree exactly to escape notice.
 */

import type { AccountId } from './accounts.js';
import type { EntryDraft } from './evidence.js';
import type { IdempotencyKey, SourceId } from './identifiers.js';
import type { Money } from './money.js';

/**
 * The things that happen. A closed set, deliberately: adding one is a domain decision, and
 * a log whose vocabulary anybody can extend at the call site is a log nobody can fold.
 */
export const DOMAIN_EVENT_TYPES = [
  /**
   * Where the narrative begins.
   *
   * A log that starts today cannot explain a ledger that started last year. On adoption,
   * one event carries the position as it already stood — an opening balance, in the sense
   * any other set of books means it. Written by the migration, never by application code,
   * and there is exactly one of them.
   */
  'LedgerOpened',

  // ── Record one: the promise ───────────────────────────────────────────────
  /** A customer paid; the PSP owes us. Books `psp_receivable` against revenue. */
  'PaymentAuthorized',

  // ── Record two: the PSP's claim ───────────────────────────────────────────
  /** A settlement export was parsed and stored. Books nothing. */
  'SettlementIngested',
  /** A PSP said it is sending a payout. Books nothing — it is a claim. */
  'PayoutReported',
  /** Promises were matched to a movement and an expected inflow recorded. Books nothing. */
  'InflowAllocated',

  // ── Record three: the bank ────────────────────────────────────────────────
  /** A bank statement was parsed and stored. Books nothing by itself. */
  'BankStatementIngested',
  /** A bank credit confirmed an inflow. **The only event that increases `bank_account`.** */
  'SettlementBooked',
  /** The bank sent a confirmed payout back. An exact negation of the booking above. */
  'PayoutReturned',
  /**
   * A reserve the PSP had withheld came back.
   *
   * Kept apart from `SettlementBooked` although both increase `bank_account` from a bank
   * credit, because they say different things: a settlement discharges a receivable, and
   * this discharges nothing — it moves an asset we already held from `psp_reserve` into
   * cash. Collapsing them would make the log claim that payments settled on a day when no
   * payment settled (ADR-0071).
   */
  'ReserveReleased',

  // ── Corrections ───────────────────────────────────────────────────────────
  /** A promise was undone before any money came, booked as contra-income. */
  'ReversalBooked',
  /**
   * A transaction was cancelled by its exact mirror image.
   *
   * Distinct from `ReversalBooked` on purpose. That one is a domain decision — a refunded
   * payment, booked to `reversals` — while this is the mechanical primitive, which negates
   * whatever the original did without knowing why. Collapsing them would make the log
   * claim a refund happened when what happened was a correction.
   */
  'TransactionReversed',
  /** Money was clawed back after it had settled. */
  'ChargebackBooked',
  /** A human decision, and any compensating entry it posted. */
  'ResolutionRecorded',

  // ── The queue ─────────────────────────────────────────────────────────────
  'ExceptionRaised',
  'ExceptionResolved',

  // ── Retention ─────────────────────────────────────────────────────────────
  /**
   * Bytes we held were destroyed on purpose.
   *
   * The one event that records something leaving the system rather than entering it, and
   * the reason it is in the vocabulary at all: a deletion nobody can see is
   * indistinguishable from a deletion nobody performed. Both halves of the retention path
   * append it — the original payload replaced by a redacted copy, and the redacted copy
   * itself purged at the end of its life — with `detail.from` and `detail.to` saying
   * which. The evidence row, its hash and its lineage are never touched, so the narrative
   * keeps a record of a document whose bytes are gone (ADR-0065).
   */
  'EvidencePurged',
] as const;

export type DomainEventType = (typeof DOMAIN_EVENT_TYPES)[number];

/**
 * Which events move value, and therefore must carry their entries.
 *
 * The distinction is what makes the log foldable into balances: an event that changed the
 * books carries exactly what it did to them, so the projection is a sum rather than a
 * re-derivation. An event that changed no balance carries none, and folding it adds nothing
 * — which is the correct answer and not an omission.
 */
export const BOOKING_EVENTS: readonly DomainEventType[] = [
  'LedgerOpened',
  'PaymentAuthorized',
  'SettlementBooked',
  'PayoutReturned',
  'ReserveReleased',
  'ReversalBooked',
  'TransactionReversed',
  'ChargebackBooked',
  'ResolutionRecorded',
];

export function isBookingEvent(type: DomainEventType): boolean {
  return BOOKING_EVENTS.includes(type);
}

/**
 * One thing that happened.
 *
 * `eventId` is derived from the type and the subject, never generated. A `randomUUID` would
 * make the same event replay to a different log, and it would let a retried request append
 * the same happening twice.
 *
 * `occurredAt` and `recordedAt` are separate because they answer different questions. A
 * payout that moved on Tuesday and was ingested on Thursday is one event with two dates, and
 * a report that conflates them will attribute Tuesday's money to Thursday.
 */
export interface DomainEvent {
  readonly eventId: IdempotencyKey;
  readonly type: DomainEventType;
  /** What the event is about: a transaction id, a payout reference, an exception key. */
  readonly subject: string;
  readonly source: SourceId | null;
  /** When it happened in the world. */
  readonly occurredAt: Date;
  /** When we learned of it. Never used to derive a number (determinism). */
  readonly recordedAt: Date;
  /**
   * What it did to the books. Empty for events that moved no value, which is most of them.
   * Present ones fold into the balance projection by simple summation.
   */
  readonly entries: readonly EntryDraft[];
  /** Everything else worth keeping, in the event's own shape. Never money as a number. */
  readonly detail: Readonly<Record<string, unknown>>;
  /**
   * The event this one answers, where there is one — a booking caused by a match, a
   * resolution caused by an exception. The audit trail's own edges.
   */
  readonly causedBy: string | null;
}

/** ASCII unit separator: a control character that cannot occur in an id or a type name. */
const SEPARATOR = String.fromCharCode(31);

/**
 * The identity of one happening.
 *
 * `occurrence` distinguishes repeats of the same *kind* of thing about the same subject —
 * an exception raised, resolved, and raised again is three happenings, not one shadowed by
 * two duplicates. It must be derived from something monotonic and reproducible (the
 * appended row's own sequence, never a clock), or a replay would produce a different log
 * from the run it replays.
 *
 * Omitted where a subject can only ever have one event of a type: a transaction is
 * authorized once, a payout is reported once.
 */
export function domainEventId(
  type: DomainEventType,
  subject: string,
  occurrence?: string,
): IdempotencyKey {
  return occurrence === undefined
    ? [type, subject].join(SEPARATOR)
    : [type, subject, occurrence].join(SEPARATOR);
}

/**
 * The balance every account reaches by folding the log.
 *
 * A pure function of the events, which is the whole claim of this phase: hand it the log
 * and it produces the books, with no database, no clock and no order-dependence beyond the
 * sequence the events were written in.
 */
export function foldBalances(
  events: readonly Pick<DomainEvent, 'entries'>[],
): Map<AccountId, bigint> {
  const balances = new Map<AccountId, bigint>();

  for (const event of events) {
    for (const entry of event.entries) {
      balances.set(entry.accountId, (balances.get(entry.accountId) ?? 0n) + entry.amount.kobo);
    }
  }

  return balances;
}

/** A projection that disagreed with the log. Each one is a bug, not a rounding difference. */
export interface ProjectionDrift {
  readonly what: string;
  readonly key: string;
  readonly fromEvents: string;
  readonly live: string;
}

export interface ReplayReport {
  readonly events: number;
  /** Balances as the log says they should be. */
  readonly balances: ReadonlyMap<AccountId, bigint>;
  readonly drift: readonly ProjectionDrift[];
  /** True when every projection matches the fold exactly. */
  readonly agrees: boolean;
}

/** A helper for building a booking event's entries from ledger amounts. */
export function entryDrafts(
  entries: readonly { accountId: AccountId; amount: Money }[],
): EntryDraft[] {
  return entries.map((entry) => ({ accountId: entry.accountId, amount: entry.amount }));
}
