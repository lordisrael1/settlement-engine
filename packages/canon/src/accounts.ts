/**
 * The chart of accounts — Appendix B of the bible.
 *
 * A fixed, closed set. Adding an account is a deliberate act of domain design, not
 * configuration, so the set lives in code and the type system knows every member.
 */

export type AccountType = 'asset' | 'income' | 'expense' | 'contra_income' | 'holding';

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
    meaning: 'Real settled cash in our corporate account',
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
