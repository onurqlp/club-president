/**
 * Deterministic seeded RNG (mulberry32). Every piece of simulation randomness
 * goes through an Rng instance — never Math.random() — so a match/league seed
 * fully determines its outcome.
 */
export class Rng {
  private s: number;

  constructor(seed: number) {
    this.s = seed >>> 0;
    if (this.s === 0) this.s = 0x9e3779b9;
  }

  /** Uniform float in [0, 1). */
  next(): number {
    this.s = (this.s + 0x6d2b79f5) >>> 0;
    let t = this.s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Uniform float in [a, b). */
  range(a: number, b: number): number {
    return a + (b - a) * this.next();
  }

  /** Uniform integer in [a, b] (inclusive). */
  int(a: number, b: number): number {
    return a + Math.floor(this.next() * (b - a + 1));
  }

  /** True with probability p. */
  chance(p: number): boolean {
    return this.next() < p;
  }

  pick<T>(arr: readonly T[]): T {
    return arr[this.int(0, arr.length - 1)];
  }

  /** Standard normal via Box–Muller (deterministic, consumes 2 draws). */
  gaussian(): number {
    const u1 = Math.max(this.next(), 1e-9);
    const u2 = this.next();
    return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  }

  /** In-place Fisher–Yates shuffle; returns the same array. */
  shuffle<T>(arr: T[]): T[] {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = this.int(0, i);
      const tmp = arr[i];
      arr[i] = arr[j];
      arr[j] = tmp;
    }
    return arr;
  }
}

/** FNV-style hash combiner: derive a child seed from integer parts. */
export function hashSeed(...parts: number[]): number {
  let h = 2166136261 >>> 0;
  for (const p of parts) {
    let x = Math.floor(p) >>> 0;
    // mix twice so nearby ints (round 1 vs round 2) land far apart
    h ^= x;
    h = Math.imul(h, 16777619) >>> 0;
    h ^= h >>> 13;
    x = (x + 0x9e3779b9) >>> 0;
    h ^= x;
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}
