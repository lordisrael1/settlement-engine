import type {
  AccountId,
  MatchResult,
  Money,
  ReconciliationException,
} from '@recon/canon';
import { CHART_OF_ACCOUNTS, format } from '@recon/canon';
import type { DeliveryRecord } from '@recon/inbox';
import type { ReconciliationRun, ReconciliationSummary } from '@recon/reconciler';

/**
 * The representation boundary, and the whole of it.
 *
 * Two canonical types do not survive `JSON.stringify` untouched, and both would fail
 * loudly rather than quietly, which is why this is a file and not a `toJSON` scattered
 * through `canon`:
 *
 *   **`bigint` throws.** Deliberately, in the language itself. Serialising kobo as a JSON
 *   number would be worse than the throw — a JSON number is a double, and a double is not
 *   a ledger amount (integer kobo). So every amount crosses as a decimal *string*, exactly as it
 *   crosses into Postgres.
 *
 *   **`Date` is fine** and left alone: `toJSON` produces ISO-8601 UTC, which is what a
 *   client should receive. Wall-clock times in a named zone are the calendar's business,
 *   and it does not leave the packages.
 *
 * `formatted` rides along beside every amount because the alternative is every consumer
 * reimplementing kobo-to-naira, and a dashboard that divides by 100 in JavaScript has
 * turned an exact integer back into a float at the last possible moment.
 *
 * ADR-0007 said representation belongs at the boundary. This is the boundary.
 */
export interface JsonMoney {
  readonly kobo: string;
  readonly currency: string;
  readonly formatted: string;
}

export function asMoney(amount: Money): JsonMoney {
  return { kobo: amount.kobo.toString(), currency: amount.currency, formatted: format(amount) };
}

export function asBalances(balances: ReadonlyMap<string, Money>): unknown {
  return [...balances].map(([accountId, amount]) => ({
    accountId,
    // The account's meaning travels with its balance, because "psp_receivable: ₦48,500" is
    // a number and "money promised by PSPs and not yet in our hands: ₦48,500" is an answer.
    type: CHART_OF_ACCOUNTS[accountId as AccountId]?.type ?? null,
    meaning: CHART_OF_ACCOUNTS[accountId as AccountId]?.meaning ?? null,
    ...asMoney(amount),
  }));
}

export function asException(item: ReconciliationException): unknown {
  return {
    key: item.key,
    subject: item.subject,
    subjectId: item.subjectId,
    reason: item.reason,
    state: item.state,
    amount: item.amount ? asMoney(item.amount) : null,
    dueAt: item.dueAt,
    evidenceId: item.evidenceId,
    links: {
      transactionIds: item.transactionIds,
      payoutReferences: item.payoutReferences,
      bankCreditKeys: item.bankCreditKeys,
      settlementKeys: item.settlementKeys,
    },
    // The working, kept. An exception without it hands a human a mystery and throws away
    // the reasoning that would have made it a minute's work (ADR-0045).
    considered: item.considered.map((candidate) => ({
      candidateId: candidate.candidateId,
      kind: candidate.kind,
      difference: candidate.difference ? asMoney(candidate.difference) : null,
      rejectedBecause: candidate.rejectedBecause,
    })),
    raisedAt: item.raisedAt,
    since: item.since,
    acknowledgedBy: item.acknowledgedBy,
    resolvedCause: item.resolvedCause,
    resolutionKey: item.resolutionKey,
  };
}

export function asSummary(summary: ReconciliationSummary): unknown {
  return {
    from: summary.from,
    to: summary.to,
    totals: summary.totals,
    conclusions: summary.conclusions,
    queue: summary.queue.map((tally) => ({ ...tally, amount: asMoney(tally.amount) })),
    awaitingBankCredit: {
      count: summary.awaitingBankCredit.count,
      expectedNet: asMoney(summary.awaitingBankCredit.expectedNet),
    },
    banked: {
      transactions: summary.banked.transactions,
      credited: asMoney(summary.banked.credited),
    },
  };
}

/**
 * What a run did, rather than everything it looked at.
 *
 * The run object carries every match, every inflow and every rejected candidate it
 * considered — megabytes on a busy day, and none of it is what the caller asked. The
 * conclusions are returned as counts per reason, and the two lists worth having in full are
 * what was booked and what refused to book.
 */
export function asRun(run: ReconciliationRun): unknown {
  return {
    asOf: run.asOf,
    allocated: tally(run.allocation.prepared.map((prepared) => prepared.result)),
    confirmed: tally(run.confirmation.confirmed.map((confirmed) => confirmed.result)),
    deferred: tally(run.deferred),
    exceptions: tally(run.exceptions),
    booked: run.booked,
    failures: run.failures,
    queue: run.queue,
  };
}

function tally(results: readonly MatchResult[]): { reason: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const result of results) counts.set(result.reason, (counts.get(result.reason) ?? 0) + 1);
  return [...counts]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([reason, count]) => ({ reason, count }));
}

export function asDelivery(delivery: DeliveryRecord): unknown {
  return {
    deliveryId: delivery.deliveryId,
    source: delivery.source,
    state: delivery.state,
    attempts: delivery.attempts,
    detail: delivery.detail,
    lastError: delivery.lastError,
    transactionId: delivery.transactionId,
    receivedAt: delivery.receivedAt,
    processedAt: delivery.processedAt,
    // What is still held of the provider's payload, said the same way `GET /evidence/:id`
    // says it. Without this the one question a data-protection request actually asks —
    // "do you still have my details?" — was answerable only by somebody with database
    // access, which is not a service answering it (ADR-0064).
    held: {
      content: delivery.content,
      redactedAt: delivery.redactedAt?.toISOString() ?? null,
    },
  };
}
