import { createHmac } from 'node:crypto';

import { buildNombaCanonicalString, signNombaCanonicalString } from '@pay-normalize/nomba';

import type { SourceId } from '@recon/canon';

import { naira, type SimulatedDelivery } from './scenario.js';

/**
 * The providers, impersonated.
 *
 * This file branches on a source's name, and it is the only file in the repository outside
 * `packages/ingest` that is allowed to — for the same reason `apps/pipeline`'s demo signer
 * is: here we are *being* four remote systems that have no reason to agree with each other,
 * not processing their data. Paystack signs HMAC-SHA512 over the raw body in hex;
 * Flutterwave HMAC-SHA256 in base64; Nomba HMAC-SHA256 over a colon-joined canonical string
 * that does not include the amount. Four providers, four schemes — which is precisely why
 * verifying them lives in a library and not in anybody's head.
 *
 * Nomba's canonical string is built with Nomba's own exported helpers rather than
 * reimplemented here. A second implementation of a signing scheme is a second thing that can
 * be wrong, and a simulator whose signatures are wrong tests the 401 path very thoroughly
 * and nothing else.
 */

/** Bytes, signed. The signature is over exactly these bytes and no re-serialisation. */
export function signed(
  source: SourceId,
  body: unknown,
  secret: string,
  reference: string,
): SimulatedDelivery {
  const bytes = Buffer.from(JSON.stringify(body), 'utf8');

  switch (source) {
    case 'paystack':
      return {
        source,
        reference,
        body: bytes,
        headers: {
          'content-type': 'application/json',
          'x-paystack-signature': createHmac('sha512', secret).update(bytes).digest('hex'),
        },
      };

    case 'flutterwave':
      return {
        source,
        reference,
        body: bytes,
        headers: {
          'content-type': 'application/json',
          'flutterwave-signature': createHmac('sha256', secret).update(bytes).digest('base64'),
        },
      };

    case 'nomba': {
      const envelope = body as NombaWebhook;
      const stamp = envelope.data.transaction.time;
      const signature = signNombaCanonicalString(
        buildNombaCanonicalString({
          eventType: envelope.event_type,
          requestId: envelope.requestId,
          merchantUserId: envelope.data.merchant.userId,
          merchantWalletId: envelope.data.merchant.walletId,
          transactionId: envelope.data.transaction.transactionId,
          transactionType: envelope.data.transaction.type,
          transactionTime: envelope.data.transaction.time,
          responseCode: envelope.data.transaction.responseCode,
          // Nomba signs the send time from the *header*, binding each delivery to when it
          // was sent. The simulator has no separate send time to offer, so the transaction's
          // own instant stands in — deterministically, which a real clock would not be.
          nombaTimestamp: stamp,
        }),
        secret,
      );
      return {
        source,
        reference,
        body: bytes,
        headers: {
          'content-type': 'application/json',
          'nomba-signature': signature,
          'nomba-timestamp': stamp,
        },
      };
    }

    default:
      throw new Error(
        `The simulator cannot impersonate "${source}". Adding one means adding its ` +
          `signing scheme here, beside the three that already differ from each other.`,
      );
  }
}

interface NombaWebhook {
  readonly event_type: string;
  readonly requestId: string;
  readonly data: {
    readonly merchant: { readonly userId: string; readonly walletId: string };
    readonly transaction: {
      readonly transactionId: string;
      readonly transactionAmount: string;
      readonly fee: string;
      readonly type: string;
      readonly time: string;
      readonly responseCode: string;
    };
  };
}

// ── The three wire formats ──────────────────────────────────────────────────

/** A Flutterwave `charge.completed` delivery: the promise, as Flutterwave phrases it. */
export function flutterwaveCharge(input: {
  readonly chargeId: string;
  readonly reference: string;
  readonly grossKobo: bigint;
  readonly occurredAt: Date;
  readonly channel: string;
}): unknown {
  return {
    type: 'charge.completed',
    webhook_id: `wbk_${input.chargeId}`,
    timestamp: input.occurredAt.getTime(),
    data: {
      id: input.chargeId,
      amount: naira(input.grossKobo),
      currency: 'NGN',
      status: 'succeeded',
      reference: input.reference,
      created_datetime: input.occurredAt.toISOString(),
      payment_method: { type: input.channel },
    },
  };
}

/** A Nomba `payment_success` delivery. The amount is famously not covered by the signature. */
export function nombaPayment(input: {
  readonly transactionId: string;
  readonly grossKobo: bigint;
  readonly feeKobo: bigint;
  readonly occurredAt: Date;
}): unknown {
  return {
    event_type: 'payment_success',
    requestId: `req_${input.transactionId}`,
    data: {
      merchant: { userId: 'usr_simulated', walletId: 'wal_simulated' },
      transaction: {
        transactionId: input.transactionId,
        transactionAmount: naira(input.grossKobo),
        fee: naira(input.feeKobo),
        type: 'card_transaction',
        time: input.occurredAt.toISOString(),
        responseCode: '00',
      },
    },
  };
}

/**
 * One row of a Flutterwave settlements export.
 *
 * The deductions are itemised by *type*, which is the single most valuable thing this file
 * format does: a settlement whose fee silently includes a clawback is the most misleading
 * row in reconciliation, because the arithmetic balances while a chargeback has happened and
 * nobody has been told.
 */
export interface SettlementRow {
  readonly payoutReference: string;
  readonly grossKobo: bigint;
  readonly feeKobo: bigint;
  readonly vatKobo: bigint;
  readonly chargebackKobo: bigint;
  readonly reportedAt: Date;
  readonly valueDate: Date;
  readonly chargeCount: number;
}

export function flutterwaveSettlementFile(rows: readonly SettlementRow[]): Buffer {
  const body = {
    status: 'success',
    message: 'Settlements fetched',
    meta: { page_info: { total: rows.length, current_page: 1, total_pages: 1 } },
    data: rows.map((row) => ({
      id: row.payoutReference,
      gross_amount: naira(row.grossKobo),
      net_amount: naira(
        row.grossKobo - row.feeKobo - row.vatKobo - row.chargebackKobo,
      ),
      currency: 'NGN',
      status: 'completed',
      // A zero fee is dropped by the adapter rather than booked as a zero entry, so
      // emitting one is safe and keeps the file shaped like a real export.
      fees: [
        { type: 'charge_fee', amount: naira(row.feeKobo) },
        { type: 'vat', amount: naira(row.vatKobo) },
      ],
      ...(row.chargebackKobo > 0n ? { chargeback: naira(row.chargebackKobo) } : {}),
      due_datetime: row.valueDate.toISOString(),
      transaction_datetime: row.reportedAt.toISOString(),
      created_datetime: row.reportedAt.toISOString(),
      destination: 'bank',
      charge_count: String(row.chargeCount),
    })),
  };
  return Buffer.from(JSON.stringify(body, null, 2), 'utf8');
}

/**
 * One row of a Nomba transaction list.
 *
 * Nomba reports individual transactions and never names the movement that carries them,
 * which is strictly less information than Flutterwave gives us — and is why a reversal has
 * to be recognised from the row's own status rather than read off a payout.
 *
 * Its money fields must agree: `amountCharged == amount + fixedCharge`, checked by the
 * connector, which refuses to guess which one is authoritative when they do not.
 */
export interface NombaRow {
  readonly transactionId: string;
  readonly netKobo: bigint;
  readonly feeKobo: bigint;
  readonly occurredAt: Date;
  readonly status: 'SUCCESS' | 'REVERSED';
}

export function nombaTransactionFile(rows: readonly NombaRow[]): Buffer {
  return Buffer.from(
    JSON.stringify(
      rows.map((row) => ({
        id: row.transactionId,
        status: row.status,
        amount: naira(row.netKobo),
        fixedCharge: naira(row.feeKobo),
        amountCharged: naira(row.netKobo + row.feeKobo),
        type: 'card_transaction',
        entryType: 'CREDIT',
        timeCreated: row.occurredAt.toISOString(),
        timeCompleted: row.occurredAt.toISOString(),
        walletCurrency: 'NGN',
      })),
      null,
      2,
    ),
    'utf8',
  );
}

/**
 * One row of a bank statement, in the canonical shape this system expects a bank export to
 * have been converted into.
 *
 * The narration is the only thing linking a credit to a payout for most Nigerian banks, and
 * it is truncated, inconsistent and occasionally absent — so the simulator writes it the way
 * a bank does, and lets the matcher decide what the tokens in it mean.
 */
export interface StatementRow {
  readonly id: string;
  readonly amountKobo: bigint;
  readonly direction: 'credit' | 'debit';
  readonly valueDate: Date;
  readonly narration: string;
}

export function bankStatementFile(rows: readonly StatementRow[]): Buffer {
  return Buffer.from(
    JSON.stringify(
      rows.map((row) => ({
        id: row.id,
        date: row.valueDate.toISOString(),
        amount: naira(row.amountKobo),
        type: row.direction,
        narration: row.narration,
      })),
      null,
      2,
    ),
    'utf8',
  );
}
