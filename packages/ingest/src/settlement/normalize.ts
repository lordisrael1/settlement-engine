import type { ParseResult, StandardizedTransaction } from '@pay-normalize/core';

import type { SettlementLine, SettlementStatus, SourceId } from '@recon/canon';
import { idempotencyKey } from '@recon/canon';

import { toMoney } from '../kobo.js';
import type { RejectedRow, SettlementIngestResult } from './types.js';

/**
 * Money that has already moved, in the sources' vocabulary.
 *
 * `PENDING` and `FAILED` are absent by design. A settlement row in either state is not
 * money — it is a statement of intent — and admitting it would let the ledger book cash
 * that never landed. Those rows are rejected as `not-a-settlement`, and the source will
 * report them again with a terminal status when they resolve.
 *
 * `chargeback` has no counterpart upstream: no connector reports a chargeback as a
 * status. It arrives folded into a settlement's deductions, so a chargeback becomes a
 * reason-coded observation for the reconciler rather than a line status here.
 */
const SETTLED_STATUSES: Readonly<Record<string, SettlementStatus>> = {
  SUCCESSFUL: 'settled',
  REVERSED: 'reversed',
};

export type Normalized =
  | { readonly ok: true; readonly line: SettlementLine }
  | { readonly ok: false; readonly rejected: RejectedRow };

/**
 * Map one normalised provider transaction onto a canonical settlement line.
 *
 * Everything source-specific has already happened by this point — the connector did the
 * amount conventions, the timezone rules and the status vocabulary. What is left is the
 * last translation into our language, plus the checks that decide whether this row
 * represents money we can book.
 */
export function toSettlementLine(
  txn: StandardizedTransaction,
  hints: readonly string[] = [],
): Normalized {
  const raw = txn.rawProviderPayload;

  if (txn.currency !== 'NGN') {
    return reject('not-a-settlement', `currency ${txn.currency} — this ledger keeps books in NGN only`, raw);
  }
  if (txn.direction !== 'credit') {
    return reject('not-a-settlement', 'debit row — money leaving, not a settlement of a promise', raw);
  }

  const status = SETTLED_STATUSES[txn.status];
  if (!status) {
    return reject('not-a-settlement', `status ${txn.status} — not money yet`, raw);
  }

  return {
    ok: true,
    line: {
      reference: txn.providerReference,
      source: txn.provider,
      gross: toMoney(txn.amountInKobo),
      fee: toMoney(txn.feeInKobo),
      net: toMoney(txn.netAmountInKobo),
      status,
      settledAt: txn.settlementDate,
      reasonHints: [`channel:${txn.channel}`, ...hints],
      idempotencyKey: idempotencyKey('settlement', txn.dedupeKey),
    },
  };
}

/**
 * Fold a connector's row results into one canonical ingest result.
 *
 * `hintsFor` lets an adapter surface facts that only it can see in the raw payload —
 * a chargeback folded into a fee, say. That is legitimate source-specific knowledge and
 * it belongs here, inside the boundary, expressed as data that travels with the line.
 */
export function fromParseResults(
  source: SourceId,
  format: string,
  rows: readonly ParseResult[],
  hintsFor: (txn: StandardizedTransaction) => readonly string[] = () => [],
): SettlementIngestResult {
  const lines: SettlementLine[] = [];
  const rejected: RejectedRow[] = [];

  for (const row of rows) {
    if (row.kind === 'parse_error') {
      rejected.push({ kind: 'malformed', reason: row.error.message, raw: row.raw });
      continue;
    }
    if (row.kind === 'unknown_event') {
      rejected.push({
        kind: 'not-a-settlement',
        reason: `unrecognised record type: ${row.eventType}`,
        raw: row.raw,
      });
      continue;
    }

    const normalized = toSettlementLine(row.transaction, hintsFor(row.transaction));
    if (normalized.ok) lines.push(normalized.line);
    else rejected.push(normalized.rejected);
  }

  return { source, format, lines, rejected };
}

/** Bytes to JSON, with a malformed-row result instead of a thrown exception. */
export function parseJson(payload: Buffer): { ok: true; value: unknown } | { ok: false; rejected: RejectedRow } {
  const text = payload.toString('utf8');
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (error) {
    return {
      ok: false,
      rejected: {
        kind: 'malformed',
        reason: `payload is not valid JSON: ${error instanceof Error ? error.message : 'unknown'}`,
        raw: text.slice(0, 200),
      },
    };
  }
}

function reject(kind: RejectedRow['kind'], reason: string, raw: unknown): Normalized {
  return { ok: false, rejected: { kind, reason, raw } };
}
