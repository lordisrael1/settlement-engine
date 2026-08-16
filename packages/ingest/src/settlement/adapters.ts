import type { ParseResult, StandardizedTransaction } from '@pay-normalize/core';
import {
  PROVIDER as FLUTTERWAVE,
  parseFlutterwaveSettlementList,
} from '@pay-normalize/flutterwave';
import { PROVIDER as MONNIFY, parseMonnifyTransaction } from '@pay-normalize/monnify';
import { PROVIDER as NOMBA, parseNombaTransactionRecord } from '@pay-normalize/nomba';

import type { AdjustmentKind, SettlementAdjustment } from '@recon/canon';
import { money } from '@recon/canon';

import { evidenceOf } from '../evidence.js';
import { fromParseResults, parseJson, type RowInterpretation } from './normalize.js';
import type {
  SettlementContext,
  SettlementIngestResult,
  SettlementSource,
} from './types.js';

/**
 * Flutterwave settlements, from `GET /settlements`.
 *
 * The richest settlement source available, and the only one that reports **payouts**: each
 * record is one money movement covering a number of charges (`charge_count`), with a typed
 * fee breakdown including the Nigerian stamp duty and, sometimes, a chargeback folded in.
 *
 * It does not enumerate the charges. So each record becomes a `Payout` with named
 * deductions and no settlement lines, and attaching payments to it is the matcher's job —
 * which is exactly the shape that makes many-to-one matching necessary rather than
 * academic.
 */
export const flutterwaveSettlements: SettlementSource = {
  source: FLUTTERWAVE,
  format: 'flutterwave-settlements-api-v4',
  parserVersion: 'flutterwave-settlements/2',

  ingest(payload: Buffer, context: SettlementContext): SettlementIngestResult {
    const evidence = evidenceOf(
      payload,
      { ...context, kind: 'psp_settlement', source: this.source },
      this.parserVersion,
    );

    const json = parseJson(payload);
    if (!json.ok) return failed(this.source, this.format, evidence, json.rejected);

    const parsed = parseFlutterwaveSettlementList(json.value);
    return fromParseResults(
      this.source,
      this.format,
      evidence,
      parsed.rows,
      (txn) => ({ as: 'payout', adjustments: flutterwaveDeductions(txn) }),
      context,
    );
  },
};

/**
 * Nomba transaction records, from its transaction-list API.
 *
 * Nomba reports individual settled transactions rather than the movement that carries
 * them, so these become settlement lines with no payout to belong to. That is strictly
 * less information than Flutterwave gives us, and it shows: the grouping has to be
 * inferred by arithmetic instead of read off the file.
 */
export const nombaSettlements: SettlementSource = {
  source: NOMBA,
  format: 'nomba-transaction-records',
  parserVersion: 'nomba-transactions/2',

  ingest(payload: Buffer, context: SettlementContext): SettlementIngestResult {
    return ingestRowArray(this, payload, context, parseNombaTransactionRecord);
  },
};

/** Monnify transactions, from its transaction/settlement API. Same shape as Nomba's. */
export const monnifySettlements: SettlementSource = {
  source: MONNIFY,
  format: 'monnify-transaction-records',
  parserVersion: 'monnify-transactions/2',

  ingest(payload: Buffer, context: SettlementContext): SettlementIngestResult {
    return ingestRowArray(this, payload, context, parseMonnifyTransaction);
  },
};

/**
 * Flutterwave's own deduction vocabulary, turned into ours.
 *
 * This is the single most valuable thing an adapter does. A settlement whose fee silently
 * includes a clawback is the most misleading row in reconciliation: the arithmetic
 * balances, so nothing looks wrong, while a chargeback has happened and nobody has been
 * told. Splitting the deductions by *kind* means each one books to the account that
 * describes it — stamp duty to tax, a clawback to chargebacks, a hold to reserve — and an
 * unexpected number is a named thing rather than an unusually expensive Tuesday.
 *
 * An unrecognised fee type is booked as a fee and keeps its own label in the narration,
 * rather than being dropped. Losing money quietly is worse than filing it imprecisely.
 */
const FLUTTERWAVE_FEE_KINDS: Readonly<Record<string, AdjustmentKind>> = {
  charge_fee: 'fee',
  merchant_fee: 'fee',
  stamp_duty: 'tax',
  vat: 'tax',
  emt_levy: 'tax',
  penalty: 'penalty',
};

function flutterwaveDeductions(txn: StandardizedTransaction): SettlementAdjustment[] {
  const raw = txn.rawProviderPayload;
  if (typeof raw !== 'object' || raw === null) return [];
  const record = raw as Record<string, unknown>;

  const adjustments: SettlementAdjustment[] = [];

  for (const fee of Array.isArray(record['fees']) ? record['fees'] : []) {
    if (typeof fee !== 'object' || fee === null) continue;
    const entry = fee as { type?: unknown; amount?: unknown };
    const label = typeof entry.type === 'string' ? entry.type : 'unknown';
    const amount = nairaToKobo(entry.amount);
    if (amount === null || amount === 0n) continue;

    adjustments.push({
      kind: FLUTTERWAVE_FEE_KINDS[label.toLowerCase()] ?? 'fee',
      amount: money(amount),
      narration: label,
    });
  }

  for (const [field, kind] of [
    ['chargeback', 'chargeback'],
    ['refund', 'refund'],
    ['reserve', 'reserve'],
    ['reserve_release', 'reserve_release'],
  ] as const) {
    const amount = nairaToKobo(record[field]);
    if (amount === null || amount === 0n) continue;
    adjustments.push({
      kind: kind satisfies AdjustmentKind,
      // A release returns money, so it increases the payout rather than reducing it.
      amount: money(kind === 'reserve_release' ? -amount : amount),
      narration: field,
    });
  }

  return adjustments;
}

/**
 * Naira, as these files express it, into integer kobo.
 *
 * String math only — a `parseFloat` here would turn ₦5,000.10 into 500009.999… and
 * manufacture the very one-kobo discrepancies the reconciler exists to eliminate.
 */
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

/** Sources whose API hands the host an array of records rather than one envelope. */
function ingestRowArray(
  adapter: SettlementSource,
  payload: Buffer,
  context: SettlementContext,
  parseRow: (record: unknown) => ParseResult,
): SettlementIngestResult {
  const evidence = evidenceOf(
    payload,
    { ...context, kind: 'psp_settlement', source: adapter.source },
    adapter.parserVersion,
  );

  const json = parseJson(payload);
  if (!json.ok) return failed(adapter.source, adapter.format, evidence, json.rejected);

  if (!Array.isArray(json.value)) {
    return failed(adapter.source, adapter.format, evidence, {
      kind: 'malformed',
      reason: `expected a JSON array of ${adapter.source} records, got ${typeof json.value}`,
      raw: json.value,
    });
  }

  const asLine = (): RowInterpretation => ({
    as: 'line',
    // These sources never name the movement that carries a transaction.
    payoutReference: null,
    hints: [],
  });

  return fromParseResults(
    adapter.source,
    adapter.format,
    evidence,
    json.value.map(parseRow),
    asLine,
    context,
  );
}

function failed(
  source: string,
  format: string,
  evidence: SettlementIngestResult['evidence'],
  rejected: SettlementIngestResult['rejected'][number],
): SettlementIngestResult {
  return { source, format, evidence, payouts: [], lines: [], rejected: [rejected] };
}
