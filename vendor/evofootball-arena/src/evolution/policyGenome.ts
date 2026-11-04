import { clamp } from '../utils/math';
import type { Rng } from '../utils/rng';
import { DEFAULT_POLICY, type PolicyParams } from '../sim/types';

/**
 * Phase 42 — the emergence pivot's step 3. The ~35 PolicyParams weights the
 * PlayerBrain scores with were a SHARED, hand-tuned constant (DEFAULT_POLICY):
 * every team decided to play the same way and the 14 tactical genes only
 * modulated it, so decision STYLE could never truly diverge. This releases the
 * ATTACKING (42), DEFENSIVE (43) and BUILD-UP (44) style subsets to per-franchise
 * evolution — bounded around each default so a club keeps basic competence
 * (never stops shooting, passing, or defending) while its style (direct vs
 * patient, shoot-happy vs build-up, dribble vs pass, crosses vs through-balls;
 * press vs sit, intercept vs tackle, hoof vs play-out) EMERGES from selection.
 * UNBIASED: no archetypes are prescribed; evolution finds them. The other ~26
 * weights stay at DEFAULT_POLICY — competence scaffolding, not style.
 */
export const POLICY_GENE_KEYS = [
  // Attacking style (Phase 42): how a team decides to create.
  'shootBase', 'dribbleBase', 'passFwdBase', 'passBackPen',
  'throughBase', 'crossBase', 'loftBase', 'longShotW', 'runScore',
  // Defensive style (Phase 43): press/chase vs sit, intercept vs tackle, hoof
  // vs play-out — the out-of-possession identity, also earned by selection.
  'chaseBase', 'markBase', 'interceptScore', 'clearBase', 'clearPressureW',
  // Build-up style (Phase 44): patient short-passing + outlet-seeking + support
  // shape vs direct — how a team plays OUT, also earned by selection.
  'passBase', 'passLaneW', 'passOpenW', 'passOutletMul', 'supportBase',
  // Combo style (Phase 45): the 套路 trigger appetites — 2过1 / third man /
  // 套边. Born at 1.0 (the Phase-34 constants); combo-heavy vs combo-averse
  // is earned by selection.
  'wallPassW', 'thirdManW', 'overlapW',
] as const satisfies readonly (keyof PolicyParams)[];
export type PolicyGeneKey = (typeof POLICY_GENE_KEYS)[number];
export type PolicyGenes = Record<PolicyGeneKey, number>;

/** Each gene lives in [MIN_MUL, MAX_MUL] × its DEFAULT — floored so a team at
 * the low end still does the thing (just reluctantly), capped so it can't run
 * away. Real style room without breaking watchable football. */
const MIN_MUL = 0.5;
const MAX_MUL = 1.7;
const boundsFor = (k: PolicyGeneKey): readonly [number, number] => {
  const d = DEFAULT_POLICY[k];
  return [d * MIN_MUL, d * MAX_MUL];
};

/** Every franchise is born at the hand-tuned DEFAULT and diverges from there —
 * so generation 0 is balanced and any style is EARNED by evolution, not seeded. */
export function defaultPolicyGenes(): PolicyGenes {
  const p = {} as PolicyGenes;
  for (const k of POLICY_GENE_KEYS) p[k] = DEFAULT_POLICY[k];
  return p;
}

export interface PolicyMutateOptions {
  /** Probability each gene mutates. */
  rate?: number;
  /** Gaussian step as a fraction of the gene's full range. */
  scale?: number;
}

export function mutatePolicyGenes(p: PolicyGenes, rng: Rng, opts: PolicyMutateOptions = {}): PolicyGenes {
  const rate = opts.rate ?? 0.4;
  const scale = opts.scale ?? 0.12;
  const out = {} as PolicyGenes;
  for (const k of POLICY_GENE_KEYS) {
    const [lo, hi] = boundsFor(k);
    let v = p[k];
    if (rng.chance(rate)) v += rng.gaussian() * (hi - lo) * scale;
    out[k] = clamp(v, lo, hi);
  }
  return out;
}

/** Gene-wise crossover: each style weight comes from parent A, parent B, or a
 * blend — a reborn club's philosophy is a mix of its two academies'. */
export function crossoverPolicyGenes(a: PolicyGenes, b: PolicyGenes, rng: Rng): PolicyGenes {
  const out = {} as PolicyGenes;
  for (const k of POLICY_GENE_KEYS) {
    const r = rng.next();
    out[k] = r < 0.4 ? a[k] : r < 0.8 ? b[k] : (a[k] + b[k]) / 2;
  }
  return out;
}

/** Cross-franchise style spread (population std dev per gene) — the emergence
 * probe reads this to see whether distinct styles evolved vs all staying put. */
export function policyGeneStd(pop: PolicyGenes[]): Record<PolicyGeneKey, number> {
  const out = {} as Record<PolicyGeneKey, number>;
  const n = Math.max(pop.length, 1);
  for (const k of POLICY_GENE_KEYS) {
    const mean = pop.reduce((s, p) => s + p[k], 0) / n;
    const varc = pop.reduce((s, p) => s + (p[k] - mean) ** 2, 0) / n;
    out[k] = Math.sqrt(varc);
  }
  return out;
}
