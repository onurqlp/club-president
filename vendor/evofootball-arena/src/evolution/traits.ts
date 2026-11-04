import type { Role } from '../sim/types';
import type { PlayerAttributes } from './playerGenome';
import type { PlayerStyle } from './playerStyle';

/**
 * Player TRAITS (Phase 39, style traits Phase 54) — small, readable
 * individuality on top of the attribute vector. DERIVED, never stored: a
 * pure function of (attrs, role, style), so newgens and developing players
 * grow into (and out of) them with no save-schema change. Capped at 2 per
 * player, 9 types total (the anti-soup rule) — and every one has a PLAY
 * effect:
 *
 *   clinical  aimMargin −0.1 (shaves the post)     shooters, finishing
 *   poacher   run target pulls toward the goalmouth ST instinct-finisher
 *   playmaker pass-lane read ×1.15                  technique on the ball
 *   enforcer  tackle +0.04, foul +0.02              the destroyer
 *   engine    stamina drain ×0.9                    the motor
 *   cat       keeper reach +0.12                    GK reflexes
 *
 * The Phase-54 style traits are BADGES OF GENES: their play effect is the
 * personal-style multiplier itself (already live via rolePolicies) — the
 * trait names a bias that is provably shaping decisions, it never adds a
 * second hand-tuned effect on top. The sim's own traitsOf call passes no
 * style (the attr traits' effects stay sim-side; the style ones act
 * through the policy wire):
 *
 *   maverick  longShotW ≥ 1.3                       shoots from anywhere
 *   trickster dribbleBase ≥ 1.3                     take-on addict
 *   shadow    runScore ≥ 1.3                        the late runner
 */
export type Trait =
  | 'clinical' | 'playmaker' | 'enforcer' | 'engine' | 'poacher' | 'cat'
  | 'maverick' | 'trickster' | 'shadow';

export const TRAIT_KEYS: readonly Trait[] = [
  'clinical', 'playmaker', 'enforcer', 'engine', 'poacher', 'cat',
  'maverick', 'trickster', 'shadow',
];

/** Display chips — emoji read on a phone in any language. */
export const TRAIT_EMOJI: Record<Trait, string> = {
  clinical: '🎯',
  playmaker: '🎩',
  enforcer: '🛡️',
  engine: '🔋',
  poacher: '🦊',
  cat: '🐱',
  maverick: '🎲',
  trickster: '🪄',
  shadow: '👻',
};

/** Candidate traits with how far past their bar this player is. */
function candidates(
  a: PlayerAttributes, role: Role, style?: PlayerStyle,
): Array<{ t: Trait; excess: number }> {
  const out: Array<{ t: Trait; excess: number }> = [];
  if (role === 'GK') {
    if (a.reflexes >= 0.85) out.push({ t: 'cat', excess: a.reflexes - 0.85 });
    return out; // keepers are keepers — outfield traits stay outfield
  }
  if (role !== 'DF' && a.finishing >= 0.8) out.push({ t: 'clinical', excess: a.finishing - 0.8 });
  if (role === 'ST' && a.finishing >= 0.75 && a.dribbling < 0.6) {
    out.push({ t: 'poacher', excess: a.finishing - 0.75 });
  }
  if (a.passing >= 0.8) out.push({ t: 'playmaker', excess: a.passing - 0.8 });
  if (a.defending >= 0.8) out.push({ t: 'enforcer', excess: a.defending - 0.8 });
  if (a.pace >= 0.82) out.push({ t: 'engine', excess: a.pace - 0.82 });
  if (style) {
    // Bars at 1.2: the realized population spread is ~±0.05 with tails to
    // ~±0.2 (probe-measured) — 1.3 was unreachable, 1.2 is the honest tail.
    if (style.longShotW >= 1.2) out.push({ t: 'maverick', excess: (style.longShotW - 1.2) * 2 });
    if (style.dribbleBase >= 1.2) out.push({ t: 'trickster', excess: (style.dribbleBase - 1.2) * 2 });
    if (style.runScore >= 1.2) out.push({ t: 'shadow', excess: (style.runScore - 1.2) * 2 });
  }
  return out;
}

/** The 1–2 traits this player IS (deterministic: sorted by excess, ties by
 * table order so equal-excess picks never depend on insertion luck). */
export function traitsOf(a: PlayerAttributes, role: Role, style?: PlayerStyle): Trait[] {
  return candidates(a, role, style)
    .sort((x, y) => y.excess - x.excess || TRAIT_KEYS.indexOf(x.t) - TRAIT_KEYS.indexOf(y.t))
    .slice(0, 2)
    .map((c) => c.t);
}
