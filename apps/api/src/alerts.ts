import { format } from '@recon/canon';
import type { InboxDepth } from '@recon/inbox';
import { bankPosition, lastAttestation } from '@recon/reconciler';

import type { Services } from './services.js';

/**
 * The last mile: turning numbers nobody is watching into a signal something is.
 *
 * Everything else in this system is built so that a difference cannot disappear quietly.
 * The gap this closes is the one at the very end of that chain — the engine finds the
 * anomaly, records it, sorts it worst-first, and then waits for somebody to remember to
 * look. A queue that grows all weekend, a delivery that failed on Friday and will never be
 * retried, a scheduler that died on Tuesday: every one of those was visible in a number on
 * `/health`, and a number on `/health` that nothing compares to a threshold is a number
 * nobody reads (ADR-0074).
 *
 * So the thresholds are configuration, the comparison happens here, and the result is both
 * a sentence a person can act on and a status code a monitor already understands.
 *
 * Deliberately **not** a notifier. There is no email here, no Slack, no PagerDuty client —
 * because a notifier is a credential, a retry policy and an outbound dependency, and every
 * deployment already has a thing that watches an HTTP endpoint. This makes the endpoint
 * worth watching; routing is the deployment's job, and the README says how.
 */

export interface Alert {
  /** A stable slug, so a monitor can suppress one kind without suppressing the rest. */
  readonly kind:
    | 'inbox_backlog'
    | 'inbox_failed'
    | 'inbox_stale'
    | 'exception_queue'
    | 'reconciliation_stale'
    | 'bank_unattested';
  /** One sentence, in the terms of the business rather than the schema. */
  readonly detail: string;
  /** What was measured and what it was measured against, for a dashboard. */
  readonly observed: number;
  readonly threshold: number;
}

export async function alertsFor(
  services: Services,
  depth: InboxDepth,
  at: Date,
): Promise<Alert[]> {
  const { alerts } = services.config;
  const found: Alert[] = [];

  // A backlog is not the same as a stall, which is why the *age* of the oldest unworked
  // delivery is checked separately below. A deep queue on a busy morning is the system
  // working; a shallow queue whose oldest member arrived an hour ago is a worker that died.
  if (alerts.inboxPending > 0 && depth.pending - depth.deferred > alerts.inboxPending) {
    found.push({
      kind: 'inbox_backlog',
      detail:
        `${depth.pending - depth.deferred} webhook deliveries are waiting for a worker ` +
        `(${depth.deferred} more are backing off after a failure). Deliveries are accepted ` +
        `durably, so nothing is lost — but nothing is being booked from them either.`,
      observed: depth.pending - depth.deferred,
      threshold: alerts.inboxPending,
    });
  }

  if (alerts.inboxFailed > 0 && depth.failed >= alerts.inboxFailed) {
    found.push({
      kind: 'inbox_failed',
      detail:
        `${depth.failed} webhook deliveries have used every retry and will not be tried ` +
        `again by anything. Each one is a payment the ledger never heard about. The bytes ` +
        `are still stored: see GET /webhooks/deliveries/{id} for what each one said.`,
      observed: depth.failed,
      threshold: alerts.inboxFailed,
    });
  }

  const oldest = depth.oldestPendingAt;
  if (alerts.inboxAgeMs > 0 && oldest && at.getTime() - oldest.getTime() > alerts.inboxAgeMs) {
    const minutes = Math.round((at.getTime() - oldest.getTime()) / 60_000);
    found.push({
      kind: 'inbox_stale',
      detail:
        `The oldest unworked webhook delivery arrived ${minutes} minutes ago. The drain ` +
        `polls every few hundred milliseconds, so this is a worker that has stopped rather ` +
        `than a queue that is busy.`,
      observed: at.getTime() - oldest.getTime(),
      threshold: alerts.inboxAgeMs,
    });
  }

  // The queue's own depth. Distinct from the inbox's: this one is full of things a *person*
  // has to answer, and past a certain size it stops being a queue and becomes a backlog
  // nobody opens — which is the failure mode reconciliation tools actually die of.
  if (alerts.openExceptions > 0) {
    const open = await countOpenExceptions(services);
    if (open > alerts.openExceptions) {
      found.push({
        kind: 'exception_queue',
        detail:
          `${open} exceptions are open and unacknowledged. Worst first is still worst ` +
          `first, but a queue this deep is one nobody finishes — check whether one cause is ` +
          `producing most of them before working it item by item.`,
        observed: open,
        threshold: alerts.openExceptions,
      });
    }
  }

  // Nothing surfaces an exception until a run happens. A scheduler that died is a system
  // that has quietly stopped reconciling while answering 200 to everything else, and this is
  // the only place that can say so.
  if (alerts.reconcileAgeMs > 0) {
    const last = await lastReconciliation(services);
    const age = last === null ? null : at.getTime() - last.getTime();
    if (age === null || age > alerts.reconcileAgeMs) {
      found.push({
        kind: 'reconciliation_stale',
        detail:
          last === null
            ? `Nothing has ever been reconciled in this database. Until a run happens, no ` +
              `difference between the three records has been looked for at all.`
            : `The last reconciliation ran ${Math.round(age! / 3_600_000)} hours ago. ` +
              `Exceptions are only raised by a run, so nothing has been surfaced since.`,
        observed: age ?? Number.MAX_SAFE_INTEGER,
        threshold: alerts.reconcileAgeMs,
      });
    }
  }

  // The one alert that is not about a process failing.
  //
  // Everything else here fires because something stopped working. This fires because a
  // control that has to be performed by a person has not been performed by a person —
  // comparing our `bank_account` to the bank's own portal, which is the only thing standing
  // between these books and a fabricated statement (ADR-0068). A control nobody measures is
  // a control that quietly stops happening, so it is measured.
  if (alerts.attestationAgeMs > 0) {
    const unattested = await attestationAlert(services, at, alerts.attestationAgeMs);
    if (unattested) found.push(unattested);
  }

  return found;
}

async function attestationAlert(
  services: Services,
  at: Date,
  threshold: number,
): Promise<Alert | null> {
  const position = await bankPosition(services.pool, services.config.bankAccountId);

  // Nothing ingested yet is not a control failure; it is a database nobody has used. Alerting
  // here would teach whoever set this up to ignore the alert on their first afternoon.
  if (position.statementAt === null) return null;

  const last = await lastAttestation(services.pool, services.config.bankAccountId);
  const age = last === null ? null : at.getTime() - last.asOf.getTime();
  if (age !== null && age <= threshold) return null;

  const days = age === null ? null : Math.round(age / (24 * 60 * 60 * 1000));
  const closing =
    position.statementClosing === null
      ? 'the last statement reported no running balance'
      : `the last statement's own closing balance was ${format(position.statementClosing)}`;

  return {
    kind: 'bank_unattested',
    detail:
      (last === null
        ? `Nobody has ever compared these books to the bank's own portal. `
        : `Nobody has compared these books to the bank's own portal for ${days} days ` +
          `(last: ${last.attestedBy}). `) +
      `Cash here is booked from an uploaded file and nothing proves that file came from the ` +
      `bank, so this comparison is the only control over a fabricated statement — \`verify\` ` +
      `cannot catch one, because a fabricated statement that balances is internally ` +
      `consistent. The books say ${format(position.ledgerBalance)} and ${closing}. ` +
      `Record a check with POST /bank/attestations.`,
    observed: age ?? Number.MAX_SAFE_INTEGER,
    threshold,
  };
}

/**
 * How many exceptions are open and unowned.
 *
 * `open` only, not `acknowledged`: an acknowledged exception is somebody's current work, and
 * counting it towards an alert would page a team for the fact that they are doing their
 * jobs.
 */
async function countOpenExceptions(services: Services): Promise<number> {
  const result = await services.pool.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM exceptions WHERE state = 'open'`,
  );
  return Number(result.rows[0]?.count ?? '0');
}

/**
 * When a reconciliation last reached a conclusion, from the conclusions themselves.
 *
 * Read from `matches` rather than from a "last run" row somebody would have to remember to
 * write, for the reason the whole system prefers derived facts: a status column can be
 * updated by a run that then failed, and a conclusion cannot be written by a run that did
 * not happen.
 *
 * A run that concludes nothing therefore does not move this — correctly. A database with no
 * unreconciled records has nothing to reconcile, and the alert it raises after a day of that
 * is answered by looking once and seeing an empty queue.
 */
async function lastReconciliation(services: Services): Promise<Date | null> {
  const result = await services.pool.query<{ at: Date | null }>(
    'SELECT MAX(at) AS at FROM matches',
  );
  return result.rows[0]?.at ?? null;
}
