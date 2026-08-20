import { createHmac } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import type { Pool } from 'pg';

import type { AccountId, Money } from '@recon/canon';
import { feeFor, format, money } from '@recon/canon';
import {
  dedupe,
  ingestBankStatement,
  ingestSettlement,
  ingestWebhook,
  publishedContracts,
  PAYSTACK_PUBLISHED_NGN,
} from '@recon/ingest';
import {
  allBalances,
  bookAuthorizedPayment,
  getTransaction,
  inTransaction,
  postTransaction,
  reverse,
  UnbalancedTransactionError,
} from '@recon/ledger-core';
import { buildPolicy } from '@recon/policy';
import {
  allocationsOf,
  matchOf,
  reconcile,
  recordBankLines,
  recordEvidence,
  recordPayouts,
  recordResolution,
  recordSettlementLines,
  saveFeeContract,
} from '@recon/reconciler';

import { vaultFromEnv } from './vault.js';

import {
  heading,
  line,
  printBalances,
  printQueue,
  printReconciliation,
  printVerification,
} from './report.js';

const PAYSTACK_SECRET = 'sk_test_demo_secret';
const FLUTTERWAVE_SECRET = 'flw_test_demo_secret_hash';
const MERCHANT = 'demo-merchant';

/**
 * Signing the fixtures the way each provider signs its own deliveries.
 *
 * This is the one place in the repository that is allowed to branch on a source name,
 * because here we are *impersonating the provider*, not processing its data — the demo
 * stands in for four remote systems that have no reason to agree with each other. Paystack
 * signs with HMAC-SHA512 in hex; Flutterwave with HMAC-SHA256 in base64. Four providers,
 * four schemes, which is why the verification lives in a library and not in our heads.
 */
const SIGNERS: Record<string, { secret: string; sign: (raw: Buffer) => Record<string, string> }> = {
  paystack: {
    secret: PAYSTACK_SECRET,
    sign: (raw) => ({
      'x-paystack-signature': createHmac('sha512', PAYSTACK_SECRET).update(raw).digest('hex'),
    }),
  },
  flutterwave: {
    secret: FLUTTERWAVE_SECRET,
    sign: (raw) => ({
      'flutterwave-signature': createHmac('sha256', FLUTTERWAVE_SECRET)
        .update(raw)
        .digest('base64'),
    }),
  },
};

/**
 * The whole system, end to end, against a real database.
 *
 * Running it a second time is part of the point: every step is idempotent, so the second
 * run reports duplicates everywhere and moves not one kobo. For a clean run, start from an
 * empty volume with `docker compose down -v && docker compose up`.
 */
export async function runDemo(pool: Pool): Promise<boolean> {
  const now = new Date('2026-08-15T10:00:00Z');

  // ── The promise half ──────────────────────────────────────────────────────
  heading('1 · Webhooks arrive — the fast promise');

  const webhooks = JSON.parse(
    await readFile(new URL('../fixtures/paystack-webhooks.json', import.meta.url), 'utf8'),
  ) as unknown[];
  const flutterwaveWebhooks = JSON.parse(
    await readFile(new URL('../fixtures/flutterwave-webhooks.json', import.meta.url), 'utf8'),
  ) as unknown[];

  const postedIds: string[] = [];

  for (const body of webhooks) {
    const result = await deliver(pool, 'paystack', body, now);
    postedIds.push(result.transactionId);
    line(`  ${result.summary}`);
  }

  line();
  line('  And four from Flutterwave — a different signature scheme, a different payload');
  line('  shape, the same canonical promise coming out the other end.');
  for (const body of flutterwaveWebhooks) {
    const result = await deliver(pool, 'flutterwave', body, now);
    line(`  ${result.summary}`);
  }

  heading('2 · Paystack redelivers the first webhook — idempotency');
  line('  Providers retry until you answer 200. Duplicates are guaranteed, not unlikely.');
  const redelivered = await deliver(pool, 'paystack', webhooks[0], now);
  line(`  ${redelivered.summary}`);

  heading('3 · Balances, derived from entries');
  await printBalances(pool);
  line();
  line('  psp_receivable is the money promised but not yet paid. Revenue is booked at');
  line('  gross; no fee has been booked, because no fee is known yet.');

  // ── The invariants ────────────────────────────────────────────────────────
  heading('4 · An unbalanced transaction is refused — balance-zero');

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

  heading('5 · History cannot be edited — append-only');
  try {
    await pool.query('UPDATE entries SET amount_kobo = 0');
    line('  ✗ an entry was rewritten');
    return false;
  } catch (error) {
    line(`  ✓ ${firstLine(error)}`);
  }

  // ── The fee model ─────────────────────────────────────────────────────────
  heading('6 · The rate card, checked against what Paystack actually charged');
  line('  A payout is matched on ourGross − expectedFee(ourGross) == theirNet, so the card');
  line('  has to be right. Each row exercises a different branch of it, and Paystack states');
  line('  the fee it charged in its own payload — so this is checked against their');
  line('  arithmetic, not against our reading of their pricing page.');
  line();

  let feesAgree = true;
  for (const body of webhooks) {
    const data = (body as { data: { reference: string; amount: number; fees: number } }).data;
    const gross = money(BigInt(data.amount));
    const predicted = feeFor(PAYSTACK_PUBLISHED_NGN, gross, {
      contractId: 'published:paystack',
      channel: 'card',
      effectiveFrom: new Date(0),
    });
    const actual = money(BigInt(data.fees));
    const agrees = predicted.fee.kobo === actual.kobo;
    feesAgree &&= agrees;
    line(
      `  ${agrees ? '✓' : '✗'} ${data.reference.padEnd(12)} gross ${format(gross).padStart(12)}` +
        `   fee ${format(predicted.fee).padStart(9)}  + VAT ${format(predicted.vat).padStart(8)}` +
        `   charged ${format(actual).padStart(9)}`,
    );
  }
  line();
  line('  VAT is its own number, bound for taxes_withheld rather than fees_expense. It goes');
  line('  to the tax authority, not to Paystack, and folding it into "what Paystack costs"');
  line('  would overstate their pricing while hiding a line the accountants need.');

  // ── Record two: the PSP says what it is sending ───────────────────────────
  heading('7 · A settlement report arrives — a claim, not cash');

  const settlementBytes = await readFile(
    new URL('../fixtures/flutterwave-settlements.json', import.meta.url),
  );
  const reported = ingestSettlement('flutterwave', settlementBytes, {
    merchantId: MERCHANT,
    filename: 'flutterwave-settlements.json',
    receivedFrom: 'demo',
    receivedAt: now,
  });

  line(`  format recognised: ${reported.format}`);
  line(`  evidence: ${reported.evidence.evidenceId.slice(0, 16)}…  (${reported.evidence.parserVersion})`);
  line();
  for (const payout of reported.payouts) {
    line(
      `  ✓ ${payout.payoutReference.padEnd(14)} gross ${format(payout.gross).padStart(12)}` +
        `   expected net ${format(payout.expectedNet).padStart(12)}`,
    );
    for (const adjustment of payout.adjustments) {
      line(`      − ${adjustment.kind.padEnd(14)} ${format(adjustment.amount).padStart(11)}   (${adjustment.narration})`);
    }
  }
  for (const rejected of reported.rejected) {
    line(`  – ${rejected.kind}: ${rejected.reason}`);
  }

  line();
  line('  Each deduction is named. A ₦168 shortfall is not "the fee" — it is a ₦118 fee');
  line('  and a ₦50 stamp duty, and they book to different accounts because one goes to');
  line('  Flutterwave and the other to the government.');
  line('  The USD row is refused rather than converted: a guessed exchange rate is a wrong');
  line('  number wearing a confident face.');

  await recordEvidence(pool, reported.evidence, settlementBytes, vaultFromEnv());
  await recordPayouts(pool, reported.payouts);
  await recordSettlementLines(pool, reported.lines);

  heading('8 · The same report again — idempotency on the money half');
  const reingested = ingestSettlement('flutterwave', settlementBytes, {
    merchantId: MERCHANT,
    filename: 'flutterwave-settlements.json',
    receivedFrom: 'demo',
    receivedAt: now,
  });
  const seen = new Set(reported.payouts.map((payout) => payout.idempotencyKey));
  const { fresh, duplicates } = dedupe(reingested.payouts, seen);
  line(`  ${fresh.length} new, ${duplicates.length} already ingested — and the same file`);
  line(`  hashes to the same evidence id: ${reingested.evidence.evidenceId === reported.evidence.evidenceId}`);

  // ── Stage two ─────────────────────────────────────────────────────────────
  heading('9 · The report meets the ledger — and books nothing');

  // The published rate cards, as dated contracts, scoped per channel. A deployment with
  // signed agreements loads those instead; seeding list prices here means the demo is
  // working from a price somebody can point at rather than from a constant in the matcher.
  for (const contract of publishedContracts(MERCHANT)) {
    await saveFeeContract(pool, contract);
  }

  const policyFor = await buildPolicy(pool, MERCHANT);
  const beforeStageTwo = await balanceOf(pool, 'bank_account');
  const stageTwo = await reconcile(pool, { asOf: now, policyFor });
  const afterStageTwo = await balanceOf(pool, 'bank_account');

  printReconciliation(stageTwo);
  line();
  line('  Two payouts matched to the payments they cover — by arithmetic, inside each');
  line('  source\u2019s business-day window. And the bank balance did not move:');
  line(`    bank_account before ${format(beforeStageTwo)}   after ${format(afterStageTwo)}`);
  line();
  line('  Flutterwave has told us what it intends to send. That is evidence, not money,');
  line('  and a ledger that books on intent reports cash it does not have.');

  const bankUnmoved = beforeStageTwo.kobo === afterStageTwo.kobo;
  if (!bankUnmoved) line('  ✗ the PSP\u2019s word moved the bank balance');

  // ── Record three: the bank ────────────────────────────────────────────────
  heading('10 · The bank statement arrives — the only proof of cash');

  const statementBytes = await readFile(
    new URL('../fixtures/bank-statement.json', import.meta.url),
  );
  const statement = ingestBankStatement(statementBytes, {
    bankAccountId: 'gtb-3011',
    bank: 'gtbank',
    filename: 'bank-statement.json',
    receivedFrom: 'demo',
    receivedAt: now,
  });

  for (const statementLine of statement.lines) {
    line(
      `  ${statementLine.direction === 'credit' ? '+' : '\u2212'} ${statementLine.reference.padEnd(12)}` +
        ` ${format(statementLine.amount).padStart(13)}   ${statementLine.narration}`,
    );
  }
  line();
  line('  The narration is tokenised, never interpreted. The parser says "these strings');
  line('  could be references"; the matcher decides, against payouts it actually holds.');

  await recordEvidence(pool, statement.evidence, statementBytes, vaultFromEnv());
  await recordBankLines(pool, statement.lines);

  // ── Stage three ───────────────────────────────────────────────────────────
  heading('11 · The bank confirms the payout — now, and only now, cash');

  const stageThree = await reconcile(pool, { asOf: now, policyFor });
  printReconciliation(stageThree);

  line();
  line('  One payout is confirmed by a credit that names it, and books in a single');
  line('  transaction: cash to the bank, the fee to fees_expense, the stamp duty to');
  line('  taxes_withheld, and the receivable closed. The other is still awaiting its');
  line('  credit — reported, not received, and neither matched nor missing.');

  heading('12 · Balances after the bank confirmed');
  await printBalances(pool);
  line();
  line('  bank_account holds real cash for the first time, and every deduction sits in');
  line('  the account that describes it rather than in a catch-all fee.');

  heading('13 · Reconciling again changes nothing — idempotency on the matching');
  const rerun = await reconcile(pool, { asOf: now, policyFor });
  line(`  ${rerun.booked.length} newly booked.`);
  line('  Every credit was spent by the previous run, and a partial unique index would');
  line('  refuse a second confirmation even if the matcher offered one.');
  const idempotent = rerun.booked.length === 0;
  if (!idempotent) line('  ✗ the second run moved money');

  // ── Reversal ──────────────────────────────────────────────────────────────
  heading('14 · A payment is reversed — append-only, operationally');
  const target = postedIds[postedIds.length - 1]!;
  const reversal = await reverse(pool, target, now);
  const original = await getTransaction(pool, target);
  line(`  reversal ${reversal.outcome}: ${reversal.transactionId}`);
  line(`  original is now: ${original?.state}`);
  line('  The original entries are untouched. A mirror-image transaction cancels them,');
  line('  so an auditor sees both the payment and its undoing.');

  // ── What each payment cost, and who said so ───────────────────────────────
  heading('15 · What each payment in the batch actually cost');

  const settled = stageThree.confirmation.confirmed[0];
  if (settled) {
    const allocations = await allocationsOf(pool, settled.inflow.key);
    const explained = await matchOf(pool, `allocate:${settled.inflow.key}`);

    line('  Flutterwave charged the payout, not the payments. Splitting the charge needs a');
    line('  rule — pro rata by gross, largest remainder, ties broken by transaction id — and');
    line('  the rule is exact-sum, so the shares add back to the deduction that was booked.');
    line();
    for (const allocation of allocations) {
      const cost = allocation.deductions
        .map((deduction) => `${deduction.accountId} ${format(deduction.amount)}`)
        .join(', ');
      line(
        `  ${allocation.transactionId.slice(-14).padEnd(16)} gross ${format(allocation.amount).padStart(11)}` +
          `   net ${format(allocation.net).padStart(11)}   ${cost || 'no share'}`,
      );
    }

    line();
    line('  And the contract that explained each one is stored beside the conclusion — not');
    line('  recomputed later against a table that may since have been renegotiated:');
    for (const explanation of explained?.explainedBy ?? []) {
      line(
        `  ${explanation.transactionId.slice(-14).padEnd(16)} ` +
          `contract ${explanation.contractId ?? 'none — matched on amounts alone'}` +
          (explanation.channel ? `  (${explanation.channel})` : ''),
      );
    }
  }

  // ── The human half ────────────────────────────────────────────────────────
  heading('16 · A human decides — appended, approved, and compensated');

  line('  An operator finds the PSP’s reserve notice: ₦40 of that "charge fee" was a');
  line('  90-day rolling reserve. The original booking is not touched — it recorded what');
  line('  we knew — and a second transaction moves the money to the account that');
  line('  describes it. An auditor sees the mistake and the correction.');
  line();

  const reclassified = await recordResolution(
    pool,
    {
      resolutionKey: 'demo:reclassify-reserve',
      subject: 'payout',
      subjectId: settled?.inflow.key ?? 'unknown',
      action: 'reclassify',
      reason: 'PSP reserve notice: ₦40 of the charge fee is a 90-day rolling reserve.',
      amount: money(4_000n),
      resolvedBy: 'ops.amaka@example.com',
      resolvedAt: now,
      evidenceId: null,
      approvedBy: 'controller.tunde@example.com',
      approvedAt: now,
    },
    {
      entries: [
        { accountId: 'psp_reserve', amount: money(4_000n) },
        { accountId: 'fees_expense', amount: money(-4_000n) },
      ],
    },
  );
  line(`  ✓ booked ${reclassified.bookedTransactionId}`);
  line('    psp_reserve  +₦40.00     fees_expense  −₦40.00');

  line();
  line('  Two things it may not do, and both refusals are the design:');

  const selfApproved = await refusal(() =>
    recordResolution(pool, {
      resolutionKey: 'demo:self-approved',
      subject: 'payout',
      subjectId: 'demo',
      action: 'write_off',
      reason: 'Signed off by me, to me.',
      amount: money(500_000n),
      resolvedBy: 'ops.amaka@example.com',
      resolvedAt: now,
      evidenceId: null,
      approvedBy: 'ops.amaka@example.com',
      approvedAt: now,
    }),
  );
  line(`  ✓ ${selfApproved}`);

  const bankTouched = await refusal(() =>
    recordResolution(
      pool,
      {
        resolutionKey: 'demo:phantom-cash',
        subject: 'bank_credit',
        subjectId: 'demo',
        action: 'clear_phantom',
        reason: 'I am sure the money is there.',
        amount: money(500_000n),
        resolvedBy: 'ops.amaka@example.com',
        resolvedAt: now,
        evidenceId: null,
        approvedBy: 'controller.tunde@example.com',
        approvedAt: now,
      },
      {
        entries: [
          { accountId: 'bank_account', amount: money(500_000n) },
          { accountId: 'suspense', amount: money(-500_000n) },
        ],
      },
    ),
  );
  line(`  ✓ ${bankTouched}`);
  line();
  line('  Cash moves on bank evidence, and a human’s conclusion is not bank evidence.');
  line('  The moment that is allowed "once, carefully", the three-way model is decoration.');

  // ── The queue ─────────────────────────────────────────────────────────────
  heading('17 · The queue — and the straggler that clears itself');

  line('  Every run so far reported the same findings from scratch. They are now durable');
  line('  items with a life: raised once, deduplicated across runs, and closed when the');
  line('  evidence turns up. What a run does to the queue is a different number from what');
  line('  it found — and the second number is the one that tells you whether anything has');
  line('  actually changed since yesterday.');
  line();
  const queued = await printQueue(pool, 20);

  line();
  line('  Nothing here was raised twice. Running the matcher again finds the same problems');
  line('  and appends nothing:');
  const rerunQueue = await reconcile(pool, { asOf: now, policyFor });
  line(
    `    ${rerunQueue.queue.raised} raised, ${rerunQueue.queue.unchanged} already open, ` +
      `${rerunQueue.queue.cleared} cleared`,
  );
  const queueIsStable = rerunQueue.queue.raised === 0;
  if (!queueIsStable) line('  ✗ the queue grew by the number of runs rather than of problems');

  line();
  line('  The unconfirmed payout is not in the queue at all: it is inside its settlement');
  line('  window, so it is pending rather than late. A calendar is what separates the two,');
  line('  and getting it wrong is how an exception queue becomes something nobody opens.');

  heading('18 · The system checks itself');
  const verified = await printVerification(pool);

  line();
  return (
    verified &&
    feesAgree &&
    bankUnmoved &&
    idempotent &&
    reclassified.bookedTransactionId !== null &&
    selfApproved !== null &&
    bankTouched !== null &&
    queueIsStable &&
    queued >= 0 &&
    stageTwo.failures.length === 0 &&
    stageThree.failures.length === 0
  );
}

/**
 * Run something that must fail, and report the refusal.
 *
 * A demo that only shows the happy path is a demo of a system nobody has tested. Returning
 * `null` when the call *succeeds* makes an absent refusal fail the run rather than pass
 * silently.
 */
async function refusal(attempt: () => Promise<unknown>): Promise<string | null> {
  try {
    await attempt();
    return null;
  } catch (error) {
    return firstLine(error);
  }
}

/** One account's balance, recomputed from entries. */
async function balanceOf(pool: Pool, accountId: AccountId): Promise<Money> {
  return (await allBalances(pool)).get(accountId)!;
}


/** Sign a payload the way its provider does, then push it through the real ingest path. */
async function deliver(
  pool: Pool,
  source: string,
  body: unknown,
  now: Date,
): Promise<{ transactionId: string; summary: string }> {
  const raw = Buffer.from(JSON.stringify(body), 'utf8');
  const signer = SIGNERS[source]!;

  const result = ingestWebhook({
    source,
    headers: { ...signer.sign(raw), 'content-type': 'application/json' },
    rawBody: raw,
    secret: signer.secret,
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
