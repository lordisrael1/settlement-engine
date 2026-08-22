import type { ExceptionSubject, Money, SourceId } from '@recon/canon';
import { money, subtract } from '@recon/canon';
import type { Executor } from '@recon/ledger-core';
import { inTransaction } from '@recon/ledger-core';

import type { ExceptionDraft } from './exceptions.js';
import { policyOf, type PolicyLookup } from './policy.js';

/**
 * Reserves: our money, in somebody else's account, with a date on it.
 *
 * The chart of accounts already gets this right — `psp_reserve` is an *asset*, because a
 * rolling reserve is withheld rather than kept, and booking it as a cost would understate
 * what we are owed by exactly the amount we are owed. What was missing is the other half of
 * being owed something: a date by which it should have come back.
 *
 * Without one, a reserve position is unfalsifiable. A PSP that withholds 5% of every payout
 * for ninety days and a PSP that withholds 5% of every payout and never returns any of it
 * produce the *same* balance sheet, the same reconciliation, the same empty exception queue,
 * and the same clean `verify`. The balance grows in both cases and looks healthy in both
 * cases. That is money quietly not being chased, and it is exactly the class of silent
 * disappearance the rest of this system exists to prevent (ADR-0071).
 *
 * Three facts make it tractable, and all three were already here:
 *
 *   The PSP itemises the withholding. A `reserve` adjustment is a named deduction on the
 *   payout, so the amount is theirs rather than a residue we computed.
 *
 *   The PSP itemises the return. A `reserve_release` arrives as a negative adjustment on
 *   some later payout — it names no particular withholding, which is why releases are
 *   applied oldest-first below.
 *
 *   The deadline is policy, per source, and travels with everything else the matcher is
 *   told about a source. Nothing in here learns a PSP's name.
 *
 * Note where the clock starts: the **value date of the bank credit that confirmed the
 * shortened payout**, not the moment a run noticed. A reserve's ninety days run from when
 * the money was actually held back, and dating it to the reconciliation would restart every
 * reserve's clock on the day somebody re-imported a file.
 */

const RESERVE = 'psp_reserve';

/** A reserve position: what was withheld, what has come back, and what is still out. */
export interface ReservePosition {
  readonly inflowKey: string;
  readonly source: SourceId;
  readonly withheld: Money;
  readonly released: Money;
  readonly outstanding: Money;
  readonly withheldAt: Date;
  /** `null` when the source declared no release schedule. Not the same as "not due yet". */
  readonly dueAt: Date | null;
  readonly confirmedBy: string;
  readonly evidenceId: string | null;
}

/**
 * Record what a confirmed settlement did to our reserve position.
 *
 * Called with the *net* `psp_reserve` movement of one booking, because that is what the
 * ledger booked: `adjustmentEntries` collapses `reserve` and `reserve_release` into one
 * entry per account, and taking the net is what keeps this table and the ledger telling the
 * same story. A positive net is a withholding; a negative one is a return.
 *
 * Both halves are keyed and both are therefore safe to re-run: the hold's key is the inflow,
 * and a release is unique on `(hold, releasing inflow)`. A reconciliation that dies halfway
 * and is retried does not double a reserve or release it twice.
 */
export async function recordReserveMovement(
  db: Executor,
  movement: {
    readonly inflowKey: string;
    readonly source: SourceId;
    /** Signed: positive withholds, negative returns. Zero does nothing. */
    readonly net: Money;
    /** The value date of the confirming bank credit. The clock starts here. */
    readonly at: Date;
    readonly confirmedBy: string;
    readonly evidenceId: string | null;
    readonly policyFor: PolicyLookup;
  },
): Promise<void> {
  if (movement.net.kobo === 0n) return;

  if (movement.net.kobo > 0n) {
    const days = policyOf(movement.policyFor, movement.source).reserveReleaseDays;
    const dueAt =
      days === null ? null : new Date(movement.at.getTime() + days * 24 * 60 * 60 * 1000);

    await db.query(
      `INSERT INTO reserve_holds
              (inflow_key, source, withheld_kobo, currency, withheld_at, due_at,
               confirmed_by, evidence_id)
       VALUES ($1, $2, $3::bigint, $4, $5, $6, $7, $8)
       ON CONFLICT (inflow_key) DO NOTHING`,
      [
        movement.inflowKey,
        movement.source,
        movement.net.kobo.toString(),
        movement.net.currency,
        movement.at,
        dueAt,
        movement.confirmedBy,
        movement.evidenceId,
      ],
    );
    return;
  }

  await applyRelease(db, movement.source, movement.inflowKey, -movement.net.kobo, movement.at);
}

/**
 * Apply a release across the open holds of one source, oldest first.
 *
 * The PSP does not say which withholding a release answers — it reports a `reserve_release`
 * on a payout and nothing more — so an allocation rule is unavoidable, and oldest-first is
 * both what every rolling-reserve schedule actually does and the only rule that needs no
 * guessing. It is stated here rather than implied, and it is recorded per hold, so that a
 * position can always be explained rather than merely totalled.
 *
 * A release larger than everything outstanding is not an error and is not forced to fit:
 * the remainder is simply unallocated, because the alternative is inventing a hold to
 * absorb it. It shows up as a `psp_reserve` balance that has gone below the sum of holds,
 * which `verify` reports and a person reads — an honest loose end rather than a tidy lie.
 */
async function applyRelease(
  db: Executor,
  source: SourceId,
  releasedBy: string,
  amount: bigint,
  at: Date,
): Promise<void> {
  await inTransaction(db, async (client) => {
    const open = await client.query<{ inflow_key: string; outstanding_kobo: string }>(
      `SELECT inflow_key, outstanding_kobo::text
         FROM reserve_positions
        WHERE source = $1 AND outstanding_kobo > 0
        ORDER BY withheld_at, inflow_key`,
      [source],
    );

    let remaining = amount;
    for (const row of open.rows) {
      if (remaining <= 0n) break;
      const outstanding = BigInt(row.outstanding_kobo);
      const applied = outstanding < remaining ? outstanding : remaining;

      await client.query(
        `INSERT INTO reserve_releases (inflow_key, released_by, amount_kobo, at)
              VALUES ($1, $2, $3::bigint, $4)
         ON CONFLICT (inflow_key, released_by) DO NOTHING`,
        [row.inflow_key, releasedBy, applied.toString(), at],
      );
      remaining -= applied;
    }
  });
}

/**
 * Reserves past the date the source undertook to return them.
 *
 * The queue entry is about the **payout** the reserve was withheld from, which is the thing
 * a person can actually take to the PSP: "PO-4471 settled on the 3rd of March ₦180,000
 * short, you said ninety days, it is the 12th of July". A queue entry about an account
 * balance would be true and unusable.
 *
 * Holds with no `due_at` are deliberately not raised. A source that declared no reserve
 * schedule has promised nothing, and inventing a deadline for it would produce an exception
 * that no evidence can ever clear — the queue's worst possible entry. They are still
 * visible: `reservePositions` returns them, and a source holding money on no schedule at all
 * is a thing to notice when reading that list rather than a thing to be paged about.
 */
export async function unreleasedReserves(
  db: Executor,
  asOf: Date,
  limit = 500,
): Promise<ExceptionDraft[]> {
  const result = await db.query<{
    inflow_key: string;
    source: string;
    outstanding_kobo: string;
    currency: string;
    due_at: Date;
    withheld_at: Date;
    evidence_id: string | null;
  }>(
    `SELECT inflow_key, source, outstanding_kobo::text, currency, due_at, withheld_at,
            evidence_id
       FROM reserve_positions
      WHERE outstanding_kobo > 0 AND due_at IS NOT NULL AND due_at < $1
      ORDER BY due_at, inflow_key
      LIMIT $2`,
    [asOf, limit],
  );

  return result.rows.map((row) => ({
    subject: 'payout' as ExceptionSubject,
    subjectId: row.inflow_key,
    reason: 'RESERVE_UNRELEASED' as const,
    amount: money(BigInt(row.outstanding_kobo)),
    dueAt: row.due_at,
    evidenceId: row.evidence_id,
    links: {
      transactionIds: [],
      payoutReferences: [row.inflow_key],
      bankCreditKeys: [],
      settlementKeys: [],
    },
    considered: [],
  }));
}

/** Every reserve still outstanding, oldest first. The list somebody chases from. */
export async function reservePositions(
  db: Executor,
  limit = 500,
): Promise<ReservePosition[]> {
  const result = await db.query<{
    inflow_key: string;
    source: string;
    withheld_kobo: string;
    released_kobo: string;
    outstanding_kobo: string;
    withheld_at: Date;
    due_at: Date | null;
    confirmed_by: string;
    evidence_id: string | null;
  }>(
    `SELECT inflow_key, source, withheld_kobo::text, released_kobo::text,
            outstanding_kobo::text, withheld_at, due_at, confirmed_by, evidence_id
       FROM reserve_positions
      WHERE outstanding_kobo > 0
      ORDER BY due_at NULLS LAST, withheld_at, inflow_key
      LIMIT $1`,
    [limit],
  );

  return result.rows.map((row) => ({
    inflowKey: row.inflow_key,
    source: row.source,
    withheld: money(BigInt(row.withheld_kobo)),
    released: money(BigInt(row.released_kobo)),
    outstanding: money(BigInt(row.outstanding_kobo)),
    withheldAt: row.withheld_at,
    dueAt: row.due_at,
    confirmedBy: row.confirmed_by,
    evidenceId: row.evidence_id,
  }));
}

// ── The other thing nobody was checking ─────────────────────────────────────

/**
 * Where our books stand against the bank's own arithmetic.
 *
 * Two comparisons, and they answer different questions.
 *
 * `statementClosing` is the running balance on the last statement line we ingested — the
 * bank's own number, from the bank's own file, requiring nobody to do anything. Comparing it
 * to `bank_account` is the closest thing to a free reality check this system has, and it
 * catches the ordinary failure: a statement we half-ingested, a credit that was rejected at
 * parse time, a debit nobody modelled.
 *
 * It is *not* proof the file came from the bank. A fabricated statement carries a fabricated
 * running balance and agrees with itself perfectly. That is what `attestBankBalance` is for,
 * and why it takes a person's name.
 *
 * A difference is expected rather than alarming. The real account holds movements this
 * system does not model at all — supplier payments, salaries, a standing order, bank charges
 * on the account rather than on a credit — so the number to watch is not the difference but
 * whether anybody can say what it consists of.
 */
export interface BankPosition {
  readonly bankAccountId: string;
  /** Summed from `entries`, not read from the balance cache. */
  readonly ledgerBalance: Money;
  /** The bank's own running balance on the newest line we hold, if it reports one. */
  readonly statementClosing: Money | null;
  /** The value date of that line. How current this comparison is. */
  readonly statementAt: Date | null;
  /** `statementClosing − ledgerBalance`, or `null` when the bank reports no balance. */
  readonly difference: Money | null;
}

export async function bankPosition(
  db: Executor,
  bankAccountId: string,
): Promise<BankPosition> {
  const ledger = await db.query<{ total: string }>(
    `SELECT COALESCE(SUM(amount_kobo), 0)::text AS total
       FROM entries WHERE account_id = 'bank_account'`,
  );
  const ledgerBalance = money(BigInt(ledger.rows[0]?.total ?? '0'));

  // The newest line that actually reports a balance. A bank that omits the column on some
  // rows is ordinary, and taking the newest row regardless would compare against a null.
  const statement = await db.query<{ balance_after_kobo: string; value_date: Date }>(
    `SELECT balance_after_kobo::text, value_date
       FROM bank_statement_lines
      WHERE bank_account_id = $1 AND balance_after_kobo IS NOT NULL
      ORDER BY value_date DESC, idempotency_key DESC
      LIMIT 1`,
    [bankAccountId],
  );

  const row = statement.rows[0];
  if (!row) {
    return {
      bankAccountId,
      ledgerBalance,
      statementClosing: null,
      statementAt: null,
      difference: null,
    };
  }

  const statementClosing = money(BigInt(row.balance_after_kobo));
  return {
    bankAccountId,
    ledgerBalance,
    statementClosing,
    statementAt: row.value_date,
    difference: subtract(statementClosing, ledgerBalance),
  };
}

export interface BankAttestation {
  readonly bankAccountId: string;
  readonly asOf: Date;
  readonly portalBalance: Money;
  readonly ledgerBalance: Money;
  readonly difference: Money;
  readonly attestedBy: string;
  readonly note: string | null;
  readonly recordedAt: Date;
}

/**
 * A person compared our books to the bank's own portal, and here is what they saw.
 *
 * This is the control that answers the one thing this architecture cannot answer itself.
 * Cash is booked on an uploaded file; the upload is behind an API key and nothing else;
 * anyone holding that key can produce a statement that confirms inflows and moves
 * `psp_receivable` into `bank_account`. `verify` does not catch it and could not — it proves
 * the books are internally consistent, and a fabricated statement that balances is
 * internally consistent (ADR-0068).
 *
 * So the honest control is out-of-band and human, and the only thing code can do about it is
 * make it a *record*: a name, a moment, the bank's number, ours, and the difference. Not
 * because the record prevents anything, but because "when did somebody last check the books
 * against the bank?" then has an answer, and an answer that goes stale is something a
 * monitor can see.
 *
 * `ledgerBalance` is recomputed from `entries` here rather than taken from the caller or the
 * balance cache. An attestation against a cache would be comparing one of our own
 * projections to the bank, which is a weaker claim than the one being made — and the whole
 * point is that this claim is the strong one.
 */
export async function attestBankBalance(
  db: Executor,
  input: {
    readonly bankAccountId: string;
    /** When the person read the portal, not when they typed it in. */
    readonly asOf: Date;
    readonly portalBalance: Money;
    readonly attestedBy: string;
    readonly note?: string | null;
    readonly recordedAt: Date;
  },
): Promise<BankAttestation> {
  return inTransaction(db, async (client) => {
    const position = await bankPosition(client, input.bankAccountId);
    const difference = subtract(input.portalBalance, position.ledgerBalance);

    await client.query(
      `INSERT INTO bank_attestations
              (bank_account_id, as_of, portal_balance_kobo, ledger_balance_kobo,
               difference_kobo, currency, attested_by, note, recorded_at)
       VALUES ($1, $2, $3::bigint, $4::bigint, $5::bigint, $6, $7, $8, $9)`,
      [
        input.bankAccountId,
        input.asOf,
        input.portalBalance.kobo.toString(),
        position.ledgerBalance.kobo.toString(),
        difference.kobo.toString(),
        input.portalBalance.currency,
        input.attestedBy,
        input.note ?? null,
        input.recordedAt,
      ],
    );

    return {
      bankAccountId: input.bankAccountId,
      asOf: input.asOf,
      portalBalance: input.portalBalance,
      ledgerBalance: position.ledgerBalance,
      difference,
      attestedBy: input.attestedBy,
      note: input.note ?? null,
      recordedAt: input.recordedAt,
    };
  });
}

/** The most recent attestation for an account, or `null` if nobody has ever made one. */
export async function lastAttestation(
  db: Executor,
  bankAccountId: string,
): Promise<BankAttestation | null> {
  const result = await db.query<{
    bank_account_id: string;
    as_of: Date;
    portal_balance_kobo: string;
    ledger_balance_kobo: string;
    difference_kobo: string;
    attested_by: string;
    note: string | null;
    recorded_at: Date;
  }>(
    `SELECT bank_account_id, as_of, portal_balance_kobo::text, ledger_balance_kobo::text,
            difference_kobo::text, attested_by, note, recorded_at
       FROM bank_attestations
      WHERE bank_account_id = $1
      ORDER BY as_of DESC, attestation_id DESC
      LIMIT 1`,
    [bankAccountId],
  );

  const row = result.rows[0];
  if (!row) return null;

  return {
    bankAccountId: row.bank_account_id,
    asOf: row.as_of,
    portalBalance: money(BigInt(row.portal_balance_kobo)),
    ledgerBalance: money(BigInt(row.ledger_balance_kobo)),
    difference: money(BigInt(row.difference_kobo)),
    attestedBy: row.attested_by,
    note: row.note,
    recordedAt: row.recorded_at,
  };
}
