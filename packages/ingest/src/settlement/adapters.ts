import type { ParseResult, StandardizedTransaction } from '@pay-normalize/core';
import {
  PROVIDER as FLUTTERWAVE,
  parseFlutterwaveSettlementList,
} from '@pay-normalize/flutterwave';
import { PROVIDER as MONNIFY, parseMonnifyTransaction } from '@pay-normalize/monnify';
import { PROVIDER as NOMBA, parseNombaTransactionRecord } from '@pay-normalize/nomba';

import type { AdjustmentKind, SettlementAdjustment } from '@recon/canon';
import { arrayLineage, money } from '@recon/canon';

import { DriftWatch, asRecord, unreadFields, type FieldSet } from '../drift.js';
import { evidenceOf } from '../evidence.js';
import { fromParseResults, parseJson, type RowInterpretation } from './normalize.js';
import type {
  SettlementContext,
  SettlementIngestResult,
  SettlementSource,
} from './types.js';

/**
 * Every key this adapter and its connector are known to read.
 *
 * A maintenance obligation, deliberately. TypeScript's own knowledge of these records is
 * erased long before the bytes arrive, so there is nothing to ask at runtime and the list has
 * to be written down. Adding a field to the parser means adding it here; forgetting produces
 * a spurious anomaly that somebody deletes in a minute, which is the failure worth having
 * over the alternative.
 *
 * `meta` is included as read even though nothing reads inside it: it is the provider's own
 * declared bag for things that are not part of the contract, and treating every key that
 * appears in it as news would make this alarm on the provider's ordinary business.
 */
const FLUTTERWAVE_PAYOUT_FIELDS: readonly FieldSet[] = [
  {
    at: '',
    fields: [
      'id',
      'net_amount',
      'gross_amount',
      'currency',
      'meta',
      'status',
      'due_datetime',
      'transaction_datetime',
      'created_datetime',
      'fees',
      'destination',
      'charge_count',
      'chargeback',
      'refund',
      'reserve',
      'reserve_release',
    ],
  },
];

/**
 * Nomba's transaction record, as its connector's schema describes it.
 *
 * Taken from the connector's own schema rather than from a sample file, because a sample
 * shows what one export happened to contain while the schema shows what the parser is
 * prepared to read — and it is the second list that makes "nobody read this key" true.
 */
const NOMBA_RECORD_FIELDS: readonly FieldSet[] = [
  {
    at: '',
    fields: [
      'id',
      'status',
      'amount',
      'fixedCharge',
      'amountCharged',
      'type',
      'entryType',
      'timeCreated',
      'timeUpdated',
      'timeCompleted',
      'walletCurrency',
      'currency',
      'merchantTxRef',
      'rrn',
      'sessionId',
    ],
  },
];

/**
 * Monnify's, which arrives one envelope per row.
 *
 * Both levels are declared. Watching only the envelope would leave the fields that actually
 * carry the money — inside `responseBody` — unwatched, which is where a format change would
 * do its damage.
 */
const MONNIFY_RECORD_FIELDS: readonly FieldSet[] = [
  { at: '', fields: ['requestSuccessful', 'responseMessage', 'responseCode', 'responseBody'] },
  {
    at: 'responseBody',
    fields: [
      'transactionReference',
      'amountPaid',
      'settlementAmount',
      'paymentStatus',
      'paymentMethod',
      'currency',
      'paidOn',
    ],
  },
];

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
  knownFields: FLUTTERWAVE_PAYOUT_FIELDS,

  ingest(payload: Buffer, context: SettlementContext): SettlementIngestResult {
    const evidence = evidenceOf(
      payload,
      { ...context, kind: 'psp_settlement', source: this.source },
      this.parserVersion,
    );
    const watch = new DriftWatch(this.source, this.format);

    const json = parseJson(payload);
    if (!json.ok) {
      watch.unknownShape('payload is not JSON');
      return failed(this.source, this.format, evidence, json.rejected, watch, context);
    }

    // Read the envelope before handing it to the parser, because the parser will simply find
    // no rows if the container has been renamed and report an empty file — which is
    // indistinguishable from a day on which nothing settled, and is the wrong thing to be
    // indistinguishable from.
    const envelope = asRecord(json.value);
    const records = envelope && Array.isArray(envelope['data']) ? envelope['data'] : null;
    if (!records) {
      watch.unknownShape(
        'no $.data array',
        envelope ? `top-level keys: ${Object.keys(envelope).join(', ')}` : typeof json.value,
      );
    } else {
      for (const [index, record] of records.entries()) {
        for (const path of unreadFields(record, FLUTTERWAVE_PAYOUT_FIELDS, '$.data[]')) {
          watch.unknownField(path, arrayLineage(index, '$.data'));
        }
      }
    }

    const parsed = parseFlutterwaveSettlementList(json.value);
    return fromParseResults(
      this.source,
      this.format,
      evidence,
      parsed.rows,
      (txn) => ({ as: 'payout', adjustments: flutterwaveDeductions(txn, watch) }),
      context,
      // The rows live under the envelope's `data` array, so that is where a reader looking
      // for row 3 has to look. A locator that names the wrong container is worse than none.
      '$.data',
      watch,
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

  knownFields: NOMBA_RECORD_FIELDS,

  ingest(payload: Buffer, context: SettlementContext): SettlementIngestResult {
    return ingestRowArray(this, payload, context, parseNombaTransactionRecord);
  },
};

/** Monnify transactions, from its transaction/settlement API. Same shape as Nomba's. */
export const monnifySettlements: SettlementSource = {
  source: MONNIFY,
  format: 'monnify-transaction-records',
  parserVersion: 'monnify-transactions/2',

  knownFields: MONNIFY_RECORD_FIELDS,

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

function flutterwaveDeductions(
  txn: StandardizedTransaction,
  watch: DriftWatch,
): SettlementAdjustment[] {
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

    const kind = FLUTTERWAVE_FEE_KINDS[label.toLowerCase()];
    if (!kind) {
      // The fallback below is right and stays: the money is real, so it books as a fee and
      // keeps its label rather than being dropped. But booking it correctly is not the same
      // as understanding it. A new deduction type absorbed into `fee` forever is a permanent
      // small overstatement of what this source charges, arriving as a fee variance that
      // nobody can trace back to the afternoon it started.
      watch.unknownValue('fees[].type', label);
    }

    adjustments.push({
      kind: kind ?? 'fee',
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
  const watch = new DriftWatch(adapter.source, adapter.format);

  const json = parseJson(payload);
  if (!json.ok) {
    watch.unknownShape('payload is not JSON');
    return failed(adapter.source, adapter.format, evidence, json.rejected, watch, context);
  }

  if (!Array.isArray(json.value)) {
    // Already an error, and now also a *recorded* one. A source that starts wrapping its
    // rows in an envelope is the single most likely format change these two adapters will
    // ever see, and it deserves a record with a history rather than a 4xx somebody's cron
    // job swallows.
    watch.unknownShape(`expected a bare array, got ${typeof json.value}`);
    return failed(
      adapter.source,
      adapter.format,
      evidence,
      {
        kind: 'malformed',
        reason: `expected a JSON array of ${adapter.source} records, got ${typeof json.value}`,
        raw: json.value,
      },
      watch,
      context,
    );
  }

  for (const [index, record] of json.value.entries()) {
    for (const path of unreadFields(record, adapter.knownFields, '$[]')) {
      watch.unknownField(path, arrayLineage(index));
    }
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
    // A bare array: row 3 is `$[3]`.
    '$',
    watch,
  );
}

function failed(
  source: string,
  format: string,
  evidence: SettlementIngestResult['evidence'],
  rejected: SettlementIngestResult['rejected'][number],
  watch: DriftWatch,
  context: SettlementContext,
): SettlementIngestResult {
  return {
    source,
    format,
    evidence,
    payouts: [],
    lines: [],
    rejected: [rejected],
    anomalies: watch.anomalies(evidence, context.receivedAt),
  };
}
