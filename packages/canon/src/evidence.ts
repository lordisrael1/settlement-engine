/**
 * Evidence and resolutions — the two things that make a reconciliation defensible rather
 * than merely correct.
 *
 * Six months after the fact, "the system matched it" is not an answer. The questions that
 * actually get asked are: *which file said that?*, *which line of it?*, *who uploaded it?*,
 * *what version of the parser read it?*, and *who decided, and on what grounds?* A system
 * that cannot answer them has produced numbers nobody can defend, which in a financial
 * context is close to having produced nothing.
 */

import type { AccountId } from './accounts.js';
import type { IdempotencyKey, SourceId, TransactionId } from './identifiers.js';
import type { Money } from './money.js';
import { isNegative } from './money.js';

export type EvidenceKind =
  /** A settlement or payout report fetched from, or exported by, a PSP. */
  | 'psp_settlement'
  /** A statement or transaction export from our own bank. */
  | 'bank_statement'
  /** A raw inbound webhook delivery, kept with its headers. */
  | 'webhook';

/**
 * The immutable record of a document we reasoned from.
 *
 * The identity is the **SHA-256 of the bytes**, which makes re-uploading the same file a
 * no-op by construction rather than by convention (idempotency again, one layer up), and makes
 * "is this the file we used?" answerable by anyone with the file and no access to us.
 *
 * `parserVersion` is here because a parser is part of the reasoning. When a settlement
 * adapter is corrected, every conclusion drawn by the old one is suspect in a way that can
 * be found and re-run — but only if we wrote down which one ran.
 */
export interface Evidence {
  /** The SHA-256 hex digest of `bytes`. Content-addressed: identical files are one record. */
  readonly evidenceId: string;
  readonly kind: EvidenceKind;
  readonly source: SourceId;
  /** The name it arrived under, when it had one. Never trusted, only recorded. */
  readonly filename: string | null;
  readonly byteLength: number;
  /**
   * Where the bytes live outside this database — an object-store URI, a vault path.
   *
   * Nullable because a small deployment keeps the bytes in `evidence_blobs` and needs no
   * second copy. It exists because a large one cannot: statements run to hundreds of
   * megabytes, and an encrypted bucket is where a real one goes. When the blob is purged at
   * the end of its retention (ADR-0065), this is the only thing standing between a hash and
   * an unanswerable question — so it is a *locator*, recorded at ingest, and never a promise
   * that the object is still there.
   */
  readonly storageLocation: string | null;
  /** Who or what put it in front of us: an operator's id, a cron job, an API client. */
  readonly receivedFrom: string;
  readonly receivedAt: Date;
  /** Which adapter, at which version, produced the canonical records from these bytes. */
  readonly parserVersion: string;
}

/**
 * Where inside the file one canonical record came from.
 *
 * The evidence id says which document; this says which *line* of it. That difference is
 * the whole of the audit question in practice — a five-thousand-row settlement export and
 * a hash of it is not a trail anyone can follow, because reproducing the conclusion means
 * finding the row again, and "somewhere in this file" is not finding it.
 *
 * Both fields are nullable and both are usually populated. `rowNumber` is the zero-based
 * index within the artifact as parsed; `path` is a locator in the artifact's own idiom —
 * `$[3]` for a bare array, `$.data[3]` for an envelope, `row:17` for a CSV. Recorded by the
 * parser, which is the only layer that can honestly know it.
 */
export interface RowLineage {
  readonly rowNumber: number | null;
  readonly path: string | null;
}

export const NO_LINEAGE: RowLineage = { rowNumber: null, path: null };

/** Lineage for row `index` of a plain JSON array — the shape most of these exports take. */
export function arrayLineage(index: number, root = '$'): RowLineage {
  return { rowNumber: index, path: `${root}[${index}]` };
}

export type ResolutionSubject = 'payout' | 'bank_credit' | 'transaction' | 'settlement_line';

/**
 * A ledger entry a human decision produces. Structurally what the ledger's own writer
 * takes, expressed here so a resolution can carry its consequences without `canon`
 * depending on the ledger.
 */
export interface EntryDraft {
  readonly accountId: AccountId;
  /** Signed: positive debits the account, negative credits it. */
  readonly amount: Money;
}

/**
 * A human's decision about something the machine could not settle.
 *
 * **Appended, never applied in place.** A reviewer does not edit a match, change an
 * amount, or clear an exception — they add a statement saying what they concluded, who
 * they are, when, why, and what they were looking at. The exception's own history stays
 * exactly as it was, which is the same append-only discipline the ledger obeys, extended to
 * the judgements made about it.
 *
 * The consequence worth stating plainly: a wrong human decision is corrected by a second
 * resolution, not by deleting the first. Both remain visible, and so does the fact that
 * somebody changed their mind.
 */
export interface Resolution {
  /**
   * The natural key of the decision, so that a retried request appends one resolution
   * rather than two (idempotency). Also the identity of the compensating ledger transaction it
   * posts, if it posts one — one decision, one booking, one id.
   */
  readonly resolutionKey: IdempotencyKey;
  readonly subject: ResolutionSubject;
  readonly subjectId: string;
  /** What was decided — `write_off`, `chased_psp`, `confirmed_fraud`, `reallocated`. */
  readonly action: string;
  readonly reason: string;
  /**
   * What the decision is worth, where it has a value.
   *
   * `null` for decisions that move nothing — chasing a PSP, noting a call. Present for the
   * ones that do, because "does this need a second pair of eyes?" is a question about an
   * amount, and a threshold cannot be applied to a decision that never states one.
   */
  readonly amount: Money | null;
  /** The identity of the person. Not a role, not a service account. */
  readonly resolvedBy: string;
  readonly resolvedAt: Date;
  /** The document they relied on, when there was one. */
  readonly evidenceId: string | null;
  /**
   * Who approved it, for actions policy says need approving. `null` where none was
   * required — and `ApprovalPolicy` below decides which those are.
   */
  readonly approvedBy: string | null;
  readonly approvedAt: Date | null;
}

/**
 * Which decisions need a second pair of eyes, and above what value.
 *
 * Maker-checker exists for one failure mode: the person who noticed a discrepancy is the
 * person best placed to make it disappear, and they are usually acting in good faith, and
 * occasionally they are not. Requiring a *different* named person to approve a write-off is
 * the cheapest control that distinguishes the two cases, and it costs nothing on the
 * decisions that do not need it.
 *
 * It is policy, deliberately, not vocabulary — a deployment decides its own threshold and
 * its own list — but the *shape* lives here so that the reconciler and the ledger enforce
 * the same rule rather than two similar ones.
 */
export interface ApprovalPolicy {
  /** Actions that always need an approver, whatever they are worth. */
  readonly actionsRequiringApproval: readonly string[];
  /**
   * Resolutions worth at least this much need an approver.
   *
   * A threshold of zero means every valued decision needs one; there is deliberately no way
   * to express "no approval, ever", because that is a policy nobody should be able to set
   * by omitting a field.
   */
  readonly approvalThreshold: Money;
  /** Any resolution that posts a compensating ledger entry needs an approver. */
  readonly approveAnyBooking: boolean;
  /**
   * Taking the *original* bytes of a document out of the system needs an approver.
   *
   * The same control, pointed at the other way value leaves: a resolution moves money out
   * of the books, an original export moves a customer's name and email out of the estate.
   * A redacted export is not covered, because a redacted export is the fields the matcher
   * reads and nothing a person could be identified by (ADR-0066).
   */
  readonly approveOriginalExport: boolean;
}

/**
 * A sane default: money moving, or a discrepancy being made to disappear, needs two people.
 *
 * ₦50,000 is a starting number, not a truth — it is roughly the level at which chasing a
 * difference stops costing more than the difference. Deployments override it.
 */
export const DEFAULT_APPROVAL_POLICY: ApprovalPolicy = {
  actionsRequiringApproval: ['write_off', 'reclassify', 'clear_phantom', 'reallocate'],
  approvalThreshold: { kobo: 5_000_000n, currency: 'NGN' },
  approveAnyBooking: true,
  approveOriginalExport: true,
};

export function approvalRequired(
  policy: ApprovalPolicy,
  resolution: Resolution,
  booksEntries: boolean,
): boolean {
  if (booksEntries && policy.approveAnyBooking) return true;
  if (policy.actionsRequiringApproval.includes(resolution.action)) return true;
  if (resolution.amount === null) return false;

  const magnitude = resolution.amount.kobo < 0n ? -resolution.amount.kobo : resolution.amount.kobo;
  return magnitude >= policy.approvalThreshold.kobo;
}

/**
 * Why this resolution may not be recorded, or `null` if it may.
 *
 * Returned rather than thrown so that both the application and its tests can ask the
 * question without exception handling, and so the message that reaches an operator is the
 * same one the rule is written in.
 *
 * The self-approval check is the one that matters most and is the easiest to forget: an
 * approver who is the maker is not oversight, it is a field being filled in. It is checked
 * here *and* by a database constraint, because a control that only one layer enforces is a
 * control one deploy away from not existing.
 */
export function approvalFailure(
  policy: ApprovalPolicy,
  resolution: Resolution,
  booksEntries = false,
): string | null {
  const approved = resolution.approvedBy !== null;

  if (approved !== (resolution.approvedAt !== null)) {
    return 'An approval is either complete or absent: approvedBy and approvedAt must both ' +
      'be present or both be null. A half-recorded approval looks like oversight happened.';
  }

  if (approved && resolution.approvedBy === resolution.resolvedBy) {
    return `"${resolution.resolvedBy}" cannot approve their own resolution. Maker-checker ` +
      `means a second person looked, and one person named twice is one person.`;
  }

  if (approvalRequired(policy, resolution, booksEntries) && !approved) {
    return `Action "${resolution.action}" requires an approver` +
      (booksEntries ? ' because it posts a compensating ledger entry.' : '.');
  }

  if (resolution.amount !== null && isNegative(resolution.amount)) {
    // A negative "worth" makes the threshold comparison meaningless in the direction that
    // matters: it would let a large write-off be recorded as a small one by sign.
    return 'A resolution amount states what the decision is worth and is never negative. ' +
      'Direction belongs in the compensating entries, not in the size of the decision.';
  }

  return null;
}

/**
 * The accounts a human decision may never touch directly.
 *
 * `bank_account` is the whole of the list, and it is the whole of the three-way design in
 * one line: cash moves on bank evidence, and a resolution is not bank evidence. An
 * operator who believes the bank balance is wrong has found either a statement line we
 * have not ingested — in which case ingest it — or a genuine bank error, which is resolved
 * with the bank and arrives back as a statement line. Neither is fixed by typing a number.
 */
export const RESOLUTION_FORBIDDEN_ACCOUNTS: readonly AccountId[] = ['bank_account'];

/**
 * A resolution that has been recorded, and what it did.
 *
 * `bookedTransactionId` is `null` for the great majority: most decisions are statements
 * about what something *was*, not events that move value.
 */
export interface RecordedResolution {
  readonly resolution: Resolution;
  readonly bookedTransactionId: TransactionId | null;
}

// ── Retention and access ────────────────────────────────────────────────────

/**
 * Which version of a document's bytes is being held.
 *
 * `original` is what arrived, byte for byte — the only version the delivery's signature
 * can be recomputed over, and the only one that can contain a customer's name, email or
 * card metadata. `redacted` is the keep-list copy: the fields reconciliation actually reads
 * and nothing else.
 *
 * The distinction is recorded rather than inferred because the answer to "can you prove
 * these are the bytes the provider sent?" changes with it, and a system that cannot say
 * which it holds has to answer "no" for both.
 */
export type EvidenceContent = 'original' | 'redacted';

/**
 * How long each version of a document's bytes is kept.
 *
 * Policy, like `ApprovalPolicy` above, and here for the same reason: the reconciler, the
 * retention command and the API must apply one schedule rather than three similar ones. A
 * deployment sets its own figures — the defaults below are a starting position, not a legal
 * opinion, and the redacted horizon in particular is the one a Nigerian deployment confirms
 * with counsel against CBN and FIRS record-keeping obligations.
 */
export interface RetentionSchedule {
  /**
   * How long the bytes exactly as they arrived are kept, before a redacted copy replaces
   * them.
   *
   * This is the dispute window and nothing more. Past it the signature can no longer be
   * recomputed, which matters only to a dispute — "these exact bytes arrived, hashed to
   * this id, and the signature verified at this time" stays provable forever from the
   * evidence row itself (ADR-0064).
   */
  readonly originalDays: number;
  /** How long the redacted copy is kept. A financial record-keeping figure, not a technical one. */
  readonly redactedDays: number;
  /** How long an inbound delivery's original payload sits in the inbox before it is redacted. */
  readonly inboxOriginalDays: number;
}

/**
 * A starting schedule: thirty days of dispute window, six years of record.
 *
 * Thirty days covers every provider dispute window we have seen and is comfortably longer
 * than any chargeback notification lag. Six years is the shortest figure that satisfies the
 * ordinary Nigerian financial record-keeping expectation; deployments that answer to a
 * longer one raise it, and none should lower it without an opinion in writing.
 */
export const DEFAULT_RETENTION: RetentionSchedule = {
  originalDays: 30,
  redactedDays: 6 * 365 + 2,
  inboxOriginalDays: 30,
};

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Which kinds of evidence can be reduced to a keep-list copy, and which are the record
 * itself.
 *
 * A webhook payload is a *notification* about money. Reconciliation reads six fields of it,
 * and the rest — a customer's name, email, IP address and card metadata — is incidental to
 * transport. That is reducible, and reducing it is most of this system's data-protection
 * position.
 *
 * A settlement export and a bank statement are not. They are the financial record: the
 * thing we are obliged to keep, the thing an auditor asks to see, and the thing a
 * disagreement about money is settled against. A bank narration containing a counterparty's
 * name is evidence rather than an accident, and dropping it to satisfy minimisation would
 * destroy the record in order to protect it. They are retained whole, encrypted, and read
 * only through a logged and separately authorised path (ADR-0065).
 */
export function reducible(kind: EvidenceKind): boolean {
  return kind === 'webhook';
}

/**
 * When this version of these bytes stops being ours to hold.
 *
 * Computed once, at the moment the bytes are written, and stored — so a schedule changed
 * next quarter does not silently re-date everything already held, in either direction.
 */
export function purgeAfter(
  schedule: RetentionSchedule,
  kind: EvidenceKind,
  content: EvidenceContent,
  receivedAt: Date,
): Date {
  const short = reducible(kind) && content === 'original';
  const days = short ? schedule.originalDays : schedule.redactedDays;
  return new Date(receivedAt.getTime() + days * DAY_MS);
}

/**
 * What somebody did with a piece of evidence.
 *
 * `read_metadata` is the cheap, ordinary case — who uploaded it, when, which parser read
 * it — and is separated from `read_raw` deliberately: the metadata answers most audit
 * questions and carries no personal data, so the two are different endpoints with
 * different grants and different alert thresholds (ADR-0066).
 */
export type EvidenceAccessAction = 'read_metadata' | 'read_raw' | 'export' | 'purge';

/**
 * A request to take a copy of a document out of the system.
 *
 * The one operation that ends with evidence somewhere this system cannot see, which is why
 * it is maker-checked rather than merely authorised. `content` is the whole of the risk:
 * a redacted export carries the fields the matcher reads, and an original export carries
 * whatever the provider sent — including, for a card charge, a customer's name and email.
 */
export interface EvidenceExportRequest {
  readonly evidenceId: string;
  readonly content: EvidenceContent;
  /** Why. Recorded verbatim in the access log, because "who" without "why" is a name. */
  readonly reason: string;
  /** The verified principal asking. Not a claim in a header (ADR-0066). */
  readonly requestedBy: string;
  readonly requestedAt: Date;
  readonly approvedBy: string | null;
  readonly approvedAt: Date | null;
}

/**
 * Why this export may not be issued, or `null` if it may.
 *
 * Deliberately the same shape and the same rules as `approvalFailure` above — returned
 * rather than thrown, self-approval refused by name, an approval complete or absent — and
 * deliberately reading its policy from the same `ApprovalPolicy` a resolution does. A
 * second approval mechanism with its own threshold and its own idea of what a second pair
 * of eyes means is two controls to keep in step and one to quietly diverge (ADR-0042).
 */
export function exportApprovalFailure(
  policy: ApprovalPolicy,
  request: EvidenceExportRequest,
): string | null {
  const approved = request.approvedBy !== null;

  if (approved !== (request.approvedAt !== null)) {
    return 'An approval is either complete or absent: approvedBy and approvedAt must both ' +
      'be present or both be null. A half-recorded approval looks like oversight happened.';
  }

  if (approved && request.approvedBy === request.requestedBy) {
    return `"${request.requestedBy}" cannot approve their own export. Maker-checker means a ` +
      `second person looked, and one person named twice is one person.`;
  }

  if (request.content === 'original' && policy.approveOriginalExport && !approved) {
    return 'Exporting the original bytes takes a provider payload — customer name, email ' +
      'and card metadata included — outside this system, and needs a second named ' +
      'approver. A redacted export does not.';
  }

  if (request.reason.trim() === '') {
    return 'An export states why it is being taken. An access record with a name and no ' +
      'reason answers half the question an auditor asks.';
  }

  return null;
}
