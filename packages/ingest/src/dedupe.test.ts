import assert from 'node:assert/strict';
import { test } from 'node:test';

import { dedupe } from './dedupe.js';

const item = (idempotencyKey: string) => ({ idempotencyKey });

test('events seen in an earlier run are dropped', () => {
  const { fresh, duplicates } = dedupe(
    [item('settlement:flutterwave:a'), item('settlement:flutterwave:b')],
    new Set(['settlement:flutterwave:a']),
  );

  assert.deepEqual(fresh.map((i) => i.idempotencyKey), ['settlement:flutterwave:b']);
  assert.deepEqual(duplicates.map((i) => i.idempotencyKey), ['settlement:flutterwave:a']);
});

/**
 * The easy half of Law 4 is remembering earlier runs. The half that gets forgotten is
 * a batch that repeats a record inside itself — an overlapping re-export, or a provider
 * listing one record twice on a page — which does exactly the same damage.
 */
test('an event repeated within one batch is dropped too', () => {
  const { fresh, duplicates } = dedupe([item('a'), item('b'), item('a')]);

  assert.deepEqual(fresh.map((i) => i.idempotencyKey), ['a', 'b']);
  assert.equal(duplicates.length, 1);
});

test('order is preserved and the first occurrence wins', () => {
  const { fresh } = dedupe([item('c'), item('a'), item('b'), item('a')]);
  assert.deepEqual(fresh.map((i) => i.idempotencyKey), ['c', 'a', 'b']);
});

test('an empty batch is not an error', () => {
  const { fresh, duplicates } = dedupe([]);
  assert.equal(fresh.length, 0);
  assert.equal(duplicates.length, 0);
});
