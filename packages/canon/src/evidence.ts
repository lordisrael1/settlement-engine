/**
 * Evidence and resolutions — the two things that make a reconciliation defensible rather
 * than merely correct.
 *
 * Six months after the fact, "the system matched it" is not an answer. The questions that
 * actually get asked are: *which file said that?*, *who uploaded it?*, *what version of the
 * parser read it?*, and *who decided, and on what grounds?* A system that cannot answer
 * them has produced numbers nobody can defend, which in a financial context is close to
 * having produced nothing.
 */

import type { SourceId } from './identifiers.js';

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
 * no-op by construction rather than by convention (Law 4 again, one layer up), and makes
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
  /** Who or what put it in front of us: an operator's id, a cron job, an API client. */
  readonly receivedFrom: string;
  readonly receivedAt: Date;
  /** Which adapter, at which version, produced the canonical records from these bytes. */
  readonly parserVersion: string;
}

export type ResolutionSubject = 'payout' | 'bank_credit' | 'transaction' | 'settlement_line';

/**
 * A human's decision about something the machine could not settle.
 *
 * **Appended, never applied in place.** A reviewer does not edit a match, change an
 * amount, or clear an exception — they add a statement saying what they concluded, who
 * they are, when, why, and what they were looking at. The exception's own history stays
 * exactly as it was, which is the same discipline Law 2 imposes on the ledger, extended to
 * the judgements made about it.
 *
 * The consequence worth stating plainly: a wrong human decision is corrected by a second
 * resolution, not by deleting the first. Both remain visible, and so does the fact that
 * somebody changed their mind.
 */
export interface Resolution {
  readonly subject: ResolutionSubject;
  readonly subjectId: string;
  /** What was decided — `write_off`, `chased_psp`, `confirmed_fraud`, `reallocated`. */
  readonly action: string;
  readonly reason: string;
  /** The identity of the person. Not a role, not a service account. */
  readonly resolvedBy: string;
  readonly resolvedAt: Date;
  /** The document they relied on, when there was one. */
  readonly evidenceId: string | null;
  /**
   * Who approved it, for actions above a threshold. `null` where none was required —
   * and which actions require one is policy, not vocabulary, so it lives elsewhere.
   */
  readonly approvedBy: string | null;
  readonly approvedAt: Date | null;
}
