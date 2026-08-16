import { fileURLToPath } from 'node:url';

import type {
  BankStatementLine,
  Evidence,
  FeeContract,
  MatchResult,
  MerchantId,
  Money,
  Payout,
  Resolution,
  SettlementAdjustment,
  SettlementLine,
  SourceId,
  TransactionId,
} from '@recon/canon';
import { money, ZERO } from '@recon/canon';
import type { Executor } from '@recon/ledger-core';
import { inTransaction } from '@recon/ledger-core';

import type { ExpectedInflow, InflowAllocation } from './inflow.js';

/** This package's migrations. Passed to `runMigrations` alongside the ledger's own. */
export const RECONCILER_MIGRATIONS_DIR = fileURLToPath(new URL('../migrations/', import.meta.url));

export interface Stored {
  readonly stored: number;
  readonly duplicates: number;
}

const NGN = 'NGN' as const;

/**
 * Money in and out of the database, as text.
 *
 * A `BIGINT` must never round-trip through a JS number and a JSON number is a double, so
 * every amount crosses this boundary as a string and is cast on the way in (Law 3).
 */
const kobo = (amount: Money): string => amount.kobo.toString();
const fromKobo = (text: string | null): Money => money(BigInt(text ?? '0'));

// ── Evidence ────────────────────────────────────────────────────────────────

/**
 * Record the file a batch of records came from, keeping the bytes.
 *
 * Content-addressed, so re-uploading the same export is resolved by the primary key rather
 * than by remembering. `raw` is what makes a reconciliation reproducible instead of merely
 * recorded — a deployment with retention limits truncates the column later and keeps the
 * hash forever.
 */
export async function recordEvidence(
  db: Executor,
  evidence: Evidence,
  raw: Buffer | null,
): Promise<Stored> {
  const result = await db.query(
    `INSERT INTO evidence
            (evidence_id, kind, source, filename, byte_length, received_from,
             received_at, parser_version, raw)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (evidence_id) DO NOTHING`,
    [
      evidence.evidenceId,
      evidence.kind,
      evidence.source,
      evidence.filename,
      evidence.byteLength,
      evidence.receivedFrom,
      evidence.receivedAt,
      evidence.parserVersion,
      raw,
    ],
  );
  const stored = result.rowCount ?? 0;
  return { stored, duplicates: 1 - stored };
}

// ── Fee contracts ───────────────────────────────────────────────────────────

export async function saveFeeContract(db: Executor, contract: FeeContract): Promise<void> {
  await db.query(
    `INSERT INTO fee_contracts
            (contract_id, source, merchant_id, effective_from, effective_to,
             percent_bp, flat_kobo, flat_waived_below_kobo, cap_kobo, vat_bp,
             approved_by, approved_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7::bigint, $8::bigint, $9::bigint, $10, $11, $12)
     ON CONFLICT (contract_id) DO NOTHING`,
    [
      contract.contractId,
      contract.source,
      contract.merchantId,
      contract.effectiveFrom,
      contract.effectiveTo,
      contract.rateCard.percentBasisPoints,
      contract.rateCard.flatKobo.toString(),
      contract.rateCard.flatWaivedBelowKobo?.toString() ?? null,
      contract.rateCard.capKobo?.toString() ?? null,
      contract.rateCard.vatBasisPoints,
      contract.approvedBy,
      contract.approvedAt,
    ],
  );
}

/**
 * Every contract we hold for one merchant and source, newest first.
 *
 * Ordered so that `contractAt` finds the most recently effective match first, though the
 * exclusion constraint means at most one can ever contain a given instant anyway.
 */
export async function loadFeeContracts(
  db: Executor,
  source: SourceId,
  merchantId: MerchantId,
): Promise<FeeContract[]> {
  const result = await db.query<{
    contract_id: string;
    source: string;
    merchant_id: string;
    effective_from: Date;
    effective_to: Date | null;
    percent_bp: number;
    flat_kobo: string;
    flat_waived_below_kobo: string | null;
    cap_kobo: string | null;
    vat_bp: number;
    approved_by: string;
    approved_at: Date;
  }>(
    `SELECT contract_id, source, merchant_id, effective_from, effective_to,
            percent_bp, flat_kobo::text, flat_waived_below_kobo::text, cap_kobo::text,
            vat_bp, approved_by, approved_at
       FROM fee_contracts
      WHERE source = $1 AND merchant_id = $2
      ORDER BY effective_from DESC`,
    [source, merchantId],
  );

  return result.rows.map((row) => ({
    contractId: row.contract_id,
    source: row.source,
    merchantId: row.merchant_id,
    effectiveFrom: row.effective_from,
    effectiveTo: row.effective_to,
    rateCard: {
      percentBasisPoints: row.percent_bp,
      flatKobo: BigInt(row.flat_kobo),
      flatWaivedBelowKobo:
        row.flat_waived_below_kobo === null ? null : BigInt(row.flat_waived_below_kobo),
      capKobo: row.cap_kobo === null ? null : BigInt(row.cap_kobo),
      vatBasisPoints: row.vat_bp,
    },
    approvedBy: row.approved_by,
    approvedAt: row.approved_at,
  }));
}

// ── The PSP's report ────────────────────────────────────────────────────────

export async function recordPayouts(
  db: Executor,
  payouts: readonly Payout[],
): Promise<Stored> {
  let stored = 0;
  await inTransaction(db, async (client) => {
    for (const payout of payouts) {
      const result = await client.query(
        `INSERT INTO payouts
                (idempotency_key, payout_reference, source, status, gross_kobo,
                 expected_net_kobo, currency, adjustments, reported_at, value_date, evidence_id)
         VALUES ($1, $2, $3, $4, $5::bigint, $6::bigint, $7, $8::jsonb, $9, $10, $11)
         ON CONFLICT (idempotency_key) DO NOTHING`,
        [
          payout.idempotencyKey,
          payout.payoutReference,
          payout.source,
          payout.status,
          kobo(payout.gross),
          kobo(payout.expectedNet),
          payout.gross.currency,
          JSON.stringify(
            payout.adjustments.map((adjustment) => ({
              kind: adjustment.kind,
              kobo: kobo(adjustment.amount),
              narration: adjustment.narration,
            })),
          ),
          payout.reportedAt,
          payout.valueDate,
          payout.evidenceId,
        ],
      );
      stored += result.rowCount ?? 0;
    }
  });
  return { stored, duplicates: payouts.length - stored };
}

export async function recordSettlementLines(
  db: Executor,
  lines: readonly SettlementLine[],
): Promise<Stored> {
  let stored = 0;
  await inTransaction(db, async (client) => {
    for (const line of lines) {
      const result = await client.query(
        `INSERT INTO settlement_lines
                (idempotency_key, source, reference, payout_reference, merchant_id,
                 gross_kobo, fee_kobo, net_kobo, currency, status, settled_at,
                 reason_hints, evidence_id)
         VALUES ($1, $2, $3, $4, $5, $6::bigint, $7::bigint, $8::bigint, $9, $10, $11, $12, $13)
         ON CONFLICT (idempotency_key) DO NOTHING`,
        [
          line.idempotencyKey,
          line.source,
          line.reference,
          line.payoutReference,
          line.merchantId,
          kobo(line.gross),
          kobo(line.fee),
          kobo(line.net),
          line.gross.currency,
          line.status,
          line.settledAt,
          [...line.reasonHints],
          line.evidenceId,
        ],
      );
      stored += result.rowCount ?? 0;
    }
  });
  return { stored, duplicates: lines.length - stored };
}

export async function recordBankLines(
  db: Executor,
  lines: readonly BankStatementLine[],
): Promise<Stored> {
  let stored = 0;
  await inTransaction(db, async (client) => {
    for (const line of lines) {
      const result = await client.query(
        `INSERT INTO bank_statement_lines
                (idempotency_key, bank_account_id, reference, direction, amount_kobo,
                 balance_after_kobo, currency, value_date, narration, narration_tokens,
                 stated_reference, evidence_id)
         VALUES ($1, $2, $3, $4, $5::bigint, $6::bigint, $7, $8, $9, $10, $11, $12)
         ON CONFLICT (idempotency_key) DO NOTHING`,
        [
          line.idempotencyKey,
          line.bankAccountId,
          line.reference,
          line.direction,
          kobo(line.amount),
          line.balanceAfter ? kobo(line.balanceAfter) : null,
          line.amount.currency,
          line.valueDate,
          line.narration,
          [...line.narrationTokens],
          line.statedReference,
          line.evidenceId,
        ],
      );
      stored += result.rowCount ?? 0;
    }
  });
  return { stored, duplicates: lines.length - stored };
}

/** Payouts no expected inflow has been built from yet. */
export async function unallocatedPayouts(db: Executor, limit = 1000): Promise<Payout[]> {
  const result = await db.query<{
    idempotency_key: string;
    payout_reference: string;
    source: string;
    status: Payout['status'];
    gross_kobo: string;
    expected_net_kobo: string;
    adjustments: { kind: string; kobo: string; narration: string | null }[];
    reported_at: Date;
    value_date: Date | null;
    evidence_id: string;
  }>(
    `SELECT p.idempotency_key, p.payout_reference, p.source, p.status,
            p.gross_kobo::text, p.expected_net_kobo::text, p.adjustments,
            p.reported_at, p.value_date, p.evidence_id
       FROM payouts p
      WHERE NOT EXISTS (SELECT 1 FROM expected_inflows i WHERE i.inflow_key = p.payout_reference)
      ORDER BY p.payout_reference
      LIMIT $1`,
    [limit],
  );

  return result.rows.map((row) => ({
    payoutReference: row.payout_reference,
    source: row.source,
    status: row.status,
    gross: fromKobo(row.gross_kobo),
    expectedNet: fromKobo(row.expected_net_kobo),
    adjustments: row.adjustments.map(
      (adjustment): SettlementAdjustment => ({
        kind: adjustment.kind as SettlementAdjustment['kind'],
        amount: fromKobo(adjustment.kobo),
        narration: adjustment.narration,
      }),
    ),
    reportedAt: row.reported_at,
    valueDate: row.value_date,
    evidenceId: row.evidence_id,
    idempotencyKey: row.idempotency_key,
  }));
}

/**
 * Settlement lines not yet carried by any inflow.
 *
 * Lines belonging to a payout are excluded: the payout is the movement, and matching its
 * lines separately would allocate the same receivable twice.
 */
export async function unallocatedSettlementLines(
  db: Executor,
  limit = 1000,
): Promise<SettlementLine[]> {
  const result = await db.query<{
    idempotency_key: string;
    source: string;
    reference: string;
    payout_reference: string | null;
    merchant_id: string;
    gross_kobo: string;
    fee_kobo: string;
    net_kobo: string;
    status: SettlementLine['status'];
    settled_at: Date | null;
    reason_hints: string[];
    evidence_id: string;
  }>(
    `SELECT l.idempotency_key, l.source, l.reference, l.payout_reference, l.merchant_id,
            l.gross_kobo::text, l.fee_kobo::text, l.net_kobo::text,
            l.status, l.settled_at, l.reason_hints, l.evidence_id
       FROM settlement_lines l
      WHERE NOT EXISTS (
              SELECT 1 FROM expected_inflows i
               WHERE i.inflow_key = ANY(ARRAY[l.payout_reference])
            )
        AND NOT EXISTS (
              SELECT 1 FROM matches m
               WHERE m.links -> 'settlementKeys' ? l.idempotency_key
            )
      ORDER BY l.idempotency_key
      LIMIT $1`,
    [limit],
  );

  return result.rows.map((row) => ({
    reference: row.reference,
    source: row.source,
    payoutReference: row.payout_reference,
    merchantId: row.merchant_id,
    gross: fromKobo(row.gross_kobo),
    fee: fromKobo(row.fee_kobo),
    net: fromKobo(row.net_kobo),
    status: row.status,
    settledAt: row.settled_at,
    reasonHints: row.reason_hints,
    evidenceId: row.evidence_id,
    idempotencyKey: row.idempotency_key,
  }));
}

/** Bank statement lines that have not yet confirmed anything. */
export async function unmatchedBankLines(
  db: Executor,
  limit = 1000,
): Promise<BankStatementLine[]> {
  const result = await db.query<{
    idempotency_key: string;
    bank_account_id: string;
    reference: string;
    direction: BankStatementLine['direction'];
    amount_kobo: string;
    balance_after_kobo: string | null;
    value_date: Date;
    narration: string;
    narration_tokens: string[];
    stated_reference: string | null;
    evidence_id: string;
  }>(
    `SELECT b.idempotency_key, b.bank_account_id, b.reference, b.direction,
            b.amount_kobo::text, b.balance_after_kobo::text, b.value_date,
            b.narration, b.narration_tokens, b.stated_reference, b.evidence_id
       FROM bank_statement_lines b
      WHERE NOT EXISTS (
              SELECT 1 FROM expected_inflows i WHERE i.confirmed_by = b.idempotency_key
            )
      ORDER BY b.idempotency_key
      LIMIT $1`,
    [limit],
  );

  return result.rows.map((row) => ({
    reference: row.reference,
    bankAccountId: row.bank_account_id,
    direction: row.direction,
    amount: fromKobo(row.amount_kobo),
    balanceAfter: row.balance_after_kobo === null ? null : fromKobo(row.balance_after_kobo),
    valueDate: row.value_date,
    narration: row.narration,
    narrationTokens: row.narration_tokens,
    statedReference: row.stated_reference,
    evidenceId: row.evidence_id,
    idempotencyKey: row.idempotency_key,
  }));
}

// ── Expected inflows ────────────────────────────────────────────────────────

export async function saveInflow(
  db: Executor,
  inflow: ExpectedInflow,
  allocations: readonly InflowAllocation[],
  reportedAt: Date,
): Promise<void> {
  await inTransaction(db, async (client) => {
    const inserted = await client.query(
      `INSERT INTO expected_inflows
              (inflow_key, source, derived, gross_kobo, expected_net_kobo, currency,
               deductions, value_date, evidence_id, reported_at)
       VALUES ($1, $2, $3, $4::bigint, $5::bigint, $6, $7::jsonb, $8, $9, $10)
       ON CONFLICT (inflow_key) DO NOTHING`,
      [
        inflow.key,
        inflow.source,
        inflow.derived,
        kobo(inflow.gross),
        kobo(inflow.expectedNet),
        NGN,
        JSON.stringify(
          inflow.deductions.map((deduction) => ({
            account_id: deduction.accountId,
            kobo: kobo(deduction.amount),
          })),
        ),
        inflow.valueDate,
        inflow.evidenceId,
        reportedAt,
      ],
    );
    if (inserted.rowCount === 0) return;

    for (const allocation of allocations) {
      await client.query(
        `INSERT INTO inflow_allocations (inflow_key, transaction_id, amount_kobo)
              VALUES ($1, $2, $3::bigint)`,
        [inflow.key, allocation.transactionId, kobo(allocation.amount)],
      );
    }
  });
}

/** Inflows the bank has not confirmed. These are what stage three works on. */
export async function openInflows(db: Executor, limit = 1000): Promise<ExpectedInflow[]> {
  const result = await db.query<{
    inflow_key: string;
    source: string;
    derived: boolean;
    gross_kobo: string;
    expected_net_kobo: string;
    deductions: { account_id: string; kobo: string }[];
    value_date: Date | null;
    evidence_id: string;
  }>(
    `SELECT inflow_key, source, derived, gross_kobo::text, expected_net_kobo::text,
            deductions, value_date, evidence_id
       FROM expected_inflows
      WHERE confirmed_by IS NULL
      ORDER BY inflow_key
      LIMIT $1`,
    [limit],
  );

  const keys = result.rows.map((row) => row.inflow_key);
  const lines =
    keys.length === 0
      ? { rows: [] as { inflow_key: string; idempotency_key: string }[] }
      : await db.query<{ inflow_key: string; idempotency_key: string }>(
          `SELECT i.inflow_key, l.idempotency_key
             FROM expected_inflows i
             JOIN settlement_lines l ON l.payout_reference = i.inflow_key
            WHERE i.inflow_key = ANY($1)`,
          [keys],
        );

  const keysByInflow = new Map<string, string[]>();
  for (const row of lines.rows) {
    const bucket = keysByInflow.get(row.inflow_key);
    if (bucket) bucket.push(row.idempotency_key);
    else keysByInflow.set(row.inflow_key, [row.idempotency_key]);
  }

  return result.rows.map((row) => ({
    key: row.inflow_key,
    source: row.source,
    derived: row.derived,
    gross: fromKobo(row.gross_kobo),
    expectedNet: fromKobo(row.expected_net_kobo),
    deductions: row.deductions.map((deduction) => ({
      accountId: deduction.account_id as ExpectedInflow['deductions'][number]['accountId'],
      amount: fromKobo(deduction.kobo),
    })),
    valueDate: row.value_date,
    settlementKeys: keysByInflow.get(row.inflow_key) ?? [],
    evidenceId: row.evidence_id,
  }));
}

/**
 * Mark an inflow confirmed by a bank credit.
 *
 * The `WHERE confirmed_by IS NULL` guard, plus the partial unique index on
 * `confirmed_by`, mean this is safe to run twice and impossible to run twice *wrongly*:
 * one credit confirms one inflow, and a re-run finds nothing to update.
 */
export async function confirmInflow(
  db: Executor,
  inflowKey: string,
  creditKey: string,
  at: Date,
): Promise<boolean> {
  const result = await db.query(
    `UPDATE expected_inflows
        SET confirmed_by = $2, confirmed_at = $3
      WHERE inflow_key = $1 AND confirmed_by IS NULL`,
    [inflowKey, creditKey, at],
  );
  if ((result.rowCount ?? 0) === 0) return false;

  // The payout's own lifecycle moves with it: `reported` was the PSP's claim, `confirmed`
  // is the bank's answer. Derived inflows have no payout row to move, which is the point
  // of the distinction. Nothing else in the system may set this — the guard on `reported`
  // makes a second confirmation a no-op rather than a rewrite of history.
  await db.query(
    `UPDATE payouts SET status = 'confirmed'
      WHERE payout_reference = $1 AND status = 'reported'`,
    [inflowKey],
  );
  return true;
}

/**
 * The bank sent a payout back after we had booked it as cash.
 *
 * Recorded on the payout rather than by unwinding the confirmation: the money genuinely did
 * arrive and genuinely did leave, and both halves belong in the history. The compensating
 * ledger entry is `bookReturnedPayout`'s job.
 */
export async function markPayoutReturned(
  db: Executor,
  payoutReference: string,
): Promise<boolean> {
  const result = await db.query(
    `UPDATE payouts SET status = 'returned'
      WHERE payout_reference = $1 AND status = 'confirmed'`,
    [payoutReference],
  );
  return (result.rowCount ?? 0) > 0;
}

/** How much of each promise earlier runs already allocated. */
export async function allocatedByTransaction(
  db: Executor,
): Promise<Map<TransactionId, Money>> {
  const result = await db.query<{ transaction_id: string; total: string }>(
    `SELECT transaction_id, SUM(amount_kobo)::text AS total
       FROM inflow_allocations GROUP BY transaction_id`,
  );
  const allocated = new Map<TransactionId, Money>();
  for (const row of result.rows) allocated.set(row.transaction_id, fromKobo(row.total));
  return allocated;
}

export async function allocationsOf(
  db: Executor,
  inflowKey: string,
): Promise<{ transactionId: string; amount: Money }[]> {
  const result = await db.query<{ transaction_id: string; amount_kobo: string }>(
    `SELECT transaction_id, amount_kobo::text
       FROM inflow_allocations WHERE inflow_key = $1 ORDER BY transaction_id`,
    [inflowKey],
  );
  return result.rows.map((row) => ({
    transactionId: row.transaction_id,
    amount: fromKobo(row.amount_kobo),
  }));
}

// ── Conclusions, and the humans who reach them ──────────────────────────────

/**
 * Write down what was concluded, and what — if anything — it booked.
 *
 * Called inside the same database transaction as any booking it describes, so the entry
 * and the reason for it either both exist or neither does. Money that moved for a reason
 * nobody can recover is indistinguishable from money that moved for no reason.
 */
export async function recordMatch(
  db: Executor,
  matchId: string,
  result: MatchResult,
  bookedTransactionId: string | null,
  at: Date,
): Promise<void> {
  await db.query(
    `INSERT INTO matches (match_id, reason, confidence, links, booked_transaction_id, at)
          VALUES ($1, $2, $3, $4::jsonb, $5, $6)
     ON CONFLICT (match_id) DO NOTHING`,
    [
      matchId,
      result.reason,
      result.confidence,
      JSON.stringify({
        transactionIds: result.transactionIds,
        settlementKeys: result.settlementKeys,
        payoutReferences: result.payoutReferences,
        bankCreditKeys: result.bankCreditKeys,
      }),
      bookedTransactionId,
      at,
    ],
  );
}

/**
 * A human's decision, appended.
 *
 * There is deliberately no `updateResolution`. A reviewer who changes their mind appends a
 * second one; both stay visible, and so does the fact that somebody changed their mind.
 */
export async function recordResolution(db: Executor, resolution: Resolution): Promise<void> {
  await db.query(
    `INSERT INTO resolutions
            (subject, subject_id, action, reason, resolved_by, resolved_at,
             evidence_id, approved_by, approved_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      resolution.subject,
      resolution.subjectId,
      resolution.action,
      resolution.reason,
      resolution.resolvedBy,
      resolution.resolvedAt,
      resolution.evidenceId,
      resolution.approvedBy,
      resolution.approvedAt,
    ],
  );
}

export async function resolutionsFor(
  db: Executor,
  subject: Resolution['subject'],
  subjectId: string,
): Promise<Resolution[]> {
  const result = await db.query<{
    subject: Resolution['subject'];
    subject_id: string;
    action: string;
    reason: string;
    resolved_by: string;
    resolved_at: Date;
    evidence_id: string | null;
    approved_by: string | null;
    approved_at: Date | null;
  }>(
    `SELECT subject, subject_id, action, reason, resolved_by, resolved_at,
            evidence_id, approved_by, approved_at
       FROM resolutions
      WHERE subject = $1 AND subject_id = $2
      ORDER BY resolution_id`,
    [subject, subjectId],
  );

  return result.rows.map((row) => ({
    subject: row.subject,
    subjectId: row.subject_id,
    action: row.action,
    reason: row.reason,
    resolvedBy: row.resolved_by,
    resolvedAt: row.resolved_at,
    evidenceId: row.evidence_id,
    approvedBy: row.approved_by,
    approvedAt: row.approved_at,
  }));
}

export async function matchOf(
  db: Executor,
  matchId: string,
): Promise<{ reason: string; confidence: number; bookedTransactionId: string | null } | null> {
  const result = await db.query<{
    reason: string;
    confidence: string;
    booked_transaction_id: string | null;
  }>(
    `SELECT reason, confidence::text, booked_transaction_id
       FROM matches WHERE match_id = $1`,
    [matchId],
  );
  const row = result.rows[0];
  return row
    ? {
        reason: row.reason,
        confidence: Number(row.confidence),
        bookedTransactionId: row.booked_transaction_id,
      }
    : null;
}

