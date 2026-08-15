import type { ParseResult, StandardizedTransaction } from '@pay-normalize/core';
import {
  PROVIDER as FLUTTERWAVE,
  parseFlutterwaveSettlementList,
} from '@pay-normalize/flutterwave';
import { PROVIDER as MONNIFY, parseMonnifyTransaction } from '@pay-normalize/monnify';
import { PROVIDER as NOMBA, parseNombaTransactionRecord } from '@pay-normalize/nomba';

import { fromParseResults, parseJson } from './normalize.js';
import type { SettlementIngestResult, SettlementSource } from './types.js';

/**
 * Flutterwave settlements, from `GET /settlements`.
 *
 * The richest settlement source available: it carries a real settlement date
 * (`due_datetime`) and a typed fee breakdown including the Nigerian EMT levy. A
 * settlement here is a *batch* — one money movement covering many charges — which is
 * exactly the shape that makes the reconciler's many-to-one matching necessary rather
 * than academic.
 */
export const flutterwaveSettlements: SettlementSource = {
  source: FLUTTERWAVE,
  format: 'flutterwave-settlements-api-v4',

  ingest(payload: Buffer): SettlementIngestResult {
    const json = parseJson(payload);
    if (!json.ok) return failed(this.source, this.format, json.rejected);

    const parsed = parseFlutterwaveSettlementList(json.value);
    return fromParseResults(this.source, this.format, parsed.rows, deductionHints);
  },
};

/**
 * Nomba transaction records, from its transaction-list API.
 *
 * Nomba's connector reports these as individual records rather than a settlement batch,
 * so the payload is the array of records the host fetched. Its settlement export format
 * is not fixture-verified upstream, so this is the honest way in.
 */
export const nombaSettlements: SettlementSource = {
  source: NOMBA,
  format: 'nomba-transaction-records',

  ingest(payload: Buffer): SettlementIngestResult {
    return ingestRowArray(this.source, this.format, payload, parseNombaTransactionRecord);
  },
};

/** Monnify transactions, from its transaction/settlement API. */
export const monnifySettlements: SettlementSource = {
  source: MONNIFY,
  format: 'monnify-transaction-records',

  ingest(payload: Buffer): SettlementIngestResult {
    return ingestRowArray(this.source, this.format, payload, parseMonnifyTransaction);
  },
};

/**
 * Surface deductions that Flutterwave folds into the fee.
 *
 * A settlement whose fee silently includes a clawback is the single most misleading row
 * in reconciliation: the arithmetic balances, so nothing looks wrong, while a chargeback
 * has happened and nobody has been told. The connector preserves the breakdown in the
 * raw payload; this lifts it into a hint that travels with the line, so the reconciler
 * can reach for `CHARGEBACK` instead of shrugging at a large `FEE_VARIANCE`.
 */
function deductionHints(txn: StandardizedTransaction): readonly string[] {
  const raw = txn.rawProviderPayload;
  if (typeof raw !== 'object' || raw === null) return [];

  const record = raw as Record<string, unknown>;
  const hints: string[] = [];
  if (isPositiveAmount(record['chargeback'])) hints.push('deduction:chargeback');
  if (isPositiveAmount(record['refund'])) hints.push('deduction:refund');
  return hints;
}

function isPositiveAmount(value: unknown): boolean {
  if (typeof value === 'number') return value > 0;
  if (typeof value === 'string' && value.trim() !== '') return Number(value.replace(/,/g, '')) > 0;
  return false;
}

/** Sources whose API hands the host an array of records rather than one envelope. */
function ingestRowArray(
  source: string,
  format: string,
  payload: Buffer,
  parseRow: (record: unknown) => ParseResult,
): SettlementIngestResult {
  const json = parseJson(payload);
  if (!json.ok) return failed(source, format, json.rejected);

  if (!Array.isArray(json.value)) {
    return failed(source, format, {
      kind: 'malformed',
      reason: `expected a JSON array of ${source} records, got ${typeof json.value}`,
      raw: json.value,
    });
  }

  return fromParseResults(source, format, json.value.map(parseRow));
}

function failed(
  source: string,
  format: string,
  rejected: SettlementIngestResult['rejected'][number],
): SettlementIngestResult {
  return { source, format, lines: [], rejected: [rejected] };
}
