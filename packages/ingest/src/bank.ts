import type { BankStatementLine, Evidence, RowLineage, SourceId } from '@recon/canon';
import { arrayLineage, idempotencyKey, money } from '@recon/canon';
import { refuseCardData } from '@recon/protect';

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

  const base = {
    bankAccountId: context.bankAccountId,
    format: BANK_STATEMENT_FORMAT,
    evidence,
  };

  let parsed: unknown;
  try {
    parsed = JSON.parse(payload.toString('utf8'));
  } catch (error) {
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
    };
  }

  if (!Array.isArray(parsed)) {
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
    };
  }

  const lines: BankStatementLine[] = [];
  const rejected: RejectedRow[] = [];

  for (const [index, raw] of (parsed as RawStatementRow[]).entries()) {
    const line = toStatementLine(raw, context, evidence.evidenceId, arrayLineage(index));
    if (line.ok) lines.push(line.line);
    else rejected.push(line.rejected);
  }

  return { ...base, lines, rejected };
}

function toStatementLine(
  raw: RawStatementRow,
  context: BankStatementContext,
  evidenceId: string,
  lineage: RowLineage,
): { ok: true; line: BankStatementLine } | { ok: false; rejected: RejectedRow } {
  const reject = (reason: string): { ok: false; rejected: RejectedRow } => ({
    ok: false,
    rejected: { kind: 'malformed', reason, raw },
  });

  const reference = typeof raw.id === 'string' && raw.id !== '' ? raw.id : null;
  if (!reference) return reject('row has no bank transaction id');

  const direction =
    raw.type === 'credit' ? 'credit' : raw.type === 'debit' ? 'debit' : null;
  if (!direction) return reject(`unrecognised entry type: ${String(raw.type)}`);

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
