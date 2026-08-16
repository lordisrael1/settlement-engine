import type { ParseResult, StandardizedTransaction } from '@pay-normalize/core';

import type {
  Evidence,
  Payout,
  SettlementAdjustment,
  SettlementLine,
  SettlementStatus,
  SourceId,
} from '@recon/canon';
import { idempotencyKey } from '@recon/canon';

import { toMoney } from '../kobo.js';
import type { RejectedRow, SettlementContext, SettlementIngestResult } from './types.js';

/**
 * Money that has already moved, in the sources' vocabulary.
 *
 * `PENDING` and `FAILED` are absent by design. A settlement row in either state is not
 * money — it is a statement of intent — and admitting it would let the ledger book cash
 * that never landed. Those rows are rejected as `not-a-settlement`, and the source will
 * report them again with a terminal status when they resolve.
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
  context: SettlementContext,
  evidenceId: string,
  payoutReference: string | null,
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
      payoutReference,
      merchantId: context.merchantId,
      gross: toMoney(txn.amountInKobo),
      fee: toMoney(txn.feeInKobo),
      net: toMoney(txn.netAmountInKobo),
      status,
      settledAt: txn.settlementDate,
      reasonHints: [`channel:${txn.channel}`, ...hints],
      evidenceId,
      idempotencyKey: idempotencyKey('settlement', txn.dedupeKey),
    },
  };
}

/**
 * Map one normalised provider settlement onto a canonical payout.
 *
 * `expectedNet` is taken from the provider verbatim rather than recomputed from the
 * adjustments. Recomputing it and trusting our own answer would hide exactly the
 * disagreement that matters — a report whose declared net does not equal its own itemised
 * deductions has something in it nobody has told us about, and `payoutArithmetic` in
 * `@recon/canon` exists to surface that rather than paper over it.
 */
export function toPayout(
  txn: StandardizedTransaction,
  adjustments: readonly SettlementAdjustment[],
  evidenceId: string,
): { ok: true; payout: Payout } | { ok: false; rejected: RejectedRow } {
  const raw = txn.rawProviderPayload;

  if (txn.currency !== 'NGN') {
    return {
      ok: false,
      rejected: {
        kind: 'not-a-settlement',
        reason: `currency ${txn.currency} — this ledger keeps books in NGN only`,
        raw,
      },
    };
  }
  if (!SETTLED_STATUSES[txn.status]) {
    return {
      ok: false,
      rejected: {
        kind: 'not-a-settlement',
        reason: `status ${txn.status} — the payout has not been reported as sent`,
        raw,
      },
    };
  }

  return {
    ok: true,
    payout: {
      payoutReference: txn.providerReference,
      source: txn.provider,
      // Reported, never confirmed. Only a bank statement can move it on.
      status: 'reported',
      gross: toMoney(txn.amountInKobo),
      expectedNet: toMoney(txn.netAmountInKobo),
      adjustments,
      reportedAt: txn.occurredAt,
      valueDate: txn.settlementDate,
      evidenceId,
      idempotencyKey: idempotencyKey('payout', txn.dedupeKey),
    },
  };
}

/**
 * Fold a connector's row results into canonical records.
 *
 * `interpret` is the adapter's one hook into the raw payload — the place a source's own
 * knowledge is turned into typed canonical data. That is legitimate source-specific
 * knowledge and it belongs here, inside the boundary, expressed as structure that travels
 * with the record rather than as narration a downstream reader would have to parse.
 */
export function fromParseResults(
  source: SourceId,
  format: string,
  evidence: Evidence,
  rows: readonly ParseResult[],
  interpret: (txn: StandardizedTransaction) => RowInterpretation,
  context: SettlementContext,
): SettlementIngestResult {
  const payouts: Payout[] = [];
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

    const interpretation = interpret(row.transaction);

    if (interpretation.as === 'payout') {
      const result = toPayout(row.transaction, interpretation.adjustments, evidence.evidenceId);
      if (result.ok) payouts.push(result.payout);
      else rejected.push(result.rejected);
      continue;
    }

    const normalized = toSettlementLine(
      row.transaction,
      context,
      evidence.evidenceId,
      interpretation.payoutReference,
      interpretation.hints,
    );
    if (normalized.ok) lines.push(normalized.line);
    else rejected.push(normalized.rejected);
  }

  return { source, format, evidence, payouts, lines, rejected };
}

/**
 * What the adapter decided a row is.
 *
 * A source reports either the movement or the payments inside it, and which one it is
 * changes everything downstream — so the adapter says so explicitly rather than leaving
 * the matcher to infer it from which fields happen to be populated.
 */
export type RowInterpretation =
  | { readonly as: 'payout'; readonly adjustments: readonly SettlementAdjustment[] }
  | {
      readonly as: 'line';
      readonly payoutReference: string | null;
      readonly hints: readonly string[];
    };

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
