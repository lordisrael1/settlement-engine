import type { Money } from '@recon/canon';
import { money } from '@recon/canon';

/**
 * The one place a foreign amount becomes a canonical one.
 *
 * `@pay-normalize/core` has already done the hard half — it converts every provider's
 * amount convention to integer kobo using string and BigInt math, never `parseFloat`, so
 * nothing arriving here has been through a float. What remains is a representation
 * change: their `Kobo` is a branded `number` guarded against exceeding
 * `MAX_SAFE_INTEGER`; ours is a `bigint`, because Postgres stores `BIGINT` and we would
 * rather not carry a ceiling at all.
 *
 * Widening a safe integer to `bigint` is exact, so this conversion cannot lose a kobo.
 * The assertion below guards the one thing that could go wrong — a non-integer reaching
 * this function from outside the library's guarantees.
 */
export function toMoney(kobo: number): Money {
  if (!Number.isSafeInteger(kobo)) {
    throw new RangeError(
      `Expected an integer kobo amount from the connector, got ${String(kobo)}. ` +
        `A non-integer here means a float escaped the connector boundary.`,
    );
  }
  return money(BigInt(kobo));
}
