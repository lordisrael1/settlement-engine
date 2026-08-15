/**
 * @recon/canon — the canonical domain language.
 *
 * One definition of each domain concept, in one place, that everyone imports. This
 * package depends on nothing and everything depends on it: that is Law 7 (the canonical
 * boundary) expressed as code structure.
 *
 * Read the files in this order to learn the domain:
 *   money.ts        what an amount is                    (Law 3)
 *   accounts.ts     where value can sit                  (Appendix B)
 *   identifiers.ts  how events are named and deduped     (Law 4)
 *   ledger.ts       the double-entry record itself       (Laws 1, 2)
 *   payment.ts      the promise — fast information
 *   settlement.ts   the money — slow cash
 *   matching.ts     what reconciliation concluded, and why
 */

export * from './money.js';
export * from './accounts.js';
export * from './identifiers.js';
export * from './ledger.js';
export * from './payment.js';
export * from './settlement.js';
export * from './matching.js';
