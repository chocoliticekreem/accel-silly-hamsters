// Small deterministic RNG (mulberry32) so the mock city is identical on every reload.

export type Rng = () => number;

export function rng(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Stable integer seed from any mix of strings and numbers. */
export function seedOf(...parts: (string | number)[]): number {
  let h = 2166136261;
  for (const ch of parts.join("|")) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return h >>> 0;
}

export const between = (r: Rng, lo: number, hi: number) => lo + (hi - lo) * r();
export const intBetween = (r: Rng, lo: number, hi: number) => Math.floor(between(r, lo, hi + 1));
export const pick = <T>(r: Rng, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)];

/** Weighted pick; returns -1 if every weight is 0. */
export function weighted(r: Rng, weights: number[]): number {
  const sum = weights.reduce((a, b) => a + b, 0);
  if (sum <= 0) return -1;
  let x = r() * sum;
  for (let i = 0; i < weights.length; i++) {
    x -= weights[i];
    if (x <= 0) return i;
  }
  return weights.length - 1;
}
