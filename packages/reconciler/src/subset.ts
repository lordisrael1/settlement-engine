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
  | { readonly kind: 'undecidable' }
  /**
   * The search never ran: more candidates than `maxCandidates` allows.
   *
   * Distinct from `none`, and the distinction is the difference between two very different
   * sentences to a human. `none` means "we compared every combination of your promises
   * against this payout and none of them fit" — which points at a missing webhook, a
   * duplicated reference, a real data problem. This means "we did not look", and a queue
   * entry that says the first when it means the second sends somebody hunting for a
   * problem that does not exist.
   *
   * It was previously invisible: the pool was silently truncated with `.slice()` and the
   * truncated search reported `none` (ADR-0070).
   */
  | { readonly kind: 'not_attempted'; readonly candidates: number; readonly limit: number };

export interface SubsetLimits {
  /** How many promises may be considered at once. */
  readonly maxCandidates: number;
  /** How many promises one payout may plausibly batch. */
  readonly maxSubsetSize: number;
  /** Hard ceiling on search nodes, so a pathological file cannot stall a run. */
  readonly maxSteps: number;
}

/**
 * The default bound, and what it means for the shape of the deployment.
 *
 * 24 candidates is a *small-batch* bound, and that has to be said plainly rather than
 * discovered: a busy merchant's daily payout routinely covers 50–500 charges, and against
 * such a payout this search does not fail to find an answer — it declines to start
 * (`not_attempted`, raised as `BATCH_TOO_LARGE`).
 *
 * That is survivable today only because arithmetic matching is the *fallback*. Every PSP
 * this repository has an adapter for ships itemised settlement files, so the reference path
 * carries the volume and the subset search handles the residue. A provider that reports
 * payout totals without per-line references would put every large payout through here, and
 * every large payout would escalate.
 *
 * So the number is configurable rather than fixed — `RECON_SUBSET_MAX_CANDIDATES` — and the
 * cost of raising it is stated in `PERFORMANCE.md`: the search is exponential in the
 * candidate count, `maxSteps` is the thing that actually stops it, and raising candidates
 * without raising steps buys `undecidable` rather than answers. See ADR-0070.
 */
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

  const positive = items.filter((item) => valueOf(item) > 0n);
  // Refused rather than truncated. Slicing the pool and searching what is left produces a
  // confident `none` about a question nobody asked — the honest answer is that the search
  // was out of scope, and the caller escalates it as exactly that.
  if (positive.length > limits.maxCandidates) {
    return { kind: 'not_attempted', candidates: positive.length, limit: limits.maxCandidates };
  }

  const pool = positive;
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
