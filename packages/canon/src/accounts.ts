/**
 * The chart of accounts — Appendix B of the bible.
 *
 * A fixed, closed set. Adding an account is a deliberate act of domain design, not
 * configuration, so the set lives in code and the type system knows every member.
 */

export type AccountType = 'asset' | 'income' | 'expense' | 'contra_income' | 'holding';

/**
 * Two accounts carry a payment's whole life, and the gap between them is the system.
 *
 *   psp_receivable   a customer paid; the PSP owes us and has not yet handed it over
 *   bank_account     our own bank says the cash is here
 *
 * Nothing moves between them on a PSP's say-so. A settlement report is the PSP's claim
 * about its own future behaviour, and it is recorded in the reconciliation tables — as a
 * `Payout` with status `reported` — where it can be matched, explained and chased without
 * ever pretending to be money. **Only a bank statement moves `bank_account`.**
 *
 * The deductions below exist so that the difference between what we were owed and what
 * arrived is always a named thing rather than a residue. A payout short by ₦4,200 is not
 * a mystery to be absorbed into fees: it is a reserve, or a tax, or a penalty, and those
 * are three different facts with three different futures.
 */

/**
 * The direction an account normally moves.
 * `1` is debit-natural (value in is positive), `-1` is credit-natural.
 *
 * Contra-income accounts are debit-natural precisely because they *reduce* income:
 * a reversal debits a contra account rather than editing the original credit (Law 2).
 */
export type NaturalSign = 1 | -1;

export const CHART_OF_ACCOUNTS = {
  psp_receivable: {
    id: 'psp_receivable',
    type: 'asset',
    naturalSign: 1,
    meaning: 'Money a PSP owes us after a promise, before settlement',
  },
  bank_account: {
    id: 'bank_account',
    type: 'asset',
    naturalSign: 1,
    meaning: 'Real settled cash in our corporate account, confirmed by a bank statement',
  },
  psp_reserve: {
    id: 'psp_reserve',
    type: 'asset',
    naturalSign: 1,
    meaning: 'Rolling reserve or dispute hold withheld by the PSP — still owed, just later',
  },
  taxes_withheld: {
    id: 'taxes_withheld',
    type: 'expense',
    naturalSign: 1,
    meaning: 'VAT, stamp duty or withholding tax deducted at source by the PSP',
  },
  penalties: {
    id: 'penalties',
    type: 'expense',
    naturalSign: 1,
    meaning: 'Fines and penalties a PSP or bank deducted from a payout',
  },
  bank_charges: {
    id: 'bank_charges',
    type: 'expense',
    naturalSign: 1,
    meaning: 'Charges the bank levied on a credit, invisible to the PSP',
  },
  merchant_revenue: {
    id: 'merchant_revenue',
    type: 'income',
    naturalSign: -1,
    meaning: 'Earned income from a payment',
  },
  fees_expense: {
    id: 'fees_expense',
    type: 'expense',
    naturalSign: 1,
    meaning: 'Cost of PSP fees',
  },
  reversals: {
    id: 'reversals',
    type: 'contra_income',
    naturalSign: 1,
    meaning: 'Refunds/reversals of previously recorded payments',
  },
  chargebacks: {
    id: 'chargebacks',
    type: 'contra_income',
    naturalSign: 1,
    meaning: 'Clawbacks initiated after settlement',
  },
  suspense: {
    id: 'suspense',
    type: 'holding',
    naturalSign: 1,
    meaning: 'Phantom credits / unidentified money pending investigation',
  },
} as const satisfies Record<
  string,
  { id: string; type: AccountType; naturalSign: NaturalSign; meaning: string }
>;

export type AccountId = keyof typeof CHART_OF_ACCOUNTS;

export type Account = (typeof CHART_OF_ACCOUNTS)[AccountId];

export const ACCOUNT_IDS = Object.keys(CHART_OF_ACCOUNTS) as readonly AccountId[];

export function isAccountId(value: string): value is AccountId {
  return Object.hasOwn(CHART_OF_ACCOUNTS, value);
}

export function account(id: AccountId): Account {
  return CHART_OF_ACCOUNTS[id];
}
