/**
 * Money — Law 3.
 *
 * All amounts are integer minor units (kobo). Never a float, never a decimal parsed
 * as a number. Conversion from a source's representation happens exactly once, in the
 * ingest layer, and never again.
 *
 * Amounts are *signed*. In a ledger entry, positive is a debit (value into the account)
 * and negative is a credit (value out of it). See `accounts.ts` for natural signs.
 */

export type Currency = 'NGN';

export interface Money {
  /** Integer minor units. ₦1.00 is `100n`. */
  readonly kobo: bigint;
  readonly currency: Currency;
}

export const KOBO_PER_NAIRA = 100n;

export const ZERO: Money = { kobo: 0n, currency: 'NGN' };

export function money(kobo: bigint, currency: Currency = 'NGN'): Money {
  return { kobo, currency };
}

/**
 * Construct from whole naira. Convenience for fixtures and the chart of accounts —
 * never for parsing source data, which must go through the ingest layer.
 */
export function naira(amount: bigint, currency: Currency = 'NGN'): Money {
  return { kobo: amount * KOBO_PER_NAIRA, currency };
}

export function isZero(amount: Money): boolean {
  return amount.kobo === 0n;
}

export function isNegative(amount: Money): boolean {
  return amount.kobo < 0n;
}

export function negate(amount: Money): Money {
  return { kobo: -amount.kobo, currency: amount.currency };
}

export function add(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return { kobo: a.kobo + b.kobo, currency: a.currency };
}

export function subtract(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return { kobo: a.kobo - b.kobo, currency: a.currency };
}

export function equals(a: Money, b: Money): boolean {
  return a.kobo === b.kobo && a.currency === b.currency;
}

/** Sum of an arbitrary list. An empty list sums to zero NGN. */
export function sum(amounts: readonly Money[]): Money {
  return amounts.reduce<Money>(add, ZERO);
}

/**
 * Law 1, as a predicate. Every ledger transaction's entries must satisfy this.
 * The authoritative enforcement lives in the ledger core's write path; this is the
 * shared definition of what "balanced" means.
 */
export function sumsToZero(amounts: readonly Money[]): boolean {
  return isZero(sum(amounts));
}

/** Human-readable form, for exception context and logs. Never for arithmetic. */
export function format(amount: Money): string {
  const negative = amount.kobo < 0n;
  const absolute = negative ? -amount.kobo : amount.kobo;
  const whole = absolute / KOBO_PER_NAIRA;
  const minor = absolute % KOBO_PER_NAIRA;
  return `${negative ? '-' : ''}₦${whole.toLocaleString('en-NG')}.${minor.toString().padStart(2, '0')}`;
}

function assertSameCurrency(a: Money, b: Money): void {
  if (a.currency !== b.currency) {
    throw new Error(`Currency mismatch: ${a.currency} and ${b.currency} cannot be combined`);
  }
}
