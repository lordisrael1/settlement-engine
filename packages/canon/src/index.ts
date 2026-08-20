/**
 * @recon/canon — the canonical domain language.
 *
 * One definition of each domain concept, in one place, that everyone imports. This
 * package depends on nothing and everything depends on it, which is the canonical boundary
 * expressed as code structure.
 *
 * Read the files in this order to learn the domain:
 *   money.ts        what an amount is                      (integer kobo)
 *   accounts.ts     where value can sit                    (the chart of accounts)
 *   identifiers.ts  how events are named and deduped       (idempotency)
 *   ledger.ts       the double-entry record itself         (balance-zero, append-only)
 *   payment.ts      record one — the promise, from a webhook
 *   settlement.ts   record two — one payment inside a PSP's payout report
 *   payout.ts       …and the payout itself, with its named deductions
 *   bank.ts         record three — the bank statement, the only proof of cash
 *   zone.ts         wall-clock time in a named place
 *   calendar.ts     when money is actually late, in business days
 *   fees.ts         what we expected to be charged, per contract, channel and date
 *   evidence.ts     the documents we reasoned from, and the humans who decided
 *   matching.ts     what reconciliation concluded, and why
 *   exception.ts    a difference nobody has explained yet, and its lifecycle
 *   anomaly.ts      drift in a foreign format, before it becomes a difference
 *   events.ts       everything that happened, in order, as one narrative
 */

export * from './money.js';
export * from './accounts.js';
export * from './identifiers.js';
export * from './ledger.js';
export * from './payment.js';
export * from './settlement.js';
export * from './payout.js';
export * from './bank.js';
export * from './zone.js';
export * from './calendar.js';
export * from './fees.js';
export * from './evidence.js';
export * from './matching.js';
export * from './exception.js';
export * from './anomaly.js';
export * from './events.js';
