import type {
  BankStatementLine,
  Evidence,
  IngestAnomaly,
  RowLineage,
  SourceId,
} from '@recon/canon';
import { arrayLineage, idempotencyKey, money } from '@recon/canon';
import { refuseCardData } from '@recon/protect';

import { DriftWatch, unreadFields, type DriftNote, type FieldSet } from './drift.js';
import { evidenceOf, type EvidenceContext } from './evidence.js';
import type { RejectedRow } from './settlement/types.js';

/**
 * The bank half of the ingest boundary.
 *
 * There is no `pay-normalize` for bank statements, and there could not be a single one:
 * every Nigerian bank exports a different CSV, most of them without a stable header row,
 * and several change it without notice. So this defines **one** canonical statement shape
 * and expects the caller to have converted into it — the same anti-corruption discipline
 * as the PSP half, with the conversion step left where the per-bank knowledge lives.
 *
 * What this layer owns, and what makes it worth having:
 *
 *   **Narration is tokenised, not interpreted.** The parser extracts every candidate
 *   identifier it can see and stops. Deciding that `FLW/STTL/2026 stm_7QpLd` names a
 *   particular payout is the matcher's job, done against payouts we actually hold — never
 *   a regex quietly picking one.
 *
 *   **Debits are kept.** A returned payout and a chargeback both arrive as debits, and a
 *   parser that filtered them out would make the two most alarming bank events invisible.
 */
export const BANK_STATEMENT_FORMAT = 'recon-bank-statement-v1';
export const BANK_PARSER_VERSION = 'bank-statement/1';

export interface BankStatementIngestResult {
  readonly bankAccountId: string;
  readonly format: string;
  readonly evidence: Evidence;
  readonly lines: readonly BankStatementLine[];
  readonly rejected: readonly RejectedRow[];
  /**
   * Ways this statement was not the statement we expected.
   *
   * Bank exports are the loosest format this system touches — no stable header row, no
   * version, and a human clicking Export in a banking portal at the other end. They are also
   * the only evidence that can book cash (ADR-0027), so a column that moved here is worth
   * more than a column that moved anywhere else.
   */
  readonly anomalies: readonly IngestAnomaly[];
}

export interface BankStatementContext extends Omit<EvidenceContext, 'kind' | 'source'> {
  /** Which of our accounts this statement covers. */
  readonly bankAccountId: string;
  /**
   * The bank, as a source id. Not a PSP — but it is a party that sends us records, and
   * giving it the same kind of identifier keeps evidence and matching uniform.
   */
  readonly bank: SourceId;
}

/**
 * A statement row, as this system expects to receive it.
 *
 * Amounts are decimal-string naira, because that is what every bank export contains and
 * converting once here — with string math, never a float — is the whole point of a
 * boundary (integer kobo).
 */
interface RawStatementRow {
  readonly id?: unknown;
  readonly date?: unknown;
  readonly amount?: unknown;
  readonly type?: unknown;
  readonly narration?: unknown;
  readonly balance?: unknown;
  readonly reference?: unknown;
}

export function ingestBankStatement(
  payload: Buffer,
  context: BankStatementContext,
): BankStatementIngestResult {
  // A statement is the one artifact here that a human exported by hand from a banking
  // portal, which is exactly how the wrong export gets uploaded. Refused before an evidence
  // record exists, so there is nothing to go back and delete (ADR-0066).
  refuseCardData(payload, `This ${context.bank} statement`);

  const evidence = evidenceOf(
    payload,
    { ...context, kind: 'bank_statement', source: context.bank },
    BANK_PARSER_VERSION,
  );

  const watch = new DriftWatch(context.bank, BANK_STATEMENT_FORMAT);
  const base = {
    bankAccountId: context.bankAccountId,
    format: BANK_STATEMENT_FORMAT,
    evidence,
  };

  let parsed: unknown;
  try {
    parsed = JSON.parse(payload.toString('utf8'));
  } catch (error) {
    watch.unknownShape('payload is not JSON');
    return {
      ...base,
      lines: [],
      rejected: [
        {
          kind: 'malformed',
          reason: `statement is not valid JSON: ${error instanceof Error ? error.message : 'unknown'}`,
          raw: payload.toString('utf8').slice(0, 200),
        },
      ],
      anomalies: watch.anomalies(evidence, context.receivedAt),
    };
  }

  if (!Array.isArray(parsed)) {
    watch.unknownShape(`expected a bare array, got ${typeof parsed}`);
    return {
      ...base,
      lines: [],
      rejected: [
        {
          kind: 'malformed',
          reason: `expected a JSON array of statement rows, got ${typeof parsed}`,
          raw: parsed,
        },
      ],
      anomalies: watch.anomalies(evidence, context.receivedAt),
    };
  }

  const lines: BankStatementLine[] = [];
  const rejected: RejectedRow[] = [];

  watch.countRows(parsed.length);

  for (const [index, raw] of (parsed as RawStatementRow[]).entries()) {
    const lineage = arrayLineage(index);

    // A column the converter added and this parser never read. On a bank statement that is
    // the most likely drift of all: the conversion step that produces this shape lives
    // wherever the per-bank knowledge is, and it changes when the bank's export changes,
    // which is precisely when nobody thinks to tell the reconciler.
    for (const path of unreadFields(raw, BANK_ROW_FIELDS, '$[]')) {
      watch.unknownField(path, lineage);
    }

    const line = toStatementLine(raw, context, evidence.evidenceId, lineage);
    if (line.ok) {
      lines.push(line.line);
      continue;
    }
    rejected.push(line.rejected);
    if (line.drift) watch.unknownValue(line.drift.field, line.drift.value, lineage);
    else watch.malformedRow(line.rejected.reason, lineage);
  }

  return { ...base, lines, rejected, anomalies: watch.anomalies(evidence, context.receivedAt) };
}

/**
 * The columns this parser reads.
 *
 * Short, because the canonical statement shape is deliberately small — the per-bank variety
 * is absorbed by whoever converts into it. That is what makes an unread key here meaningful:
 * anything outside this list is something the converter thought worth sending and this parser
 * has been silently discarding.
 */
const BANK_ROW_FIELDS: readonly FieldSet[] = [
  { at: '', fields: ['id', 'date', 'amount', 'type', 'narration', 'balance', 'reference'] },
];

function toStatementLine(
  raw: RawStatementRow,
  context: BankStatementContext,
  evidenceId: string,
  lineage: RowLineage,
):
  | { ok: true; line: BankStatementLine }
  | { ok: false; rejected: RejectedRow; drift?: DriftNote } {
  const reject = (reason: string): { ok: false; rejected: RejectedRow } => ({
    ok: false,
    rejected: { kind: 'malformed', reason, raw },
  });

  const reference = typeof raw.id === 'string' && raw.id !== '' ? raw.id : null;
  if (!reference) return reject('row has no bank transaction id');

  const direction =
    raw.type === 'credit' ? 'credit' : raw.type === 'debit' ? 'debit' : null;
  if (!direction) {
    // A vocabulary, not a broken row. `DR`/`CR`, `Debit`/`Credit`, or a bank that started
    // signing the amount instead of naming a direction are all format changes wearing the
    // costume of a bad row — and a statement whose every row fails this check has had its
    // direction column redefined, which is the one thing on a statement that must never be
    // guessed at.
    return {
      ok: false,
      rejected: { kind: 'malformed', reason: `unrecognised entry type: ${String(raw.type)}`, raw },
      drift: { field: 'type', value: raw.type },
    };
  }

  const amount = nairaToKobo(raw.amount);
  if (amount === null) return reject(`unparseable amount: ${String(raw.amount)}`);
  if (amount < 0n) {
    // Direction already carries the sign. A negative amount alongside it means two
    // conventions in one row, and guessing which one wins is how money changes sign.
    return reject('negative amount on a row that also states a direction');
  }

  const valueDate = typeof raw.date === 'string' ? new Date(raw.date) : new Date(NaN);
  if (Number.isNaN(valueDate.getTime())) return reject(`unparseable date: ${String(raw.date)}`);

  const narration = typeof raw.narration === 'string' ? raw.narration : '';
  const balance = nairaToKobo(raw.balance);

  return {
    ok: true,
    line: {
      reference,
      bankAccountId: context.bankAccountId,
      direction,
      amount: money(amount),
      balanceAfter: balance === null ? null : money(balance),
      valueDate,
      narration,
      narrationTokens: tokenise(narration),
      statedReference:
        typeof raw.reference === 'string' && raw.reference !== '' ? raw.reference : null,
      evidenceId,
      lineage,
      idempotencyKey: idempotencyKey('bank', `${context.bank}:${reference}`),
    },
  };
}

/**
 * Every run of six or more reference-shaped characters in the narration, uppercased.
 *
 * Underscores and hyphens are included because real PSP references are full of them —
 * `stm_7QpLd2Rk9x`, `FLW-REF-889` — and splitting on them would shatter exactly the
 * identifiers this exists to find.
 *
 * Six is a judgement, not a truth: shorter runs are overwhelmingly words (`FLW`, `TRF`,
 * `SETTLE`) and matching on them would attach unrelated payouts to each other by
 * coincidence. It lives here rather than in the matcher so that changing it is one edit
 * with one test.
 */
function tokenise(narration: string): string[] {
  return [...new Set(narration.toUpperCase().match(/[A-Z0-9][A-Z0-9_-]{5,}/g) ?? [])];
}

/** Decimal-string naira into integer kobo, with string math only (integer kobo). */
function nairaToKobo(value: unknown): bigint | null {
  const text =
    typeof value === 'number'
      ? value.toString()
      : typeof value === 'string'
        ? value.replace(/,/g, '').trim()
        : null;
  if (text === null || text === '' || !/^-?\d+(\.\d{1,2})?$/.test(text)) return null;

  const negative = text.startsWith('-');
  const [whole = '0', fraction = ''] = (negative ? text.slice(1) : text).split('.');
  const kobo = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
  return negative ? -kobo : kobo;
}
