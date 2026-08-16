/**
 * The bank statement — the third record, and the only one that proves anything.
 *
 * A webhook is the customer's bank telling the PSP. A settlement report is the PSP telling
 * us. Both are claims by parties with an interest in the answer. The bank statement is our
 * own bank telling us what is in our own account, and it is the only document in the system
 * whose word is final. **Nothing books to `bank_account` without one.**
 *
 * That is not pedantry. A PSP that reports a payout and then does not send it, a payout the
 * bank returns two days later, a credit that arrives short because the correspondent bank
 * took a charge — every one of those is invisible to a system that books cash when the PSP
 * says so, and every one of them is a real Tuesday.
 */

import type { RowLineage } from './evidence.js';
import type { IdempotencyKey, PayoutReference, Reference } from './identifiers.js';
import type { Money } from './money.js';

export type BankEntryDirection = 'credit' | 'debit';

/**
 * One line on a bank statement.
 *
 * `narration` is the free-text the bank attached, and it is the hardest field in the
 * system: it is often the only thing linking a credit to a payout, and it is unreliable,
 * truncated, and inconsistent between banks. It is kept verbatim as evidence, and a
 * reference *extracted* from it travels separately in `extractedReference` — so that the
 * act of guessing is visible, attributable to the parser, and never confused with a
 * reference the bank actually gave us in a structured field.
 */
export interface BankStatementLine {
  /** The bank's own transaction id, where it gives one. */
  readonly reference: Reference;
  /** Which of our accounts this landed in. */
  readonly bankAccountId: string;
  readonly direction: BankEntryDirection;
  readonly amount: Money;
  /** The balance after this line, when the statement reports one. Used to detect gaps. */
  readonly balanceAfter: Money | null;

  readonly valueDate: Date;
  readonly narration: string;
  /**
   * Every candidate identifier the parser could see in the narration, uppercased.
   *
   * Deliberately *candidates*, not a conclusion. The parser's job ends at "these are the
   * things in this string that look like they could be a reference"; deciding that one of
   * them names a particular payout is the matcher's, and it does so by comparing against
   * payouts it actually holds. A parser that picked one would be guessing invisibly, and
   * the guess would be indistinguishable from a reference the bank really gave us.
   */
  readonly narrationTokens: readonly string[];
  /**
   * A payout reference the *bank* supplied in a structured field, not one read out of
   * prose. Almost always `null` — which is why the tokens above exist.
   */
  readonly statedReference: PayoutReference | null;

  readonly evidenceId: string;
  /** Which row of the statement. The answer to "show me that credit" is a line, not a file. */
  readonly lineage: RowLineage;
  readonly idempotencyKey: IdempotencyKey;
}

/**
 * A statement line that is money arriving. Debits are somebody else's story — an outgoing
 * payment, a standing order — and this system has no opinion about them.
 */
export function isCredit(line: BankStatementLine): boolean {
  return line.direction === 'credit' && line.amount.kobo > 0n;
}
