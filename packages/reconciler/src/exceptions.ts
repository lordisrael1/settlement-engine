import type {
  ApprovalPolicy,
  ExceptionState,
  ExceptionSubject,
  MatchResult,
  Money,
  ReasonCode,
  RecordedResolution,
  ReconciliationException,
  RejectedCandidate,
  Resolution,
  ResolutionCause,
} from '@recon/canon';
import {
  canTransition,
  exceptionKey,
  money,
  reasonKind,
  severityOf,
  subtract,
} from '@recon/canon';
import type { EntryInput, Executor } from '@recon/ledger-core';
import { appendEvent, inTransaction } from '@recon/ledger-core';

import { recordResolution, type BankLineCollision } from './store.js';

/**
 * The queue — and the machinery that keeps it honest between runs.
 *
 * A run can say what is wrong *right now*. On its own it cannot say that the same
 * thing had been wrong since Tuesday, that Amaka was already looking at it, or that it had
 * quietly fixed itself when the settlement file finally arrived. Every run started from
 * nothing and reported everything, which is a report, not a queue.
 *
 * Three operations turn one into the other, and the third is the one that matters:
 *
 *   `raiseExceptions`  record what this run found, once per distinct problem
 *   `acknowledge` / `resolveByHuman`   a person takes it, and later answers it
 *   `clearVanished`    the run looked for it, did not find it, and nobody owns it
 *
 * Without `clearVanished` the queue only grows, and a queue that only grows is one people
 * stop opening. With it, a T+1 straggler sits as pending and clears itself when its file
 * lands, with nobody alerted.
 *
 * Read the third one's restrictions before trusting it, because the same mechanism that
 * keeps the queue from growing is the one that could silently empty it: it clears only
 * subjects the run actually loaded, and never an exception a human has acknowledged.
 */

const kobo = (amount: Money): string => amount.kobo.toString();
const fromKobo = (text: string | null): Money => money(BigInt(text ?? '0'));

/** What a run concluded about one subject, before it becomes a queue entry. */
export interface ExceptionDraft {
  readonly subject: ExceptionSubject;
  readonly subjectId: string;
  readonly reason: ReasonCode;
  readonly amount: Money | null;
  readonly dueAt: Date | null;
  readonly evidenceId: string | null;
  readonly links: {
    readonly transactionIds: readonly string[];
    readonly payoutReferences: readonly string[];
    readonly bankCreditKeys: readonly string[];
    readonly settlementKeys: readonly string[];
  };
  readonly considered: readonly RejectedCandidate[];
}

/**
 * Turn a matcher finding into a queue entry.
 *
 * The subject is chosen by what the finding is *about*, not by which link list happens to be
 * populated first: a credit nobody can identify is about the credit, a payout that does not
 * add up is about the payout, a promise whose money never came is about the promise. Getting
 * this wrong would scatter one subject's problems across several queue identities and
 * defeat the deduplication entirely.
 */
export function draftFrom(result: MatchResult, amount: Money | null = null): ExceptionDraft | null {
  if (reasonKind(result.reason) !== 'exception') return null;

  const subject = subjectOf(result);
  if (!subject) return null;

  return {
    subject: subject.kind,
    subjectId: subject.id,
    reason: result.reason,
    amount,
    dueAt: null,
    evidenceId: null,
    links: {
      transactionIds: result.transactionIds,
      payoutReferences: result.payoutReferences,
      bankCreditKeys: result.bankCreditKeys,
      settlementKeys: result.settlementKeys,
    },
    considered: result.considered,
  };
}

function subjectOf(
  result: MatchResult,
): { kind: ExceptionSubject; id: string } | null {
  switch (result.reason) {
    case 'UNIDENTIFIED_CREDIT':
    case 'DUPLICATE_BANK_CREDIT':
      return result.bankCreditKeys[0]
        ? { kind: 'bank_credit', id: result.bankCreditKeys[0] }
        : null;

    case 'RETURNED_PAYOUT':
    case 'PAYOUT_UNBALANCED':
      return result.payoutReferences[0]
        ? { kind: 'payout', id: result.payoutReferences[0] }
        : null;

    case 'MISSING_SETTLEMENT':
      // A promise past its window is about the promise; an inflow the bank never confirmed
      // is about the payout. Both wear this reason code, and the link lists tell them apart.
      if (result.transactionIds[0]) return { kind: 'transaction', id: result.transactionIds[0] };
      return result.payoutReferences[0]
        ? { kind: 'payout', id: result.payoutReferences[0] }
        : null;

    default:
      // PHANTOM_CREDIT and AMOUNT_MISMATCH arrive from either direction: a payout with no
      // promises, a settlement line naming nothing, a credit short by too much.
      if (result.bankCreditKeys[0]) return { kind: 'bank_credit', id: result.bankCreditKeys[0] };
      if (result.payoutReferences[0]) return { kind: 'payout', id: result.payoutReferences[0] };
      if (result.settlementKeys[0]) return { kind: 'settlement_line', id: result.settlementKeys[0] };
      return result.transactionIds[0]
        ? { kind: 'transaction', id: result.transactionIds[0] }
        : null;
  }
}

/**
 * A statement row that could not be stored because a different row already holds its id.
 *
 * This is the one queue entry the *matcher* never produces, and it has to exist for exactly
 * that reason: the collision happens at ingest, before any matching, and the row it concerns
 * never reaches the matcher at all. A run cannot report a credit it was never given, which
 * is what made this the quietest way for money to leave the books — the symptom arrived days
 * later and somewhere else, as a payout that would not confirm (ADR-0068).
 *
 * The subject is the contested id rather than either row, because that is what a person has
 * to decide about: two credits, one identity, and which of them the books currently hold.
 * `considered` carries the stored row and what differs, so the queue entry answers "which
 * two?" without a query.
 */
export function collisionDraft(collision: BankLineCollision): ExceptionDraft {
  return {
    subject: 'bank_credit',
    subjectId: collision.idempotencyKey,
    reason: 'BANK_LINE_COLLISION',
    amount: collision.arriving.amount,
    dueAt: null,
    // The file the *arriving* row came from. The stored row's evidence is in `considered`;
    // this is the one somebody is about to be told was ingested successfully.
    evidenceId: collision.arriving.evidenceId,
    links: {
      transactionIds: [],
      payoutReferences: [],
      bankCreditKeys: [collision.idempotencyKey],
      settlementKeys: [],
    },
    considered: [
      {
        candidateId: collision.stored.evidenceId,
        kind: 'bank_credit',
        difference: subtract(collision.arriving.amount, money(BigInt(collision.stored.amountKobo))),
        // The stored row got there first and holds the id. That is the whole of the
        // conflict, and it is exactly what `already_claimed` means everywhere else.
        rejectedBecause: 'already_claimed',
      },
    ],
  };
}

export interface RaiseOutcome {
  readonly raised: number;
  /** Already open, and left exactly as it was. */
  readonly unchanged: number;
  /** Resolved before, and back again. Worth knowing: a problem that returns is a pattern. */
  readonly reopened: number;
}

/**
 * Record this run's findings, once per distinct problem.
 *
 * A second run that reaches the same conclusion appends **nothing**. That is the whole
 * point of a derived key: the queue grows by the number of problems, not by the number of
 * times anybody looked.
 *
 * An exception that was resolved and is found again *does* append — as a reopening. A
 * difference that comes back is not the same event as one that never went away, and
 * flattening the two would hide the most useful signal in the table: which problems recur.
 */
export async function raiseExceptions(
  db: Executor,
  drafts: readonly ExceptionDraft[],
  at: Date,
): Promise<RaiseOutcome> {
  let raised = 0;
  let unchanged = 0;
  let reopened = 0;

  await inTransaction(db, async (client) => {
    for (const draft of drafts) {
      const key = exceptionKey(draft.subject, draft.subjectId, draft.reason);
      const current = await stateOf(client, key);

      if (current === 'open' || current === 'acknowledged') {
        // Still true, still unanswered, and somebody may already own it. Appending here
        // would reset nothing and record nothing — it would just make the history longer.
        unchanged += 1;
        continue;
      }

      const occurrence = await appendExceptionEvent(client, {
        key,
        draft,
        from: current,
        to: 'open',
        at,
        actor: null,
        cause: null,
        resolutionKey: null,
      });
      await appendEvent(client, {
        type: 'ExceptionRaised',
        subject: key,
        occurredAt: at,
        recordedAt: at,
        occurrence,
        detail: { reason: draft.reason, subject: draft.subject, subject_id: draft.subjectId },
      });
      if (current === null) raised += 1;
      else reopened += 1;
    }
  });

  return { raised, unchanged, reopened };
}

/**
 * What one run was actually in a position to judge about one kind of subject.
 *
 * The distinction this carries is the difference between "the problem went away" and "we
 * did not look", and until it existed the two were the same code path. Every loader in a
 * run is bounded by a `limit`; past that bound the run holds a *sample*, and a subject
 * outside the sample is absent from the findings for a reason that has nothing to do with
 * whether it is still wrong.
 */
export interface SubjectWindow {
  /** The subject ids this run actually loaded and re-judged. */
  readonly witnessed: ReadonlySet<string>;
  /**
   * Whether the loaders hit their bound.
   *
   * `false` means the run read the entire population of this kind, so absence from the
   * findings really does mean the conclusion is no longer reachable — the record was
   * claimed, matched or resolved — and clearing is safe for subjects outside `witnessed`
   * too. That case matters: a bank credit that finally confirmed a payout is no longer an
   * unmatched line, so it is not in `witnessed`, and its old `UNIDENTIFIED_CREDIT` must
   * still clear. `true` means the opposite, and clearing is confined to what was loaded.
   */
  readonly truncated: boolean;
}

/** Which subjects this run may speak to, and how far it could see for each. */
export type ClearScope = Partial<Record<ExceptionSubject, SubjectWindow>>;

export interface ClearOutcome {
  /** Closed with `evidence_arrived`: the run looked, and the conclusion was gone. */
  readonly cleared: number;
  /**
   * Left open although this run did not find them again.
   *
   * Worth reporting rather than swallowing. A figure that stays non-zero run after run is
   * the visible symptom of a queue whose subjects no longer fit inside the run's bound —
   * the queue has stopped being self-clearing, and the fix is a bigger `limit` or a
   * narrower run, not patience.
   */
  readonly withheld: number;
}

/**
 * Close every **open** exception this run looked for and did not find again.
 *
 * This is the auto-clearing the whole phase exists for. A T+1 straggler is raised on
 * Tuesday, the settlement file lands on Wednesday, and on Wednesday's run the matcher
 * simply no longer reaches that conclusion — so the exception is resolved with
 * `evidence_arrived`, and nobody is woken for either event.
 *
 * Two restrictions keep it from being the mechanism that silently empties the queue rather
 * than the one that keeps it honest. Both are load-bearing, and both were real losses.
 *
 *   **It clears only what the run could see.** Every loader in `reconcile` stops at
 *   `limit` rows. Past that bound the matcher never considers the remaining records, so it
 *   reaches no conclusion about them, so they are absent from `found` — and absence used to
 *   mean resolved. One busy day past the limit and every exception beyond the cutoff was
 *   closed with `evidence_arrived`, on the strength of evidence nobody read. So the caller
 *   states what it loaded, and anything outside that window is left exactly as it is.
 *
 *   **It never takes an item away from a person.** Only `open` exceptions are cleared.
 *   An `acknowledged` one belongs to a named human who is investigating it, and a run
 *   deciding on their behalf that the matter is closed — labelled as though evidence had
 *   arrived — is the machine overruling the person it exists to serve. If the problem
 *   really is gone, they close it, and the queue records who did.
 *
 * Scoped by subject kind as well, because a run that only ingested a bank statement has
 * nothing to say about payout-side exceptions, and treating silence as "resolved" would
 * close problems that are still entirely real.
 */
export async function clearVanished(
  db: Executor,
  found: readonly ExceptionDraft[],
  scope: ClearScope,
  at: Date,
): Promise<ClearOutcome> {
  const subjects = Object.keys(scope) as ExceptionSubject[];
  if (subjects.length === 0) return { cleared: 0, withheld: 0 };

  const stillFound = new Set(
    found.map((draft) => exceptionKey(draft.subject, draft.subjectId, draft.reason)),
  );

  let cleared = 0;
  let withheld = 0;

  await inTransaction(db, async (client) => {
    const open = await client.query<{
      exception_key: string;
      subject: ExceptionSubject;
      subject_id: string;
      reason: ReasonCode;
      state: ExceptionState;
    }>(
      // Acknowledged items are read and then refused below rather than filtered out here,
      // so that one is *counted* as withheld. "This run did not find an exception a person
      // is holding" is a fact worth reporting: it usually means the problem has gone away
      // and they can close it, and it is invisible if the query never returns the row.
      `SELECT exception_key, subject, subject_id, reason, state
         FROM exceptions
        WHERE state <> 'resolved' AND subject = ANY($1)
        ORDER BY exception_key`,
      [subjects],
    );

    for (const row of open.rows) {
      if (stillFound.has(row.exception_key)) continue;

      // Somebody's open tab. The run does not get to close it on their behalf, however
      // certain it is that the difference has gone.
      if (row.state !== 'open') {
        withheld += 1;
        continue;
      }

      const window = scope[row.subject];
      // Outside the run's window: it was never re-judged, so its silence says nothing.
      if (!window || (window.truncated && !window.witnessed.has(row.subject_id))) {
        withheld += 1;
        continue;
      }

      const appended = await client.query<{ event_id: string }>(
        `INSERT INTO exception_events
                (exception_key, subject, subject_id, reason, from_state, to_state, at, cause)
         VALUES ($1, $2, $3, $4, $5, 'resolved', $6, 'evidence_arrived')
           RETURNING event_id::text`,
        [row.exception_key, row.subject, row.subject_id, row.reason, row.state, at],
      );
      await appendEvent(client, {
        type: 'ExceptionResolved',
        subject: row.exception_key,
        occurredAt: at,
        recordedAt: at,
        occurrence: appended.rows[0]!.event_id,
        detail: { cause: 'evidence_arrived', reason: row.reason },
      });
      cleared += 1;
    }
  });

  return { cleared, withheld };
}

/**
 * A named human takes ownership.
 *
 * Not a resolution — the difference is still unexplained. It records that it is no longer
 * *unowned*, which is the distinction between a queue two people are both working and a
 * queue nobody is.
 */
export async function acknowledge(
  db: Executor,
  key: string,
  actor: string,
  at: Date,
): Promise<boolean> {
  return moveTo(db, key, 'acknowledged', { at, actor, cause: null, resolutionKey: null });
}

/**
 * A person answered it, and their `Resolution` says how.
 *
 * The resolution itself is written by `recordResolution`, with its own approval rules and
 * its own compensating entry. This only records that the question is closed and points at
 * the answer — because an exception closed with no reference to the decision that closed it
 * is exactly the silent disappearance this system exists to prevent.
 */
export async function resolveByHuman(
  db: Executor,
  key: string,
  actor: string,
  resolutionKey: string,
  at: Date,
): Promise<boolean> {
  return moveTo(db, key, 'resolved', {
    at,
    actor,
    cause: 'resolved_by_human',
    resolutionKey,
  });
}

/**
 * A person answers a queue item: the decision, its compensating entry, and the closure —
 * one write.
 *
 * The three were already separately available, and letting a caller sequence them itself is
 * how you get the state this system exists to prevent: an entry posted whose justification
 * failed to save, or an exception closed pointing at a resolution that was never written.
 * Both look, afterwards, exactly like money moved for no reason. So they are one database
 * transaction, and the composition lives here rather than in whichever deployable happened
 * to need it first.
 *
 * `recordResolution` keeps its own rules — maker-checker, no entry may touch `bank_account`
 * — and they are not restated here. This adds only the queue's half of the answer.
 *
 * Returns `null` when there is no such exception. That is not an error: an operator
 * resolving a key that has already been cleared by evidence arriving is a race between a
 * person and a settlement file, and the settlement file is allowed to win.
 */
export async function resolveException(
  db: Executor,
  input: {
    readonly key: string;
    readonly resolution: Resolution;
    readonly entries?: readonly EntryInput[];
    readonly policy?: ApprovalPolicy;
  },
): Promise<{ recorded: RecordedResolution; closed: boolean } | null> {
  return inTransaction(db, async (client) => {
    const existing = await client.query<{ state: ExceptionState }>(
      'SELECT state FROM exceptions WHERE exception_key = $1',
      [input.key],
    );
    if (!existing.rows[0]) return null;

    const recorded = await recordResolution(client, input.resolution, {
      ...(input.entries ? { entries: input.entries } : {}),
      ...(input.policy ? { policy: input.policy } : {}),
    });

    const closed = await resolveByHuman(
      client,
      input.key,
      input.resolution.resolvedBy,
      input.resolution.resolutionKey,
      input.resolution.resolvedAt,
    );

    return { recorded, closed };
  });
}

async function moveTo(
  db: Executor,
  key: string,
  to: ExceptionState,
  detail: {
    at: Date;
    actor: string | null;
    cause: ResolutionCause | null;
    resolutionKey: string | null;
  },
): Promise<boolean> {
  return inTransaction(db, async (client) => {
    const existing = await client.query<{
      subject: ExceptionSubject;
      subject_id: string;
      reason: ReasonCode;
      state: ExceptionState;
    }>(
      `SELECT subject, subject_id, reason, state FROM exceptions WHERE exception_key = $1`,
      [key],
    );
    const row = existing.rows[0];
    if (!row) return false;
    // Re-applying a move that already happened is a no-op rather than an error, so a
    // retried request is safe (idempotency); an illegal one is a no-op too, because the caller
    // asking is a UI and a thrown error there says nothing a `false` does not.
    if (row.state === to || !canTransition(row.state, to)) return false;

    const appended = await client.query<{ event_id: string }>(
      `INSERT INTO exception_events
              (exception_key, subject, subject_id, reason, from_state, to_state, at,
               actor, cause, resolution_key)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         RETURNING event_id::text`,
      [
        key,
        row.subject,
        row.subject_id,
        row.reason,
        row.state,
        to,
        detail.at,
        detail.actor,
        detail.cause,
        detail.resolutionKey,
      ],
    );

    // Only resolution is a system-level happening. Acknowledging is ownership, and a log of
    // every time somebody picked something up would drown the narrative it exists to tell.
    if (to === 'resolved') {
      await appendEvent(client, {
        type: 'ExceptionResolved',
        subject: key,
        occurredAt: detail.at,
        recordedAt: detail.at,
        occurrence: appended.rows[0]!.event_id,
        detail: { cause: detail.cause, reason: row.reason, actor: detail.actor },
        causedBy: detail.resolutionKey,
      });
    }

    return true;
  });
}

async function stateOf(db: Executor, key: string): Promise<ExceptionState | null> {
  const result = await db.query<{ state: ExceptionState }>(
    'SELECT state FROM exceptions WHERE exception_key = $1',
    [key],
  );
  return result.rows[0]?.state ?? null;
}

async function appendExceptionEvent(
  db: Executor,
  input: {
    key: string;
    draft: ExceptionDraft;
    from: ExceptionState | null;
    to: ExceptionState;
    at: Date;
    actor: string | null;
    cause: ResolutionCause | null;
    resolutionKey: string | null;
  },
): Promise<string> {
  const { draft } = input;
  const result = await db.query<{ event_id: string }>(
    `INSERT INTO exception_events
            (exception_key, subject, subject_id, reason, from_state, to_state, at,
             amount_kobo, currency, due_at, evidence_id, links, considered,
             actor, cause, resolution_key)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::bigint, $9, $10, $11, $12::jsonb, $13::jsonb,
             $14, $15, $16)
       RETURNING event_id::text`,
    [
      input.key,
      draft.subject,
      draft.subjectId,
      draft.reason,
      input.from,
      input.to,
      input.at,
      draft.amount ? kobo(draft.amount) : null,
      draft.amount ? draft.amount.currency : null,
      draft.dueAt,
      draft.evidenceId,
      JSON.stringify(draft.links),
      JSON.stringify(
        draft.considered.map((candidate) => ({
          candidate_id: candidate.candidateId,
          kind: candidate.kind,
          difference_kobo: candidate.difference ? kobo(candidate.difference) : null,
          rejected_because: candidate.rejectedBecause,
        })),
      ),
      input.actor,
      input.cause,
      input.resolutionKey,
    ],
  );
  return result.rows[0]!.event_id;
}

export interface QueueFilter {
  readonly states?: readonly ExceptionState[];
  readonly subject?: ExceptionSubject;
  readonly limit?: number;
}

/**
 * The queue, worst first.
 *
 * Sorted by severity and then by age, not by arrival. Money that arrived and belongs to
 * nobody outranks money that has not arrived yet, because the first may have to be sent
 * back and the second is usually just late — and a queue sorted by arrival buries the
 * first under a week of the second.
 */
export async function openExceptions(
  db: Executor,
  filter: QueueFilter = {},
): Promise<ReconciliationException[]> {
  const states = filter.states ?? ['open', 'acknowledged'];

  const result = await db.query<ExceptionRow>(
    `SELECT exception_key, subject, subject_id, reason, state, amount_kobo::text, currency,
            due_at, evidence_id, links, considered, actor, cause, resolution_key,
            raised_at, since
       FROM exceptions
      WHERE state = ANY($1)
        AND ($2::text IS NULL OR subject = $2)
      ORDER BY raised_at, exception_key
      LIMIT $3`,
    [states, filter.subject ?? null, filter.limit ?? 500],
  );

  return result.rows
    .map(toException)
    .sort(
      (a, b) =>
        severityOf(b.reason) - severityOf(a.reason) ||
        a.raisedAt.getTime() - b.raisedAt.getTime() ||
        (a.key < b.key ? -1 : 1),
    );
}

export async function exceptionAt(
  db: Executor,
  key: string,
): Promise<ReconciliationException | null> {
  const result = await db.query<ExceptionRow>(
    `SELECT exception_key, subject, subject_id, reason, state, amount_kobo::text, currency,
            due_at, evidence_id, links, considered, actor, cause, resolution_key,
            raised_at, since
       FROM exceptions WHERE exception_key = $1`,
    [key],
  );
  const row = result.rows[0];
  return row ? toException(row) : null;
}

/** The whole history of one exception, oldest first. Nothing here was ever overwritten. */
export async function exceptionHistory(
  db: Executor,
  key: string,
): Promise<{ from: ExceptionState | null; to: ExceptionState; at: Date; actor: string | null; cause: ResolutionCause | null }[]> {
  const result = await db.query<{
    from_state: ExceptionState | null;
    to_state: ExceptionState;
    at: Date;
    actor: string | null;
    cause: ResolutionCause | null;
  }>(
    `SELECT from_state, to_state, at, actor, cause
       FROM exception_events WHERE exception_key = $1 ORDER BY event_id`,
    [key],
  );
  return result.rows.map((row) => ({
    from: row.from_state,
    to: row.to_state,
    at: row.at,
    actor: row.actor,
    cause: row.cause,
  }));
}

interface ExceptionRow {
  exception_key: string;
  subject: ExceptionSubject;
  subject_id: string;
  reason: ReasonCode;
  state: ExceptionState;
  amount_kobo: string | null;
  currency: string | null;
  due_at: Date | null;
  evidence_id: string | null;
  links: {
    transactionIds?: string[];
    payoutReferences?: string[];
    bankCreditKeys?: string[];
    settlementKeys?: string[];
  };
  considered: {
    candidate_id: string;
    kind: RejectedCandidate['kind'];
    difference_kobo: string | null;
    rejected_because: RejectedCandidate['rejectedBecause'];
  }[];
  actor: string | null;
  cause: ResolutionCause | null;
  resolution_key: string | null;
  raised_at: Date;
  since: Date;
}

function toException(row: ExceptionRow): ReconciliationException {
  return {
    key: row.exception_key,
    subject: row.subject,
    subjectId: row.subject_id,
    reason: row.reason,
    state: row.state,
    amount: row.amount_kobo === null ? null : fromKobo(row.amount_kobo),
    dueAt: row.due_at,
    evidenceId: row.evidence_id,
    transactionIds: row.links.transactionIds ?? [],
    payoutReferences: row.links.payoutReferences ?? [],
    bankCreditKeys: row.links.bankCreditKeys ?? [],
    settlementKeys: row.links.settlementKeys ?? [],
    considered: row.considered.map((candidate) => ({
      candidateId: candidate.candidate_id,
      kind: candidate.kind,
      difference: candidate.difference_kobo === null ? null : fromKobo(candidate.difference_kobo),
      rejectedBecause: candidate.rejected_because,
    })),
    raisedAt: row.raised_at,
    since: row.since,
    acknowledgedBy: row.state === 'acknowledged' ? row.actor : null,
    resolvedCause: row.state === 'resolved' ? row.cause : null,
    resolutionKey: row.resolution_key,
  };
}
