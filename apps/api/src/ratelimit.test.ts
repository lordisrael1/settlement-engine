import assert from 'node:assert/strict';
import { test } from 'node:test';

import { FixedWindow } from './ratelimit.js';

/**
 * The limiter is a pure counter over a clock it is handed, so its whole behaviour can be
 * asserted without a socket, a server or a minute of waiting.
 *
 * Proved here rather than through the router deliberately. `api.test.ts` makes hundreds of
 * requests from one address in a few seconds — exactly the shape a limiter exists to refuse —
 * so it runs with the limits off, and this suite constructs the states on purpose instead.
 */

const LIMIT = { perWindow: 3, windowMs: 60_000, maxKeys: 100 };

test('a caller gets its allowance and then a retry-after', () => {
  const windows = new FixedWindow(LIMIT);
  const t0 = 1_000_000;

  for (let request = 1; request <= 3; request += 1) {
    assert.equal(windows.take('1.2.3.4', t0).allowed, true, `request ${request}`);
  }

  const refused = windows.take('1.2.3.4', t0);
  assert.equal(refused.allowed, false);
  // A number the caller can act on, not a bare refusal. Providers back off on `retry-after`.
  assert.equal(refused.retryAfterMs, 60_000);
});

test('the window rolls over', () => {
  const windows = new FixedWindow(LIMIT);
  const t0 = 1_000_000;

  for (let request = 1; request <= 4; request += 1) windows.take('1.2.3.4', t0);
  assert.equal(windows.take('1.2.3.4', t0).allowed, false);

  assert.equal(windows.take('1.2.3.4', t0 + 60_001).allowed, true);
});

/** One noisy caller must not spend another's allowance. */
test('callers are counted separately', () => {
  const windows = new FixedWindow(LIMIT);
  const t0 = 1_000_000;

  for (let request = 1; request <= 5; request += 1) windows.take('1.2.3.4', t0);
  assert.equal(windows.take('1.2.3.4', t0).allowed, false);
  assert.equal(windows.take('5.6.7.8', t0).allowed, true);
});

/**
 * The bound that makes this a defence rather than a new vulnerability.
 *
 * The key space is chosen by whoever is calling — a client address, or a principal name on
 * the management rail — so an unbounded map keyed by attacker-supplied values is a memory
 * exhaustion bug wearing the costume of a rate limiter.
 */
test('the tracked-caller map stays bounded under a rotating source address', () => {
  const windows = new FixedWindow({ perWindow: 3, windowMs: 60_000, maxKeys: 50 });

  for (let caller = 0; caller < 5_000; caller += 1) {
    windows.take(`10.0.${Math.floor(caller / 256)}.${caller % 256}`, 1_000_000);
  }

  assert.ok(windows.size <= 50, `map grew to ${windows.size}`);
});

/**
 * Eviction is allowed to *forget* a caller and must never invent one. A forgotten caller gets
 * a fresh allowance, which is the safe direction: over-refusing a legitimate provider is worse
 * than under-refusing an attacker who is already being handled at the edge.
 */
test('eviction prefers expired windows, and never refuses a first-time caller', () => {
  const windows = new FixedWindow({ perWindow: 1, windowMs: 1_000, maxKeys: 4 });

  for (let caller = 0; caller < 4; caller += 1) windows.take(`old-${caller}`, 1_000);
  // A minute later every one of those windows has expired, so making room costs nothing.
  assert.equal(windows.take('new', 61_000).allowed, true);
});

test('zero disables it entirely', () => {
  const windows = new FixedWindow({ perWindow: 0, windowMs: 60_000, maxKeys: 0 });
  for (let request = 0; request < 1_000; request += 1) {
    assert.equal(windows.take('1.2.3.4', 1_000_000).allowed, true);
  }
});
