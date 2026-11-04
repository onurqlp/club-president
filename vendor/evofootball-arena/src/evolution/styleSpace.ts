import { GENE_KEYS, type TacticalGenome } from './genome';
import { POLICY_GENE_KEYS } from './policyGenome';
import { DEFAULT_POLICY, type PolicyParams } from '../sim/types';

/**
 * STYLE SPACE (Phase 49 — visibility v1). A club's style is its point in the
 * 33-dimensional space of (14 tactical genes + 19 evolved policy weights).
 * Everything here is DATA-DRIVEN per the emergence meta-rule: nameplates are
 * generated from where a club actually deviates from the CURRENT population
 * (z-scores), never from hand-picked archetype buckets, and the map's axes
 * are whatever dimensions the population actually disagrees on most. The
 * only hand-built part is the VOCABULARY — one football word per dimension
 * direction (substrate, like the genes themselves); which words a club wears
 * is earned by evolution. This replaces `describeIdentity`'s fixed-threshold
 * buckets in the UI.
 */

export interface StyleSource {
  genome: TacticalGenome;
  policy?: Partial<PolicyParams>;
}

/** Substrate grouping for the themed map LENSES (Phase 51.1) — like the
 * naming vocabulary, the grouping is hand-built grammar; which dims a lens
 * actually shows (its axes) stays data-driven (top variance within the
 * theme). Mirrors the policy-gene subsets (attack/defence/build-up). */
export type DimTheme = 'attack' | 'defence' | 'build';

export interface StyleDim {
  key: string;
  kind: 'gene' | 'policy';
  /** Full range of the dim (genes 1.0; policy (1.7−0.5)·default) — lets
   * variances be compared across dims of different physical scales. */
  scale: number;
  theme: DimTheme;
}

const GENE_THEME: Record<string, DimTheme> = {
  passBias: 'build',
  shootBias: 'attack',
  dribbleBias: 'attack',
  pressIntensity: 'defence',
  defensiveCompactness: 'defence',
  attackingWidth: 'attack',
  riskTolerance: 'attack',
  counterAttackBias: 'attack',
  staminaConservation: 'build',
  markingAggression: 'defence',
  keeperAggression: 'defence',
  tempo: 'build',
  formationDepth: 'defence',
  supportDistance: 'build',
};
const POLICY_THEME: Record<string, DimTheme> = {
  shootBase: 'attack', dribbleBase: 'attack', passFwdBase: 'attack', passBackPen: 'attack',
  throughBase: 'attack', crossBase: 'attack', loftBase: 'attack', longShotW: 'attack',
  runScore: 'attack', wallPassW: 'attack', thirdManW: 'attack', overlapW: 'attack',
  chaseBase: 'defence', markBase: 'defence', interceptScore: 'defence',
  clearBase: 'defence', clearPressureW: 'defence',
  passBase: 'build', passLaneW: 'build', passOpenW: 'build',
  passOutletMul: 'build', supportBase: 'build',
};

export const STYLE_DIMS: StyleDim[] = [
  ...GENE_KEYS.map((key) => ({
    key, kind: 'gene' as const, scale: 1, theme: GENE_THEME[key] ?? ('build' as DimTheme),
  })),
  ...POLICY_GENE_KEYS.map((key) => ({
    key, kind: 'policy' as const, scale: DEFAULT_POLICY[key] * 1.2,
    theme: POLICY_THEME[key] ?? ('build' as DimTheme),
  })),
];

/** A club's raw style vector in STYLE_DIMS order. */
export function styleValues(src: StyleSource): number[] {
  const g = src.genome as unknown as Record<string, number>;
  return STYLE_DIMS.map((d) =>
    d.kind === 'gene' ? g[d.key] : src.policy?.[d.key as keyof PolicyParams] ?? DEFAULT_POLICY[d.key as keyof PolicyParams],
  );
}

export interface DimStat {
  mean: number;
  std: number;
}

export function dimStats(pop: number[][]): DimStat[] {
  const n = Math.max(pop.length, 1);
  return STYLE_DIMS.map((_, i) => {
    const mean = pop.reduce((a, row) => a + row[i], 0) / n;
    const varc = pop.reduce((a, row) => a + (row[i] - mean) ** 2, 0) / n;
    return { mean, std: Math.sqrt(varc) };
  });
}

/** The two dims the population disagrees on most (std normalized by each
 * dim's scale) — the season's own axes of style, not designer-picked ones.
 * With a theme, the ranking runs WITHIN that lens's dims only (the lens is
 * substrate grammar; its axes are still earned by the data). */
export function topVarianceDims(stats: DimStat[], theme?: DimTheme): [number, number] {
  const ranked = stats
    .map((s, i) => ({ i, v: s.std / STYLE_DIMS[i].scale }))
    .filter((r) => !theme || STYLE_DIMS[r.i].theme === theme)
    .sort((a, b) => b.v - a.v || a.i - b.i);
  return [ranked[0].i, ranked[1].i];
}

/** Population spread — mean scale-normalized std across all dims. The
 * divergence dashboard plots this per generation: 0 = monoculture. */
export function styleSpread(stats: DimStat[]): number {
  return stats.reduce((a, s, i) => a + s.std / STYLE_DIMS[i].scale, 0) / STYLE_DIMS.length;
}

/**
 * The naming VOCABULARY — one legible football fragment per nameable
 * dimension direction (English source strings; i18n localizes). Dims with no
 * legible word simply can't appear on a nameplate — the grammar is
 * substrate, the combinations are emergent.
 */
const VOCAB: Record<string, { hi?: string; lo?: string }> = {
  // tactical genes
  pressIntensity: { hi: 'High press', lo: 'Passive block' },
  passBias: { hi: 'Pass-first' },
  shootBias: { hi: 'Shoot on sight' },
  dribbleBias: { hi: 'Street dribblers' },
  attackingWidth: { hi: 'Wings unleashed', lo: 'Narrow knife' },
  riskTolerance: { hi: 'All-in risk', lo: 'Safety first' },
  counterAttackBias: { hi: 'Counter-punchers' },
  staminaConservation: { hi: 'Energy misers' },
  markingAggression: { hi: 'Bone-crunchers' },
  keeperAggression: { hi: 'Sweeper keeper' },
  tempo: { hi: 'Up-tempo', lo: 'Slow burn' },
  formationDepth: { hi: 'High line', lo: 'The bus' },
  defensiveCompactness: { hi: 'Compact block' },
  supportDistance: { hi: 'Stretch play', lo: 'Tight triangles' },
  // evolved policy weights
  shootBase: { hi: 'Trigger happy' },
  dribbleBase: { hi: 'Ball carriers' },
  passFwdBase: { hi: 'Vertical passing' },
  passBackPen: { hi: 'Never backwards' },
  throughBase: { hi: 'Through-ball surgeons' },
  crossBase: { hi: 'Cross bombardment' },
  loftBase: { hi: 'Route one' },
  longShotW: { hi: 'Long-range artillery' },
  runScore: { hi: 'Runners in waves' },
  chaseBase: { hi: 'Hunt in packs' },
  markBase: { hi: 'Glue marking' },
  interceptScore: { hi: 'Lane thieves' },
  clearBase: { hi: 'Hoof it clear' },
  passBase: { hi: 'Tiki-taka' },
  supportBase: { hi: 'Swarm support' },
  wallPassW: { hi: 'One-two addicts' },
  thirdManW: { hi: 'Third-man runs' },
  overlapW: { hi: 'Overlap machine' },
};

/**
 * Data-driven nameplate: the up-to-2 most extreme NAMEABLE deviations from
 * the current population (|z| ≥ minZ). A club near the population centre in
 * every nameable dim reads 'Balanced' — being distinctive is earned.
 */
export function nameplateFor(values: number[], stats: DimStat[], minZ = 1.0): string[] {
  const cands: Array<{ word: string; z: number }> = [];
  for (let i = 0; i < STYLE_DIMS.length; i++) {
    const { mean, std } = stats[i];
    // A dim the population agrees on carries no identity — and a tiny std
    // would turn noise into giant z-scores. Floor at 2% of the dim's scale.
    const sd = Math.max(std, STYLE_DIMS[i].scale * 0.02);
    const z = (values[i] - mean) / sd;
    const vocab = VOCAB[STYLE_DIMS[i].key];
    const word = z > 0 ? vocab?.hi : vocab?.lo;
    if (word && Math.abs(z) >= minZ) cands.push({ word, z: Math.abs(z) });
  }
  cands.sort((a, b) => b.z - a.z || a.word.localeCompare(b.word));
  const seen = new Set<string>();
  const out: string[] = [];
  for (const c of cands) {
    if (seen.has(c.word)) continue;
    seen.add(c.word);
    out.push(c.word);
    if (out.length === 2) break;
  }
  return out.length > 0 ? out : ['Balanced'];
}

/** Convenience: nameplates for a whole population at once. */
export function nameplates(clubs: StyleSource[]): string[][] {
  const pop = clubs.map(styleValues);
  const stats = dimStats(pop);
  return pop.map((v) => nameplateFor(v, stats));
}
