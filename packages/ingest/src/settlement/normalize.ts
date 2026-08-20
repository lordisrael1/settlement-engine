import type { ParseResult, StandardizedTransaction } from '@pay-normalize/core';

import type {
  Evidence,
  Payout,
  PaymentChannel,
  RowLineage,
  SettlementAdjustment,
  SettlementLine,
  SettlementStatus,
  SourceId,
} from '@recon/canon';
import { arrayLineage, idempotencyKey } from '@recon/canon';

import { DriftWatch, type DriftNote } from '../drift.js';
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

/**
 * A note on where a *renamed* status actually surfaces, because it is not here.
 *
 * The reflex is to treat "a status we do not recognise" as this file's problem to detect.
 * It is not, and the type says so: `txn.status` is a closed enum by the time it arrives,
 * because each connector maps the provider's own vocabulary and returns a `parse_error` for
 * anything unmapped. So a provider renaming `SUCCESSFUL` to `SUCCESS` never reaches this
 * lookup — it fails one layer earlier and lands in `malformed`, which is the loud counter
 * and the correct one.
 *
 * What reaches the branch below is only `PENDING` and `FAILED`: ordinary rows, arriving every
 * day, correctly filed as not-money. Instrumenting them as drift would alarm on the routine.
 */

export type Normalized =
  | { readonly ok: true; readonly line: SettlementLine }
  /**
   * `drift` is present when the row was refused because a *vocabulary* did not match, as
   * opposed to because the row said something we understood and declined.
   *
   * A USD row is a currency we knowingly do not keep books in; an entry type of `DR` where
   * `debit` was expected is a word nobody has taught us. Both are refusals, both produce an
   * identical-looking `RejectedRow`, and only the second means the format moved. Carried
   * here because the row functions stay pure — they report what they saw and the fold
   * records it.
   */
  | { readonly ok: false; readonly rejected: RejectedRow; readonly drift?: DriftNote };

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
  lineage: RowLineage,
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
      // The rail, as a typed field rather than only as a hint. It decides which fee
      // contract prices this line, and a decision read out of narration is a decision made
      // by a regex (ADR-0010).
      channel: txn.channel as PaymentChannel,
      gross: toMoney(txn.amountInKobo),
      fee: toMoney(txn.feeInKobo),
      net: toMoney(txn.netAmountInKobo),
      status,
      settledAt: txn.settlementDate,
      reasonHints: [`channel:${txn.channel}`, ...hints],
      evidenceId,
      lineage,
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
  lineage: RowLineage,
):
  | { ok: true; payout: Payout }
  | { ok: false; rejected: RejectedRow; drift?: DriftNote } {
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
      lineage,
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
  root = '$',
  watch: DriftWatch = new DriftWatch(source, format),
): SettlementIngestResult {
  const payouts: Payout[] = [];
  const lines: SettlementLine[] = [];
  const rejected: RejectedRow[] = [];

  // Counted before anything is interpreted, and counted whether a row survives or not. This
  // is the denominator every severity judgement rests on, and taking it from the rows that
  // *parsed* would report a file where nothing parsed as a file with nothing wrong with it.
  watch.countRows(rows.length);

  // The index is the row's position in the artifact as parsed, and it is carried whether
  // the row survives or not. "Which file?" was always answerable; "which line of it?" is
  // what actually lets somebody reproduce a conclusion from a five-thousand-row export.
  for (const [index, row] of rows.entries()) {
    const lineage = arrayLineage(index, root);

    if (row.kind === 'parse_error') {
      rejected.push({ kind: 'malformed', reason: row.error.message, raw: row.raw });
      watch.malformedRow(row.error.message, lineage);
      continue;
    }
    if (row.kind === 'unknown_event') {
      rejected.push({
        kind: 'not-a-settlement',
        reason: `unrecognised record type: ${row.eventType}`,
        raw: row.raw,
      });
      // A record type the connector does not know is the same class of news as a status it
      // does not know, and it arrives through a different door. Both are the format having
      // moved; only this one was ever visible, and only as a number nobody watched.
      watch.unknownValue('record_type', row.eventType, lineage);
      continue;
    }

    const interpretation = interpret(row.transaction);

    if (interpretation.as === 'payout') {
      const result = toPayout(
        row.transaction,
        interpretation.adjustments,
        evidence.evidenceId,
        lineage,
      );
      if (result.ok) payouts.push(result.payout);
      else {
        rejected.push(result.rejected);
        if (result.drift) watch.unknownValue(result.drift.field, result.drift.value, lineage);
      }
      continue;
    }

    const normalized = toSettlementLine(
      row.transaction,
      context,
      evidence.evidenceId,
      lineage,
      interpretation.payoutReference,
      interpretation.hints,
    );
    if (normalized.ok) lines.push(normalized.line);
    else {
      rejected.push(normalized.rejected);
      if (normalized.drift) {
        watch.unknownValue(normalized.drift.field, normalized.drift.value, lineage);
      }
    }
  }

  return {
    source,
    format,
    evidence,
    payouts,
    lines,
    rejected,
    anomalies: watch.anomalies(evidence, context.receivedAt),
  };
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
