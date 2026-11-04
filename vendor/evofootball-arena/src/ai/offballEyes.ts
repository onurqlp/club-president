// OBM T0 — THE OFF-BALL EYES SEAT (docs/world-model/OBM-T0-DORMANT-SEAM.md).
// Contract: docs/world-model/OFFBALL-MOVEMENT-CONTRACT.md §2 M-OBM.1–4. Ruling #227.
//
// 前插与回撤是同一个选择: the off-ball attacker gains EYES (four continuous features
// read off his OWN percept snapshot) and a gene-weighted POLICY over them. The
// policy's outputs are a dynamic shift on the BANKED CTB support plane (the #224
// limb is this seat's vocabulary) and a bounded modulation of the two candidate
// scores he already has. 前插 / 回撤 is written NOWHERE: it is where the evolved
// weights put a body when the carrier's plight rises and his own marker loosens.
//
// ⭐ EPISTEMIC HONESTY IS THE HARD GATE OF THIS FILE (VISION §1 感知诚实,
// 像人眼一样获得数据). EVERY feature is computed from `match.perceivedSnapshot(p)`
// — the E3R2 recorder trunk with its cone, its range, its keyed noise and its
// staleness — and from the body's own proprioception (`p.pos` / `p.side`, which
// the trunk itself treats as continuously known). NO truth scan, NO new
// information channel, NO omniscience. `perceivedSnapshot` is the ONLY member of
// `match` this module may touch, and that restriction is machine-checked twice
// (G-EPI in the probe and in `tests/obmEyesSeat.test.ts`).
//
// NO PREDICATES (#200): everything is `weight × continuous feature`. The complete
// conditional set of this seat is GATE (the `obmMovement` flag, read by the two
// callers), GUARD (the finite/absent checks in the weight map), ZERO (born-absent
// genes and the no-percept neutral) and CAP (the signed clamps). Nothing here
// DECIDES anything; it scores and it shifts.
//
// Dormant: `obmMovement` is a hard `false` in every production path, so nothing in
// this file is reached in the shipped game.
import { AI_INTERVAL, DT, OFFBALL_TIRED_MUL } from '../sim/constants';
import { clamp, clamp01 } from '../utils/math';
import type { V2 } from '../utils/vec';
import type { Match } from '../sim/Match';
import type { Player } from '../sim/Player';
import type { Side } from '../sim/types';
import { PRESSURE_RADIUS_M } from './perception';
import { perceptionRetentionTicks, type PerceptionSnapshot } from './perceptionSnapshot';
import {
  CTB_GENE_MAX, CTB_GENE_MIN, OBM_FEATURE_KEYS, OBM_OUTPUT_KEYS,
  ctbSupportDepthWeight, ctbSupportWidthWeight, offballMovementWeightVector,
  type TacticalGenome,
} from '../evolution/genome';

/**
 * ⭐ THE FROZEN SCORE-MODULATION SPAN (M-OBM.3, "bounded … traced bounds, zero ⇒
 * exactly today's score arithmetic"). `scoreMul = 1 + output · OBM_SCORE_SPAN`, so
 * the multiplier lives in [0.6, 1.4].
 *
 * TRACED, NOT INVENTED, and DERIVED IN CODE: it IS `1 − OFFBALL_TIRED_MUL`, i.e.
 * exactly the reach of the incumbent fatigue multiplier that `decideOffBall`
 * already applies to THESE TWO SCORES and no others. Chosen by QUESTION IDENTITY
 * (the MT-T0 / CTB-T0 precedent): the engine's standing answer to *"how much may a
 * body's own state scale his support and run scores"* is 0.4 of them, so the
 * perceived-situation policy may express exactly that much and no more — as much
 * upward as the fatigue law already expresses downward.
 *
 * Never re-cut: if OBM-T1 needs a different span that is a fork for the commander
 * WITH numbers, not a quiet re-freeze after sight.
 */
export const OBM_SCORE_SPAN = 1 - OFFBALL_TIRED_MUL;

/**
 * ⭐ THE FROZEN READ CADENCE CAP (M-OBM.4, "the seat reads at the body's existing
 * decision cadence"). A policy computed by the brain is valid for at most this many
 * ticks, after which the executor treats it as absent and modulates NOTHING.
 *
 * TRACED, NOT INVENTED, and DERIVED IN CODE: it IS `AI_INTERVAL / DT` rounded up —
 * the body's OWN decision interval expressed in ticks. The executor runs every tick
 * but the seat must not; this cap is what makes "reads at the existing cadence" a
 * mechanism rather than a promise, and it bounds the percept-pull cost at exactly
 * the existing cadence law the contract names.
 */
export const OBM_POLICY_TTL_TICKS = Math.ceil(AI_INTERVAL / DT);

/** The dynamic position on the banked CTB plane, already composed and clamped. */
export interface ObmPlane {
  readonly depth: number;
  readonly width: number;
}

/** One body's off-ball movement policy at one decision instant. */
export interface ObmPolicy {
  /** f1…f4 in `OBM_FEATURE_KEYS` order, each continuous in [0, 1]. */
  readonly features: readonly number[];
  /** The four raw outputs in `OBM_OUTPUT_KEYS` order, each in [−1, +1]. */
  readonly outputs: readonly number[];
  /** The composed plane position: `clamp(staticGene + dynamicOutput)`. */
  readonly plane: ObmPlane;
  /** `SupportBallCarrier` score multiplier, in [1 − span, 1 + span]. */
  readonly supportMul: number;
  /** Licensed `MakeRun` score multiplier, same bound. */
  readonly runMul: number;
  /** Did the body have a percept snapshot at all? (false ⇒ everything neutral.) */
  readonly sawSnapshot: boolean;
}

const clampSigned = (v: number): number => clamp(v, CTB_GENE_MIN, CTB_GENE_MAX);

/**
 * THE EYES (M-OBM.2). Four continuous features, all from the PERCEPT.
 *
 * Returns a vector of `OBM_FEATURE_KEYS.length` values in [0, 1]:
 *  * **f1 `carrierPlight`** — how closely the nearest opponent HE CAN SEE is
 *    pressing the carrier HE CAN SEE, on the incumbent pressure radius.
 *  * **f2 `ownMarker`** — the same reading taken on HIMSELF: how tight his own
 *    nearest perceived opponent is. FROZEN as pure proximity — goal-side-ness was
 *    considered and deliberately NOT taken at slice one (it would need a second
 *    traced constant and a direction convention, and the contract bounds the
 *    families, it does not oblige their richest form).
 *  * **f3 `targetCongestion`** — the same reading taken at the CANDIDATE POINT he
 *    would otherwise walk to. Note the polarity: like f1 and f2 this RISES with
 *    tightness, so "space at the target" is `1 − f3`. Uniform polarity keeps the
 *    weights readable; a weight's SIGN is what says "go where it is empty".
 *  * **f4 `readingAge`** — the mean AGE of his own opponent readings, normalised by
 *    the perception trunk's own retention horizon. Staleness is DATA here, not a
 *    defect: a body with old eyes may honestly behave differently, and how
 *    differently is the weights' business.
 *
 * ⭐ THE NEUTRAL (a blind body has no policy). No snapshot at all — which is
 * exactly what a world with the percept trunk switched off produces, since
 * `refreshPerception` is gated on `edsPerceivedDefence || edsPerceivedChoice ||
 * stationEye` and `perceivedSnapshot` returns null without a memory — or a
 * snapshot with NO perceived opponent in it, yields ALL FOUR features EXACTLY
 * ZERO, hence every output exactly zero and no modulation whatsoever. Read this
 * honestly: zero is the NO-POLICY point, NOT a claim that he sees no pressure and
 * not a claim that his readings are fresh (the whether-seat's E-NOCELL rule in its
 * continuous form — perceiving nobody is not perceiving nobody THERE).
 *
 * PURE: no rng, no writes, no truth.
 */
export function obmFeatures(
  snapshot: PerceptionSnapshot | null,
  selfPos: Readonly<V2>,
  selfSide: Side,
  candidate: Readonly<V2>,
): number[] {
  const f = new Array<number>(OBM_FEATURE_KEYS.length).fill(0);
  if (snapshot === null) return f;

  const carrierGid = snapshot.ball === null ? null : snapshot.ball.ownerGid;
  let carrierPos: Readonly<V2> | null = null;
  if (carrierGid !== null) {
    for (const seen of snapshot.players) {
      if (seen.gid === carrierGid) { carrierPos = seen.pos; break; }
    }
  }

  let nearSelf = Number.POSITIVE_INFINITY;
  let nearTarget = Number.POSITIVE_INFINITY;
  let nearCarrier = Number.POSITIVE_INFINITY;
  let ageSum = 0;
  let opponents = 0;
  for (const seen of snapshot.players) {
    if (seen.side === selfSide) continue;
    opponents += 1;
    ageSum += seen.ageTicks;
    const dSelf = Math.hypot(seen.pos.x - selfPos.x, seen.pos.y - selfPos.y);
    if (dSelf < nearSelf) nearSelf = dSelf;
    const dTarget = Math.hypot(seen.pos.x - candidate.x, seen.pos.y - candidate.y);
    if (dTarget < nearTarget) nearTarget = dTarget;
    if (carrierPos !== null) {
      const dCarrier = Math.hypot(seen.pos.x - carrierPos.x, seen.pos.y - carrierPos.y);
      if (dCarrier < nearCarrier) nearCarrier = dCarrier;
    }
  }
  if (opponents === 0) return f;

  if (carrierPos !== null) f[0] = clamp01(1 - nearCarrier / PRESSURE_RADIUS_M);
  f[1] = clamp01(1 - nearSelf / PRESSURE_RADIUS_M);
  f[2] = clamp01(1 - nearTarget / PRESSURE_RADIUS_M);
  f[3] = clamp01((ageSum / opponents) / perceptionRetentionTicks(snapshot.awareness));
  return f;
}

/**
 * THE POLICY (M-OBM.3). Genes weight features → outputs; outputs compose with the
 * banked CTB plane and with the two incumbent scores.
 *
 * ```text
 * output_o   = ( Σ_i w[o][i] · f_i ) / OBM_FEATURE_KEYS.length        ∈ [−1, +1]
 * intercept_depth = ctbPlaneArmed ? ctbSupportDepthWeight(g) : 0
 * intercept_width = ctbPlaneArmed ? ctbSupportWidthWeight(g) : 0
 * plane.depth = clamp( intercept_depth + output_planeDepth, −1, +1 )
 * plane.width = clamp( intercept_width + output_planeWidth, −1, +1 )
 * supportMul  = 1 + output_supportScore · OBM_SCORE_SPAN
 * runMul      = 1 + output_runScore     · OBM_SCORE_SPAN
 * ```
 *
 * ⭐ THE INTERCEPT PARTICIPATES ONLY THROUGH ITS OWN GATE (the OBM-T0 verify
 * catch, the #191 correction form). The first cut composed the banked CTB genes
 * into the plane UNCONDITIONALLY, so arming `obmMovement` ALONE — with the policy
 * matrix absent or zero — silently CONSUMED the banked `ctbSupport*` genes and was
 * byte-identical to arming `ctbSupportPlane` alone. That falsified G-BORN/G-ZERO's
 * headline invariant in exactly the flag-crossing configuration neither the probe
 * nor the tests ran. EACH SEAM NOW KEEPS ITS OWN ARMING DOOR:
 *   * obm ON, ctb OFF  ⇒ intercept 0 — the DYNAMIC term alone, on the ZERO plane,
 *     whose zero-point IS the incumbent `supportSpot` geometry;
 *   * obm OFF, ctb ON  ⇒ this function is never reached; the banked static plane
 *     is delivered by `supportSpot`'s own fork, exactly as banked;
 *   * BOTH ON          ⇒ the full policy: the banked intercept plus the slopes.
 * `ctbPlaneArmed` is passed IN by the caller (never read off `match` here) so the
 * module's only `match` member stays `perceivedSnapshot` — G-EPI is untouched.
 *
 * The division by the feature count is the whole bound of the plane half, and it
 * is DERIVED, not chosen: a weight is signed-unit and a feature is unit, so the
 * MEAN of the weighted features spans exactly [−1, +1] — precisely the reach one
 * static plane gene already has. So the DYNAMIC term may say exactly as much as
 * the STATIC term, and when the CTB door is open the static gene is literally the
 * policy's intercept (contract M-OBM.3), the sum living in the banked axis' own
 * domain.
 *
 * ZERO IS ARITHMETIC-EXACT: all weights zero ⇒ every `output_o` is `0` ⇒
 * `plane === (intercept_depth, intercept_width)` by `x + 0` — which is
 * `(0, 0)`, i.e. the incumbent point, with the CTB door shut, and the banked
 * static plane with it open — and `supportMul === runMul === 1` by
 * `1 + 0 · span`, so the call sites' `s *= 1` is an IEEE-754 identity. That is
 * what G-ZERO measures rather than asserts.
 *
 * PURE: no rng, no writes, no truth.
 */
export function obmPolicyOf(
  g: TacticalGenome, features: readonly number[], sawSnapshot: boolean,
  ctbPlaneArmed: boolean,
): ObmPolicy {
  const w = offballMovementWeightVector(g);
  const nFeatures = OBM_FEATURE_KEYS.length;
  const outputs = new Array<number>(OBM_OUTPUT_KEYS.length).fill(0);
  for (let o = 0; o < OBM_OUTPUT_KEYS.length; o++) {
    let acc = 0;
    for (let i = 0; i < nFeatures; i++) acc += w[o * nFeatures + i] * features[i];
    outputs[o] = acc / nFeatures;
  }
  // ⭐ THE CTB DOOR: the banked static genes enter this composition ONLY when their
  // OWN flag is armed. Shut ⇒ a hard `0` intercept, so the seat can never spend a
  // gene bank it was not given the key to.
  const interceptDepth = ctbPlaneArmed ? ctbSupportDepthWeight(g) : 0;
  const interceptWidth = ctbPlaneArmed ? ctbSupportWidthWeight(g) : 0;
  return {
    features,
    outputs,
    plane: {
      depth: clampSigned(interceptDepth + outputs[0]),
      width: clampSigned(interceptWidth + outputs[1]),
    },
    supportMul: 1 + outputs[2] * OBM_SCORE_SPAN,
    runMul: 1 + outputs[3] * OBM_SCORE_SPAN,
    sawSnapshot,
  };
}

/**
 * The seat as the brain calls it: pull THIS body's own snapshot, read the four
 * features off it, weight them. Called once per off-ball decision (never per
 * tick), from the single `obmMovement` fork in `PlayerBrain.decideOffBall`.
 *
 * `candidate` is the body's OWN intention — the support point he would ACTUALLY
 * take with the seat absent, i.e. `supportSpot(p, team, ball, match.ctbSupportPlane)`
 * under WHATEVER flag state the world is in. It is his plan, not information about
 * anybody else; the SPACE reading taken at it (f3) is entirely percept. The point
 * is the seat-absent one on purpose, so the policy's own output can never feed back
 * into its own input — self-feedback avoidance is about the OBM output, not about
 * the banked static plane, which is part of the world he stands in.
 *
 * `ctbPlaneArmed` is the CTB seam's OWN flag, handed in by the caller (see
 * `obmPolicyOf`): this module never reads it off `match`, so the G-EPI source pin
 * — `perceivedSnapshot` is the only `match` member named here — still holds.
 */
export function obmOffballPolicy(
  p: Player, match: Match, g: TacticalGenome, candidate: Readonly<V2>,
  ctbPlaneArmed: boolean,
): ObmPolicy {
  const snapshot = match.perceivedSnapshot(p);
  return obmPolicyOf(
    g, obmFeatures(snapshot, p.pos, p.side, candidate), snapshot !== null, ctbPlaneArmed,
  );
}
