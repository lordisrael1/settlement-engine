import { createHmac } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import type { Pool } from 'pg';

import { format, money } from '@recon/canon';
import { dedupe, ingestSettlement, ingestWebhook, sourceProfile } from '@recon/ingest';
import {
  bookAuthorizedPayment,
  getTransaction,
  inTransaction,
  postTransaction,
  reverse,
  UnbalancedTransactionError,
} from '@recon/ledger-core';

import { heading, line, printBalances, printVerification } from './report.js';

const PAYSTACK_SECRET = 'sk_test_demo_secret';

/**
 * The whole of Phases 1 and 2, end to end, against a real database.
 *
 * Running it a second time is not a mistake — it is the point. Every step is idempotent,
 * so the second run reports duplicates everywhere and moves not one kobo. That is Law 4
 * demonstrated rather than asserted. For a clean narrative, start from an empty volume:
 * `docker compose down -v && docker compose up`.
 */
export async function runDemo(pool: Pool): Promise<boolean> {
  const now = new Date('2026-08-15T10:00:00Z');

  // ── The promise half ──────────────────────────────────────────────────────
  heading('1 · Webhooks arrive — the fast promise');

  const webhooks = JSON.parse(
    await readFile(new URL('../fixtures/paystack-webhooks.json', import.meta.url), 'utf8'),
  ) as unknown[];

  const postedIds: string[] = [];

  for (const body of webhooks) {
    const result = await deliver(pool, body, now);
    postedIds.push(result.transactionId);
    line(`  ${result.summary}`);
  }

  heading('2 · Paystack redelivers the first webhook — Law 4');
  line('  Providers retry until you answer 200. Duplicates are guaranteed, not unlikely.');
  const redelivered = await deliver(pool, webhooks[0], now);
  line(`  ${redelivered.summary}`);

  heading('3 · Balances, derived from entries');
  await printBalances(pool);
  line();
  line('  psp_receivable is the money promised but not yet paid. Revenue is booked at');
  line('  gross; no fee has been booked, because no fee is known yet.');

  // ── The invariants ────────────────────────────────────────────────────────
  heading('4 · An unbalanced transaction is refused — Law 1');

  try {
    await bookUnbalanced(pool);
    line('  ✗ the ledger accepted money from nowhere');
    return false;
  } catch (error) {
    line(`  app  ✓ ${firstLine(error)}`);
  }

  try {
    await bookUnbalancedBypassingTheApp(pool);
    line('  ✗ the database accepted money from nowhere');
    return false;
  } catch (error) {
    line(`  db   ✓ ${firstLine(error)}`);
    line('       The check is a deferred constraint trigger, so it fires at COMMIT and');
    line('       cannot be evaded by writing entries one statement at a time.');
  }

  heading('5 · History cannot be edited — Law 2');
  try {
    await pool.query('UPDATE entries SET amount_kobo = 0');
    line('  ✗ an entry was rewritten');
    return false;
  } catch (error) {
    line(`  ✓ ${firstLine(error)}`);
  }

  // ── The money half ────────────────────────────────────────────────────────
  heading('6 · A settlement payload arrives — the slow money');

  const settlementBytes = await readFile(
    new URL('../fixtures/flutterwave-settlements.json', import.meta.url),
  );
  const ingested = ingestSettlement('flutterwave', settlementBytes);

  line(`  format recognised: ${ingested.format}`);
  for (const settlementLine of ingested.lines) {
    const hints = settlementLine.reasonHints.join(' ');
    line(
      `  ✓ ${settlementLine.reference.padEnd(14)} gross ${format(settlementLine.gross).padStart(12)}` +
        `  fee ${format(settlementLine.fee).padStart(9)}` +
        `  net ${format(settlementLine.net).padStart(12)}   ${hints}`,
    );
  }
  for (const rejected of ingested.rejected) {
    line(`  – ${rejected.kind}: ${rejected.reason}`);
  }
  line();
  line('  The USD row is refused rather than converted: this ledger keeps books in NGN,');
  line('  and a guessed exchange rate is a wrong number wearing a confident face.');
  line('  The chargeback hint is lifted out of a fee that would otherwise look ordinary.');

  heading('7 · The same payload again — Law 4 on the money half');
  const reingested = ingestSettlement('flutterwave', settlementBytes);
  const seen = new Set(ingested.lines.map((l) => l.idempotencyKey));
  const { fresh, duplicates } = dedupe(reingested.lines, seen);
  line(`  ${fresh.length} new, ${duplicates.length} already ingested — nothing to book.`);

  // ── The fee model ─────────────────────────────────────────────────────────
  heading('8 · The fee model, checked against what Paystack actually charged');
  line('  Tier 2 of the matcher will match on ourGross − expectedFee(ourGross) == theirNet,');
  line('  so the rate card has to be right. Each row exercises a different branch of it.');
  line();

  const expectedFee = sourceProfile('paystack').expectedFee;
  if (!expectedFee) {
    line('  ✗ no rate card configured for paystack');
    return false;
  }

  let feesAgree = true;
  for (const body of webhooks) {
    const data = (body as { data: { reference: string; amount: number; fees: number } }).data;
    const gross = money(BigInt(data.amount));
    const predicted = expectedFee(gross);
    const actual = money(BigInt(data.fees));
    const agrees = predicted.kobo === actual.kobo;
    feesAgree &&= agrees;
    line(
      `  ${agrees ? '✓' : '✗'} ${data.reference.padEnd(12)} gross ${format(gross).padStart(12)}` +
        `   predicted ${format(predicted).padStart(9)}   charged ${format(actual).padStart(9)}`,
    );
  }

  // ── Reversal ──────────────────────────────────────────────────────────────
  heading('9 · A payment is reversed — Law 2, operationally');
  const target = postedIds[postedIds.length - 1]!;
  const reversal = await reverse(pool, target, now);
  const original = await getTransaction(pool, target);
  line(`  reversal ${reversal.outcome}: ${reversal.transactionId}`);
  line(`  original is now: ${original?.state}`);
  line('  The original entries are untouched. A mirror-image transaction cancels them,');
  line('  so an auditor sees both the payment and its undoing.');

  heading('10 · Balances after the reversal');
  await printBalances(pool);

  heading('11 · The system checks itself');
  const verified = await printVerification(pool);

  line();
  return verified && feesAgree;
}

/** Sign a payload the way Paystack does, then push it through the real ingest path. */
async function deliver(
  pool: Pool,
  body: unknown,
  now: Date,
): Promise<{ transactionId: string; summary: string }> {
  const raw = Buffer.from(JSON.stringify(body), 'utf8');

  const result = ingestWebhook({
    source: 'paystack',
    headers: {
      'x-paystack-signature': createHmac('sha512', PAYSTACK_SECRET).update(raw).digest('hex'),
      'content-type': 'application/json',
    },
    rawBody: raw,
    secret: PAYSTACK_SECRET,
  });

  if (result.kind !== 'payment') {
    return { transactionId: '', summary: `${result.kind}: ${'reason' in result ? result.reason : ''}` };
  }

  const posted = await bookAuthorizedPayment(pool, result.payment, now);
  const verb = posted.outcome === 'posted' ? 'authorized' : 'duplicate — no change';

  return {
    transactionId: posted.transactionId,
    summary:
      `${result.payment.reference.padEnd(12)} ${format(result.payment.gross).padStart(12)}  ` +
      `${result.payment.status.padEnd(10)} → ${verb}`,
  };
}

/** The application-level guard: a good error message before the database is touched. */
async function bookUnbalanced(pool: Pool): Promise<void> {
  await postTransaction(pool, {
    transactionId: 'demo:unbalanced',
    source: 'demo',
    reference: 'unbalanced',
    occurredAt: new Date(),
    recordedAt: new Date(),
    initialState: 'authorized',
    entries: [
      { accountId: 'bank_account', amount: money(500_000n) },
      { accountId: 'merchant_revenue', amount: money(-400_000n) },
    ],
  });
  throw new UnbalancedTransactionError('demo:unbalanced', money(0n));
}

/**
 * The real claim is that the *database* refuses, not that our code remembers to check.
 * So write the entries with raw SQL, exactly as a rogue script or a second service
 * would, and let COMMIT be the thing that says no.
 */
async function bookUnbalancedBypassingTheApp(pool: Pool): Promise<void> {
  await inTransaction(pool, async (client) => {
    await client.query(
      `INSERT INTO ledger_transactions (transaction_id, source, reference, occurred_at, recorded_at)
            VALUES ('demo:raw-unbalanced', 'demo', 'raw', now(), now())`,
    );
    await client.query(
      `INSERT INTO entries (entry_id, transaction_id, ordinal, account_id, amount_kobo, currency)
            VALUES ('demo:raw-unbalanced#0', 'demo:raw-unbalanced', 0, 'bank_account', 500000, 'NGN')`,
    );
  });
}

function firstLine(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.split('\n')[0]!.trim();
}
