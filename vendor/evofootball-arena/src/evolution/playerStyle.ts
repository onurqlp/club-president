import { DEFAULT_POLICY, type PolicyParams } from '../sim/types';
import type { Rng } from '../utils/rng';
import { ATTR_KEYS, type PlayerAttributes } from './playerGenome';
import type { PolicyGenes } from './policyGenome';

/**
 * PLAYER PERSONAL STYLE (Phase 54 — Stage 3 W2). A small per-PLAYER
 * decision-bias gene set: how shot-hungry, long-shot-happy, take-on-prone,
 * late-run-driven and combination-minded THIS player is, expressed as
 * MULTIPLIERS on his coach's evolved team policy. The plumbing is the
 * existing `TeamInfo.rolePolicies` wire — the brain already resolves a
 * per-slot policy; this is what finally feeds it.
 *
 * Emergence rules honored: every player is born NEUTRAL (×1.0 — the coach's
 * policy verbatim, bit-identical to pre-54), styles diverge only through
 * inheritance noise + selection (academy bloodline: the successor mutates
 * the retiree's style; rebirth crosses both parents' slots). A style is
 * PERSONAL and fixed for a career — development changes what a player can
 * do, not who he is.
 */

export const PLAYER_STYLE_KEYS = [
  'shootBase', 'longShotW', 'dribbleBase', 'runScore', 'wallPassW',
] as const satisfies readonly (keyof PolicyParams)[];
export type PlayerStyleKey = (typeof PLAYER_STYLE_KEYS)[number];
export type PlayerStyle = Record<PlayerStyleKey, number>;

/** Personal appetite range: a player can halve or half-again his coach's
 * setting, never erase it (competence scaffolding stays the coach's job). */
export const STYLE_MIN = 0.6;
export const STYLE_MAX = 1.5;

/** The team-policy bounds (policyGenome's 0.5–1.7 × default) also cap the
 * COMBINED coach×player value, so a maverick under a maverick coach still
 * plays football. */
const POLICY_MIN_MUL = 0.5;
const POLICY_MAX_MUL = 1.7;

const clampStyle = (v: number): number => Math.max(STYLE_MIN, Math.min(STYLE_MAX, v));

/** Born neutral: the coach's policy verbatim. */
export function neutralStyle(): PlayerStyle {
  const s = {} as PlayerStyle;
  for (const k of PLAYER_STYLE_KEYS) s[k] = 1;
  return s;
}

/** A whole squad of neutrals (founding / migration backfill). */
export function neutralSquadStyles(n: number): PlayerStyle[] {
  return Array.from({ length: n }, () => neutralStyle());
}

/** Academy heredity: the successor is grown in the retiree's image. σ0.15 —
 * measured (player-style probe): crossover blending + D2 rebirth keep
 * pulling personal variance back toward the parental means, so the personal
 * layer needs a louder mutation than attrs (σ0.12) for tails that read. */
export function styleFromBloodline(retiree: PlayerStyle, rng: Rng): PlayerStyle {
  const s = {} as PlayerStyle;
  for (const k of PLAYER_STYLE_KEYS) s[k] = clampStyle(retiree[k] + rng.gaussian() * 0.15);
  return s;
}

/** Position-wise crossover for reborn squads — mirrors crossoverSquads'
 * pick-A / pick-B / blend shape (its own draws; slots stay coherent
 * because both run in slot order). */
export function crossoverSquadStyles(a: PlayerStyle[], b: PlayerStyle[], rng: Rng): PlayerStyle[] {
  return a.map((sa, i) => {
    const sb = b[i] ?? sa;
    const r = rng.next();
    if (r < 0.4) return { ...sa };
    if (r < 0.8) return { ...sb };
    const mix = {} as PlayerStyle;
    for (const k of PLAYER_STYLE_KEYS) mix[k] = (sa[k] + sb[k]) / 2;
    return mix;
  });
}

/**
 * The wire: one player's effective policy — his coach's evolved genes with
 * the personal appetites multiplied in, clamped to the global policy
 * bounds. Returns the personal OVERRIDE subset only (TeamInfo.rolePolicies
 * merges it over DEFAULT_POLICY; non-style keys stay the coach's).
 */
export function applyPlayerStyle(
  coachPolicy: PolicyGenes,
  style: PlayerStyle,
): Partial<PolicyParams> {
  const out: Partial<PolicyParams> = { ...coachPolicy };
  for (const k of PLAYER_STYLE_KEYS) {
    const base = coachPolicy[k] ?? DEFAULT_POLICY[k];
    const lo = DEFAULT_POLICY[k] * POLICY_MIN_MUL;
    const hi = DEFAULT_POLICY[k] * POLICY_MAX_MUL;
    out[k] = Math.max(lo, Math.min(hi, base * style[k]));
  }
  return out;
}

/* ---------------- personal nameplates (data-driven, Phase 54) ---------------- */

/** The player identity space: 8 attributes + 5 personal appetites. The
 * scale lets variances be compared across dims (attrs span 1.0, style
 * multipliers span STYLE_MAX−STYLE_MIN) — exported for the player center's
 * data-driven axes (Phase 56). */
export interface PlayerDim {
  key: string;
  kind: 'attr' | 'style';
  scale: number;
}
export const PLAYER_DIMS: PlayerDim[] = [
  ...ATTR_KEYS.map((key) => ({ key, kind: 'attr' as const, scale: 1 })),
  ...PLAYER_STYLE_KEYS.map((key) => ({ key, kind: 'style' as const, scale: STYLE_MAX - STYLE_MIN })),
];

/** One legible football fragment per nameable direction — the same grammar
 * rule as club nameplates (styleSpace.ts): the VOCABULARY is hand-built
 * substrate, which words a PLAYER wears is earned by where he actually
 * deviates from the current 96-player population. */
const PLAYER_VOCAB: Record<string, { hi?: string; lo?: string }> = {
  pace: { hi: 'Jet heels' },
  passing: { hi: 'Silk passer' },
  dribbling: { hi: 'Glued to the boot' },
  finishing: { hi: 'Killer touch' },
  defending: { hi: 'The wall' },
  strength: { hi: 'Ox strong' },
  stamina: { hi: 'Iron lungs' },
  reflexes: { hi: 'Spring cat' },
  shootBase: { hi: 'Shot hungry', lo: 'Never shoots' },
  longShotW: { hi: 'The howitzer' },
  dribbleBase: { hi: 'Take-on artist', lo: 'Keeps it simple' },
  runScore: { hi: 'Ghost runner' },
  wallPassW: { hi: 'One-two brain' },
};

export interface PlayerDimStats {
  mean: number[];
  std: number[];
}

export function playerVector(attrs: PlayerAttributes, style: PlayerStyle): number[] {
  return PLAYER_DIMS.map((d) =>
    d.kind === 'attr' ? attrs[d.key as keyof PlayerAttributes] : style[d.key as PlayerStyleKey]);
}

/** Population stats over every player in the league (16 clubs × 6). */
export function playerDimStats(vectors: number[][]): PlayerDimStats {
  const n = Math.max(vectors.length, 1);
  const mean = PLAYER_DIMS.map((_, i) => vectors.reduce((a, v) => a + v[i], 0) / n);
  const std = PLAYER_DIMS.map((_, i) =>
    Math.sqrt(vectors.reduce((a, v) => a + (v[i] - mean[i]) ** 2, 0) / n));
  return { mean, std };
}

/** Up to 2 fragments where this player z-deviates ≥ minZ from the current
 * population; an unremarkable player wears NO plate (being someone is
 * earned — there is no 'Balanced' participation badge for people). */
export function playerNameplate(vec: number[], stats: PlayerDimStats, minZ = 1.25): string[] {
  const cands: Array<{ word: string; z: number }> = [];
  for (let i = 0; i < PLAYER_DIMS.length; i++) {
    // Attrs span 0..1, style mults 0.6..1.5 — the std floor keeps a
    // near-uniform population from minting giant z-scores out of noise.
    const floor = PLAYER_DIMS[i].kind === 'attr' ? 0.02 : 0.018;
    const z = (vec[i] - stats.mean[i]) / Math.max(stats.std[i], floor);
    const vocab = PLAYER_VOCAB[PLAYER_DIMS[i].key];
    const word = z > 0 ? vocab?.hi : vocab?.lo;
    if (word && Math.abs(z) >= minZ) cands.push({ word, z: Math.abs(z) });
  }
  cands.sort((a, b) => b.z - a.z || a.word.localeCompare(b.word));
  const out: string[] = [];
  for (const c of cands) {
    if (!out.includes(c.word)) out.push(c.word);
    if (out.length === 2) break;
  }
  return out;
}

/**
 * Style fit between two players (Phase 80, N6): 1 = identical appetites,
 * 0 = maximally apart across the style box. Pure; the market's signal.
 */
export function styleFit(a: PlayerStyle, b: PlayerStyle): number {
  let d = 0;
  for (const k of PLAYER_STYLE_KEYS) d += Math.abs(a[k] - b[k]);
  return 1 - d / (PLAYER_STYLE_KEYS.length * (STYLE_MAX - STYLE_MIN));
}
