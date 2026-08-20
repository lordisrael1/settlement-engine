/**
 * Bounded subset-sum: which combination of these promises adds up to that payout?
 *
 * This is tier 3's engine. A settlement line often carries no reference we can match on —
 * a batched payout is one money movement covering many charges, and the file names the
 * payout, not the charges. All that is left to reason with is the arithmetic.
 *
 * Two properties matter more than speed:
 *
 * **It refuses to guess.** If two different combinations both hit the target, the answer
 * is `undecidable`, not the first one found. A wrong batch match does not fail loudly —
 * it silently moves the wrong promises to `settled`, leaving the right ones to escalate
 * later as mysteries. Escalating an ambiguous payout costs a human five minutes; guessing
 * costs them a week of not knowing anything is wrong.
 *
 * **It is bounded.** Subset-sum is exponential, and a settlement file is attacker-adjacent
 * input. The search carries an explicit step budget and gives up rather than stalling a
 * reconciliation run; giving up escalates, which is safe.
 */

export type SubsetOutcome<T> =
  | { readonly kind: 'unique'; readonly subset: readonly T[] }
  | { readonly kind: 'none' }
  /** More than one combination fits, or the search ran out of budget. We do not guess. */
  | { readonly kind: 'undecidable' };

export interface SubsetLimits {
  /** How many promises may be considered at once. */
  readonly maxCandidates: number;
  /** How many promises one payout may plausibly batch. */
  readonly maxSubsetSize: number;
  /** Hard ceiling on search nodes, so a pathological file cannot stall a run. */
  readonly maxSteps: number;
}

export const DEFAULT_SUBSET_LIMITS: SubsetLimits = {
  maxCandidates: 24,
  maxSubsetSize: 12,
  maxSteps: 200_000,
};

/**
 * The one combination of `items` whose values sum to `target`, if there is exactly one.
 *
 * `items` must already be in the caller's canonical order: the search is deterministic,
 * and its determinism is inherited from that order, not manufactured here (determinism).
 * Non-positive values are dropped, because a zero-valued item would make every solution
 * that contains it a second, spurious "distinct" answer.
 */
export function uniqueSubsetSummingTo<T>(
  items: readonly T[],
  valueOf: (item: T) => bigint,
  target: bigint,
  limits: SubsetLimits = DEFAULT_SUBSET_LIMITS,
): SubsetOutcome<T> {
  if (target <= 0n) return { kind: 'none' };

  const pool = items.filter((item) => valueOf(item) > 0n).slice(0, limits.maxCandidates);
  const values = pool.map(valueOf);

  // Largest reachable sum from index i onwards, so a branch that can no longer reach the
  // target is abandoned instead of explored to the end.
  const reachable: bigint[] = new Array<bigint>(pool.length + 1).fill(0n);
  for (let i = pool.length - 1; i >= 0; i -= 1) {
    reachable[i] = reachable[i + 1]! + values[i]!;
  }

  const solutions: T[][] = [];
  const chosen: T[] = [];
  let steps = 0;
  let exhausted = false;

  const search = (index: number, remaining: bigint): void => {
    if (solutions.length > 1 || exhausted) return;
    if (remaining === 0n) {
      solutions.push([...chosen]);
      return;
    }
    if (index >= pool.length || remaining < 0n || remaining > reachable[index]!) return;
    if (chosen.length >= limits.maxSubsetSize) return;

    steps += 1;
    if (steps > limits.maxSteps) {
      exhausted = true;
      return;
    }

    // Take before skip, so the first solution found is the lexicographically earliest by
    // the caller's ordering — a canonical answer rather than an incidental one.
    chosen.push(pool[index]!);
    search(index + 1, remaining - values[index]!);
    chosen.pop();

    search(index + 1, remaining);
  };

  search(0, target);

  if (exhausted || solutions.length > 1) return { kind: 'undecidable' };
  const only = solutions[0];
  return only ? { kind: 'unique', subset: only } : { kind: 'none' };
}
