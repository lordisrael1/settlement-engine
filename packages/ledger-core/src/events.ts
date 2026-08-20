import type { AccountId, DomainEvent, DomainEventType, Money, SourceId } from '@recon/canon';
import { domainEventId, money } from '@recon/canon';

import type { Executor } from './pool.js';

/**
 * Writing and reading the event log.
 *
 * The one rule that makes it worth having: **an event is appended in the same database
 * transaction as the change it describes.** Not after, not by a listener, not on a queue.
 * Either both land or neither does, so the log can never claim something the tables deny,
 * or miss something they hold. An event log written asynchronously is a log that is usually
 * right, and "usually right" is not a property an audit can rest on.
 *
 * It lives here rather than in a package of its own for a boring structural reason: it needs
 * `Executor`, which is this package's, and this package needs to emit events — which would
 * be a dependency cycle. The *vocabulary* is in `@recon/canon`, where every other shared
 * definition lives.
 */

export interface EventInput {
  readonly type: DomainEventType;
  readonly subject: string;
  readonly source?: SourceId | null;
  readonly occurredAt: Date;
  readonly recordedAt: Date;
  readonly entries?: readonly { accountId: AccountId; amount: Money }[];
  readonly detail?: Readonly<Record<string, unknown>>;
  readonly causedBy?: string | null;
  /**
   * Distinguishes repeats of the same kind of happening about the same subject.
   *
   * Must come from something monotonic and reproducible — the appended row's own sequence,
   * never a clock — because a replay has to produce the same log as the run it replays.
   */
  readonly occurrence?: string;
}

/**
 * Append one event.
 *
 * Idempotent by the derived id: the same happening recorded twice is one row, resolved by a
 * unique index rather than by remembering (idempotency, one level up from the ledger's own). A
 * retried reconciliation run therefore produces the same log, not a longer one.
 */
export async function appendEvent(db: Executor, input: EventInput): Promise<boolean> {
  const result = await db.query(
    `INSERT INTO events
            (event_id, type, subject, source, occurred_at, recorded_at,
             entries, detail, caused_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9)
     ON CONFLICT (event_id) DO NOTHING`,
    [
      domainEventId(input.type, input.subject, input.occurrence),
      input.type,
      input.subject,
      input.source ?? null,
      input.occurredAt,
      input.recordedAt,
      JSON.stringify(
        (input.entries ?? []).map((entry) => ({
          account_id: entry.accountId,
          // Text, never a JSON number: a JSON number is a double (integer kobo).
          kobo: entry.amount.kobo.toString(),
        })),
      ),
      JSON.stringify(input.detail ?? {}),
      input.causedBy ?? null,
    ],
  );
  return (result.rowCount ?? 0) > 0;
}

interface EventRow {
  sequence: string;
  event_id: string;
  type: DomainEventType;
  subject: string;
  source: string | null;
  occurred_at: Date;
  recorded_at: Date;
  entries: { account_id: AccountId; kobo: string }[];
  detail: Record<string, unknown>;
  caused_by: string | null;
}

export interface StoredEvent extends DomainEvent {
  /** Position in the log. The order everything happened in, and the order it folds in. */
  readonly sequence: bigint;
}

/**
 * The log, from genesis, in order.
 *
 * Paged rather than loaded whole, because "replay the whole history" is exactly the
 * operation whose input grows without bound, and a replay tool that runs out of memory at
 * the moment the history gets interesting is not a replay tool.
 */
export async function readEvents(
  db: Executor,
  options: { after?: bigint; limit?: number } = {},
): Promise<StoredEvent[]> {
  const result = await db.query<EventRow>(
    // `ORDER BY events.sequence`, qualified, and not `ORDER BY sequence`. The select list
    // casts the column to text so a BIGINT never rides through a JS number (integer kobo), and an
    // unqualified ORDER BY would bind to that *output* column — sorting the log
    // lexically, as 1, 10, 11, 2, 3. Paging over that order silently re-reads events and
    // folds them twice, which looks exactly like a ledger that has doubled.
    `SELECT sequence::text, event_id, type, subject, source, occurred_at, recorded_at,
            entries, detail, caused_by
       FROM events
      WHERE sequence > $1::bigint
      ORDER BY events.sequence
      LIMIT $2`,
    [(options.after ?? 0n).toString(), options.limit ?? 1000],
  );

  return result.rows.map(toEvent);
}

/** Every event about one thing, oldest first. The audit answer to "what happened to this?" */
export async function eventsAbout(db: Executor, subject: string): Promise<StoredEvent[]> {
  const result = await db.query<EventRow>(
    `SELECT sequence::text, event_id, type, subject, source, occurred_at, recorded_at,
            entries, detail, caused_by
       FROM events WHERE subject = $1 ORDER BY events.sequence`,
    [subject],
  );
  return result.rows.map(toEvent);
}

export async function countEvents(db: Executor): Promise<number> {
  const result = await db.query<{ count: string }>('SELECT COUNT(*)::text AS count FROM events');
  return Number(result.rows[0]?.count ?? '0');
}

function toEvent(row: EventRow): StoredEvent {
  return {
    sequence: BigInt(row.sequence),
    eventId: row.event_id,
    type: row.type,
    subject: row.subject,
    source: row.source,
    occurredAt: row.occurred_at,
    recordedAt: row.recorded_at,
    entries: row.entries.map((entry) => ({
      accountId: entry.account_id,
      amount: money(BigInt(entry.kobo)),
    })),
    detail: row.detail,
    causedBy: row.caused_by,
  };
}
