/**
 * Randomness that is a function of its seed, and of nothing else.
 *
 * `Math.random` would make a failing scenario unreproducible, which in an adversarial suite
 * is the same as not having found the bug: "the matcher escalated something on Tuesday" is
 * not a defect report. Every draw here comes from an integer seed, so a red build hands you
 * the one number needed to reproduce it exactly, on any machine, forever (determinism).
 *
 * `mulberry32` rather than a dependency: thirty-two bits of state and four operations, with
 * no cryptographic claim attached, because none is wanted. What is wanted is that the same
 * seed yields the same file bytes in five years.
 */
export interface Random {
  /** A float in `[0, 1)`. */
  next(): number;
  /** An integer in `[min, max]`, inclusive at both ends. */
  int(min: number, max: number): number;
  /** One element, chosen uniformly. Throws on an empty list rather than returning null. */
  pick<T>(items: readonly T[]): T;
  /** A copy of `items` in a shuffled order. The input is not touched. */
  shuffle<T>(items: readonly T[]): T[];
}

export function random(seed: number): Random {
  let state = seed >>> 0;

  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };

  const int = (min: number, max: number): number => min + Math.floor(next() * (max - min + 1));

  return {
    next,
    int,
    pick<T>(items: readonly T[]): T {
      if (items.length === 0) throw new Error('cannot pick from an empty list');
      return items[int(0, items.length - 1)]!;
    },
    /** Fisher-Yates, downward, so the draw sequence is a function of length alone. */
    shuffle<T>(items: readonly T[]): T[] {
      const copy = [...items];
      for (let i = copy.length - 1; i > 0; i -= 1) {
        const j = int(0, i);
        [copy[i], copy[j]] = [copy[j]!, copy[i]!];
      }
      return copy;
    },
  };
}
