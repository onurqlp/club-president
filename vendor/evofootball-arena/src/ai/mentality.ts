import type { TacticalGenome } from '../evolution/genome';
import { clamp01 } from '../utils/math';

/**
 * Game-state mentality (Phase 35) — teams that KNOW the score and the
 * clock. A pure function of (score diff, display minute, raw genes): NOT
 * gene mutation. The brains read `team.genome` exactly as before; the
 * getter serves this layer's output, so 0:1 at 85' finally plays
 * differently from 0:0 at 5'.
 *
 * The chase must COST (the rubber-band trap): urgency raises risk and
 * pushes bodies forward, which concedes counters — the probe measures
 * goal swing BOTH ways, and evolution must not be able to farm free
 * comebacks.
 */
export interface Mentality {
  /** 0..1 — trailing-late chase intensity. */
  urgency: number;
  /** 0..1 — leading-late shut-down intensity. */
  holding: number;
}

export const NEUTRAL_MENTALITY: Mentality = Object.freeze({ urgency: 0, holding: 0 });

/**
 * The mentality curve. Ramps live on the DISPLAY clock (minute 60→85 for
 * the chase, 65→90 for the shut-down) so the fiction reads right on the
 * scoreboard. Deficit magnitude: a one-goal game is the full chase; down
 * three, heads drop (0.5) — and a side three up cruises (0.25) instead
 * of parking the bus on a won game.
 *
 * `tinker` (Phase 66, N3 — the coach's adjustment personality) scales the
 * response MAGNITUDE: 0.5 reproduces this curve exactly (×1), the stoic
 * halves it (×0.5), the tinkerer runs it half again as hard (×1.5,
 * clamped) — he reaches the full chase EARLIER on the same ramp and keeps
 * pushing games the curve had written off. Direction is football law.
 */
export function mentalityOf(scoreDiff: number, minute: number, tinker = 0.5): Mentality {
  // Ramps start LATE (68'/72') on purpose: the first cut ramped from
  // 60'/65' and the modified state covered so much of every decided match
  // that league goals sank ~0.4 below the band (6-seed paired calibrate
  // vs phase-34.3) — the same play that read as "theater" per-match
  // compounded into suppression per-season. The narrow window keeps the
  // drama where it belongs: the endgame.
  const f = 0.5 + tinker;
  if (scoreDiff < 0) {
    const ramp = clamp01((minute - 68) / 20);
    if (ramp === 0) return NEUTRAL_MENTALITY;
    const mag = scoreDiff === -1 ? 1 : scoreDiff === -2 ? 0.85 : 0.5;
    return { urgency: clamp01(ramp * mag * f), holding: 0 };
  }
  if (scoreDiff > 0) {
    const ramp = clamp01((minute - 72) / 18);
    if (ramp === 0) return NEUTRAL_MENTALITY;
    const mag = scoreDiff === 1 ? 1 : scoreDiff === 2 ? 0.6 : 0.25;
    return { urgency: 0, holding: clamp01(ramp * mag * f) };
  }
  return NEUTRAL_MENTALITY;
}

/**
 * The UNDERDOG SHIFT (Phase 64 — opponent-conditional tactics): a coach
 * who KNOWS he is outgunned bends toward the bus — deep, compact,
 * counter-first, risk-off. `s` is the product of the Elo gap read at
 * kickoff (0 at parity, 1 a full class apart) and the coach's
 * `underdogShift` gene (0 = purist, 1 = pragmatist); the DIRECTION is
 * football law, the MAGNITUDE is DNA. Identity when s = 0 (bit
 * discipline — a purist or a favorite reads his raw genes through the
 * same reference as ever). Static per match: the score/clock response
 * stays applyMentality's job, layered on top.
 */
export function applyUnderdogShift(raw: TacticalGenome, s: number): TacticalGenome {
  if (s <= 0) return raw;
  return {
    ...raw,
    defensiveCompactness: clamp01(raw.defensiveCompactness + s * 0.3),
    formationDepth: clamp01(raw.formationDepth - s * 0.3),
    pressIntensity: clamp01(raw.pressIntensity - s * 0.25),
    counterAttackBias: clamp01(raw.counterAttackBias + s * 0.3),
    riskTolerance: clamp01(raw.riskTolerance - s * 0.15),
    tempo: clamp01(raw.tempo - s * 0.1),
  };
}

/**
 * Apply the mentality to a genome read. Identity (the SAME object) when
 * neutral — bit-identity discipline: a 0:0 match reads the raw genes
 * through the exact same reference it always did.
 *
 * Gene-MODULATED so identities chase differently: a chaos side (high
 * riskTolerance) goes 梭哈, a possession side (high passBias) raises the
 * tempo of its passing game; a press identity keeps hunting even ahead.
 */
export function applyMentality(raw: TacticalGenome, m: Mentality): TacticalGenome {
  if (m.urgency === 0 && m.holding === 0) return raw;
  const u = m.urgency;
  const h = m.holding;
  // The chase's SHAPE was probed (mentality-ab, n=300): risk+press+depth
  // alone sent the trailing side's shot share DOWN (46.4→43.1%) — more
  // possession, fewer shots, more counters conceded: threading through
  // balls into a parked bus is the one thing that never works. Against a
  // deep block the chase shoots from range and stretches it wide, so
  // shootBias/attackingWidth float up and the depth push stays moderate.
  // The bus is THIN on purpose: this sim's block defense is already strong
  // (the Phase 30 wall lesson), and at h·0.22 depth the leader smothered
  // comebacks below the no-mentality baseline — the shut-down is mostly
  // CLOCK (tempo, the keeper's hands, the corner carry), not extra bodies.
  return {
    ...raw,
    riskTolerance: clamp01(raw.riskTolerance + u * (0.18 + 0.22 * raw.riskTolerance) - h * 0.1),
    // Tempo drop first shipped at −0.28·h and league goals sank to
    // 2.18/2.02 on two calibrate seeds (holding state covers most of any
    // decided match's last quarter — the suppression compounds league-wide
    // even though same-seed match pairs looked flat). −0.16 keeps the
    // clock-milking visible without eating the band.
    tempo: clamp01(raw.tempo + u * (0.1 + 0.2 * raw.passBias) - h * 0.16),
    pressIntensity: clamp01(raw.pressIntensity + u * 0.25 - h * 0.2 * (1 - raw.pressIntensity)),
    formationDepth: clamp01(raw.formationDepth + u * 0.15 - h * 0.12),
    shootBias: clamp01(raw.shootBias + u * 0.25),
    attackingWidth: clamp01(raw.attackingWidth + u * 0.15),
  };
}
