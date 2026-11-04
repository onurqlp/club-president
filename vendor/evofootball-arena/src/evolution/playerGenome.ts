import { clamp01 } from '../utils/math';
import type { Rng } from '../utils/rng';
import type { Role } from '../sim/types';

/**
 * Squad DNA — per-player attribute genes that evolve alongside the team's
 * TacticalGenome. All 0..1, all read directly by the simulation, so squads
 * feel physically different, not just tactically different.
 *
 * Phase 47 (the emergence pivot's attribute richness): the overloaded
 * `technique` split into PASSING (striking a ball toward a target: pass /
 * cross / through / loft / switch / FK accuracy+power) and DRIBBLING
 * (the ball at the feet: first touch, carry control, tackle resistance,
 * 1v1s, shot strike), plus two new payoff dimensions:
 *
 *   pace       top speed & acceleration (±12% speed)
 *   passing    pass/cross/loft accuracy and power retention
 *   dribbling  first touch, carry push control, beating a man
 *   finishing  shot accuracy (spread) and shot confidence
 *   defending  tackle success + tighter marking
 *   strength   aerial power, shielding, the 50/50 shove
 *   stamina    fatigue drain & recovery rate
 *   reflexes   keeper save probability & reach — GK-ONLY. Only the keeper
 *              (squad[0]) ever reads it; for the eight outfielders it is a
 *              DEAD stat, so `squadTotal` no longer charges them for it
 *              (Phase-120 engine-input cleanup — see squadTotal below).
 */
export interface PlayerAttributes {
  pace: number;
  passing: number;
  dribbling: number;
  finishing: number;
  defending: number;
  strength: number;
  stamina: number;
  reflexes: number;
  /**
   * POSITIONING (Phase 119j) — the mover's IQ, orthogonal to pace (how fast)
   * and dribbling/passing (how clean the touch): WHERE to be, WHEN to move,
   * and how well to receive under pressure. It scales OUTCOMES that were
   * uniform before (first-touch reception the first wiring point; run timing,
   * space-finding and defensive reads to follow), so the off-ball
   * dilemma-creators (overload / seam run / give-and-go / cover) become
   * evolvable and can PAY — the enabler five failed levers (119c, 119d-1,
   * 119i) all lacked. Appended LAST in ATTR_KEYS so founders' other attrs
   * draw byte-identical; SQUAD_BUDGET raised 36→40.5 to keep the tuned 0.5
   * density, so positioning is a real budget TRADE-OFF, not free.
   */
  positioning: number;
}

export const ATTR_KEYS = [
  'pace', 'passing', 'dribbling', 'finishing', 'defending', 'strength', 'stamina', 'reflexes',
  'positioning',
] as const;
export type AttrKey = (typeof ATTR_KEYS)[number];

/** Squad slot order (mirrors sim/types ROLES): [GK, DF, MF, WGL, WGR, ST]. */
export const SQUAD_ROLES: Role[] = ['GK', 'DF', 'MF', 'WG', 'WG', 'ST'];
/** The full roster (Phase 61): starters + a 3-man bench with NOMINAL roles
 * (market matching / records / founding bias — on the pitch a sub assumes
 * the slot he replaces). Mirrors sim/types ROSTER_ROLES. */
export const ROSTER_ROLES: Role[] = [...SQUAD_ROLES, 'DF', 'MF', 'ST'];

/** Each role tends to be born good at its job (bias added, then clamped).
 * strength/stamina carry NO bias (Phase 47) — where the physical game pays
 * is evolution's to discover. (ROLE_BIAS itself retires in the budget
 * phase: newgens will inherit their slot's bloodline instead.) */
const ROLE_BIAS: Record<Role, Partial<PlayerAttributes>> = {
  GK: { reflexes: 0.3 },
  DF: { defending: 0.25 },
  MF: { passing: 0.2 },
  WG: { pace: 0.25 },
  ST: { finishing: 0.25 },
};

export function randomPlayer(rng: Rng, role: Role): PlayerAttributes {
  const p = {} as PlayerAttributes;
  for (const k of ATTR_KEYS) p[k] = rng.range(0.1, 0.7);
  const bias = ROLE_BIAS[role];
  for (const k of Object.keys(bias) as AttrKey[]) p[k] = clamp01(p[k] + (bias[k] ?? 0));
  return p;
}

/** A founding ROSTER (Phase 61): six starters + three bench players, all
 * role-biased at birth (bias is only a starting point — bloodline heredity
 * owns the long run). */
export function randomSquad(rng: Rng): PlayerAttributes[] {
  return ROSTER_ROLES.map((role) => randomPlayer(rng, role));
}

export interface SquadMutateOptions {
  /** Probability each attribute of each player mutates. */
  rate?: number;
  /** Std-dev of gaussian noise. */
  scale?: number;
}

export function mutateSquad(squad: PlayerAttributes[], rng: Rng, opts: SquadMutateOptions = {}): PlayerAttributes[] {
  const rate = opts.rate ?? 0.35;
  const scale = opts.scale ?? 0.1;
  return squad.map((p) => {
    const out = { ...p };
    for (const k of ATTR_KEYS) {
      if (rng.chance(rate)) out[k] = clamp01(out[k] + rng.gaussian() * scale);
    }
    return out;
  });
}

/**
 * Position-wise crossover: for each squad slot the child inherits that slot's
 * player from parent A, parent B, or a blend — like signing a mixed starting
 * five from both academies.
 */
export function crossoverSquads(a: PlayerAttributes[], b: PlayerAttributes[], rng: Rng): PlayerAttributes[] {
  return a.map((pa, i) => {
    const pb = b[i];
    const r = rng.next();
    if (r < 0.4) return { ...pa };
    if (r < 0.8) return { ...pb };
    const mix = {} as PlayerAttributes;
    for (const k of ATTR_KEYS) mix[k] = (pa[k] + pb[k]) / 2;
    return mix;
  });
}

/**
 * The RESOURCE BUDGET (Phase 48 — the emergence keystone): a hard cap on a
 * squad's total attribute points. Without it evolution maxes EVERY attribute
 * ("good at everything" wins) and archetypes stay faint; with it, raising
 * one attribute COSTS another and specialisation is forced. SQUAD-level on
 * purpose: star-plus-role-players vs a balanced six is itself an evolvable
 * axis. Phase 61 (the bench): the budget covers the whole 9-man ROSTER —
 * 40.5 = 9 players × 9 attrs × 0.5 (Phase 119j raised it 36→40.5 with the
 * positioning attr, keeping the tuned 0.5 density so the existing physics
 * still centres on 0.5 and positioning is a real trade-off, not free). That
 * makes rotation a REAL trade-off: a deep bench is funded by shaving the
 * starting six, a star XI leaves its bench (and its fresh legs) thin.
 * Founding rosters roll ~0.4 density, so there is headroom before the cap bites.
 *
 * Phase-120 (POSITION-AWARE budget — 门将底座和外场不一样): the budget now
 * charges each slot only for the attributes that actually FIRE for its
 * position. `reflexes` is keeper-only (the 8 outfielders never read it), and
 * symmetrically `finishing` + `defending` are DEAD for the keeper (a GK never
 * shoots, and its 1v1s/claims resolve on reflexes, not tackles) — so the
 * keeper's budget base is its OWN: reflexes + distribution + physique +
 * positioning, not the outfield scoring/tackling stats. The cap dropped
 * 40.5 → 35.5 IN LOCKSTEP (was 81 attr-slots × 0.5; now 8 outfield-reflexes +
 * GK-finishing + GK-defending = 10 dead slots are free → 71 counted × 0.5 =
 * 35.5) so USEFUL-attr density stays the tuned 0.5 and physics is unmoved.
 * The point is not more quality — it closes the "dump" (evolution could park
 * points in a dead stat to dodge the cap); now every point trades against a
 * LIVE attribute, sharpening specialisation.
 */
export const SQUAD_BUDGET = 35.5;

/**
 * Which attributes cost budget for a slot (Phase-120 position-aware). The
 * keeper (index 0 by invariant — Team.goalkeeper === players[0], ROSTER_ROLES
 * [0] === 'GK', retirees replaced like-for-like at the same slot) pays for
 * everything EXCEPT finishing/defending (dead for a GK); every outfielder pays
 * for everything EXCEPT reflexes (keeper-only). The uncounted attrs still
 * exist and still get scaled by enforceBudget — they just ride along free, so
 * the counted total lands exactly on the cap.
 */
export function countsForBudget(k: AttrKey, isGK: boolean): boolean {
  if (isGK) return k !== 'finishing' && k !== 'defending';
  return k !== 'reflexes';
}

export function squadTotal(squad: PlayerAttributes[]): number {
  let t = 0;
  for (let i = 0; i < squad.length; i++) {
    const p = squad[i];
    const isGK = i === 0;
    for (const k of ATTR_KEYS) if (countsForBudget(k, isGK)) t += p[k];
  }
  return t;
}

/** Proportional rescale onto the cap — pure, order-free, unbiased (evolution
 * chooses where the shave lands by choosing where the points sit). */
export function enforceBudget(squad: PlayerAttributes[]): PlayerAttributes[] {
  const total = squadTotal(squad);
  if (total <= SQUAD_BUDGET) return squad;
  const mul = SQUAD_BUDGET / total;
  return squad.map((p) => {
    const out = {} as PlayerAttributes;
    for (const k of ATTR_KEYS) out[k] = p[k] * mul;
    return out;
  });
}

/**
 * Academy heredity (Phase 48): a retiring player's successor is grown in the
 * club's image — the retiree's attribute profile, mutated. This retires
 * ROLE_BIAS from the newgen path (the bias survives only at FOUNDING, where
 * selection has nothing to work with yet): what a club's left winger IS is
 * now bloodline, discovered by evolution, not set by us. The age curve
 * regrows a 17-year-old's inherited profile from there.
 *
 * School-linked variation (Phase 94): the academy grows what the coach's
 * philosophy NEEDS. The jockey school's problem was DISCOVERY, not payoff —
 * containment only pays as a defending+jockeyBias PACKAGE, a two-locus
 * valley that drift rarely crosses in a 16-club population (phases 88/92).
 * So the newgen intake drifts along the philosophy axis: a containment
 * coach (jockeyBias>0.5) pulls the heir toward defending, a dive-in coach
 * pulls toward pace — a zero-sum transfer on one axis (max ±0.12, one
 * mutation σ), on top of unbiased bloodline noise. Fitness stays pure
 * results and founders stay random: this biases VARIATION, not selection.
 */
export function newgenFromBloodline(
  retiree: PlayerAttributes, rng: Rng, coachJockeyBias = 0.5,
): PlayerAttributes {
  const out = {} as PlayerAttributes;
  for (const k of ATTR_KEYS) out[k] = clamp01(retiree[k] + rng.gaussian() * 0.12);
  const pull = (coachJockeyBias - 0.5) * 0.24;
  out.defending = clamp01(out.defending + pull);
  out.pace = clamp01(out.pace - pull);
  return out;
}

/** Squad-average of each attribute — shown on team cards. */
export function squadSummary(squad: PlayerAttributes[]): PlayerAttributes {
  const sum = {} as PlayerAttributes;
  for (const k of ATTR_KEYS) sum[k] = 0;
  for (const p of squad) for (const k of ATTR_KEYS) sum[k] += p[k];
  for (const k of ATTR_KEYS) sum[k] /= Math.max(squad.length, 1);
  return sum;
}
