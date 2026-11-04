// DV T0 — THE DORMANT RISK-PRICING SEAM (docs/world-model/DV-T0-DORMANT-SEAM.md).
// Contract: docs/world-model/DELIVERY-VALUE-CONTRACT.md §2 M-DV.1 / M-DV.2 (as amended by
// ruling #247) / M-DV.3. Rulings #245 (the map-vs-reality audit), #246 (method reality's,
// numbers this world's, SHAPE the fidelity check), #247 (⭐⭐ TRUTH vs BELIEF), #248 (the
// earned-knowledge ledger — this is the PILOT), #249 (DV-C0 banked, DV-T0 queued).
//
// 出球价值: the delivery pricer's map has two holes the #244 arc named. This seam adds the
// RISK limbs and nothing else:
//
//   (1) FLIGHT EXPOSURE (M-DV.1) — "can this be cut out ON THE WAY", a continuous hazard
//       over the ball's own travel, computed from the SAME opponent-position source the
//       pricer's corridor read already consumes. It is the corridor read MADE
//       TIME-AWARE: `laneOpenness`'s own geometry with the opponent's own closing
//       capability over the flight subtracted from the distance he still lacks.
//   (2) THE LOSS-COST BELIEF (M-DV.2 as amended by #247) — "what would losing it THERE
//       cost me", read as THREE evolvable per-zone weights applied to the candidate's
//       RECEPTION zone.
//
// ⭐⭐ THE #247 TRUTH/BELIEF SPLIT IS THE LAW OF THIS FILE, and it is structural, not a
// promise. THE TRUE TABLE — DV-C0's census-measured turnover→goal-against hazard, which
// lives in that stage's committed artifact — is INSTRUMENT-SIDE. It is not imported
// here, not typed here, and neither its file name nor any of its values appears anywhere
// in `src/**` (G-NOTABLE greps the whole tree for exactly that, on the artifact's own
// numbers rather than on a copy). What this file owns is the player's BELIEF: three
// weights BORN ABSENT, which a team can only ever acquire by evolving them. A wrong
// belief is legal and is STYLE. The census's ZONING is imported (the boundary is
// `HALF_L / 3`, re-derived from the pitch's own constant below) — the zoning is the
// STRUCTURE of the question, and per #248.1 structural dimensions may be hand-built; the
// ANSWERS (the hazards) are what must be earned.
//
// ⭐ NO NEW CHANNEL (M-DV §6 感知诚实). This module takes `opponents` — the very array
// `laneOpenness(p.pos, aim, opp.players)` is already called with one statement earlier —
// and `Player.topSpeed`, a body's knowledge of its own physics (#248.1: legitimately
// innate). It does not take `Match` at all, so it CANNOT read a percept snapshot, a
// truth channel or anything else: the epistemic pin is that the module's import list and
// its signature make the wider world unreachable. The DV term is therefore exactly as
// honest — no more, no less — as the corridor read it extends.
//
// ⭐ NO PREDICATES (#200). Both limbs are continuous and unconditional. The complete
// conditional set of this file is GATE (the arming rule), GUARD (`sentOff` and the
// clear-the-kicker radius, both inherited VERBATIM from `laneOpenness`), ZONE (the
// census's frozen three-way classifier — a SELECTOR that decides which evolvable weight
// is read, never whether an action happens) and the running max's comparison, which is
// `laneOpenness`'s own aggregation written as a max instead of a min.
//
// Dormant: `dvDeliveryValue` is a hard `false` in every production path, so nothing in
// this file is reached in the shipped game.
import { clamp, clamp01 } from '../utils/math';
import { add, closestPointOnSegment, dist, scale } from '../utils/vec';
import type { V2 } from '../utils/vec';
import { BALL_RADIUS, GRAVITY, HALF_L, HEADER_MIN_HEIGHT } from '../sim/constants';
import type { Player } from '../sim/Player';
import {
  DV_BELIEF_SLOTS, dvExposureWeightOf, dvLossBeliefVector, type TacticalGenome,
} from '../evolution/genome';
import { PTP_FLIGHT_SPEED } from './passLeadSeat';

/**
 * ⭐ THE FROZEN FLIGHT SPEED — TRACED, NOT INVENTED, and not even re-typed: it IS the
 * banked PTP-T0 seat's exported constant, imported.
 *
 * `PTP_FLIGHT_SPEED = 18` is the through-ball loop's own flight-time divisor
 * (`src/ai/PlayerBrain.ts`: `const flight = dist(p.pos, mate.pos) / 18;`), chosen there
 * by QUESTION IDENTITY — *"how long is the ball travelling on the way to him"* — which
 * is the exact question this limb's hazard is integrated over. Reusing the SAME symbol
 * (rather than a second literal) means the pass-lead family and the exposure family can
 * never drift apart.
 */
export const DV_FLIGHT_SPEED = PTP_FLIGHT_SPEED;

/**
 * ⭐ THE FROZEN CORRIDOR SCALE — TRACED, NOT INVENTED.
 *
 * `4` is `laneOpenness`'s OWN metre normalizer, `src/ai/perception.ts`:
 * `worst = Math.min(worst, clamp01(d / 4));`
 * i.e. the engine's standing answer to *"how many metres off a passing lane does a
 * defender have to be before he is irrelevant to it"*. The exposure limb asks that
 * question with the flight TIME added, so it takes the corridor family's own scale
 * whole. G-TRACE asserts the source line VERBATIM, so the family cannot drift.
 */
export const DV_CORRIDOR_SCALE = 4;

/**
 * ⭐ THE FROZEN CLEAR-THE-KICKER RADIUS — TRACED, NOT INVENTED.
 *
 * `1.5` is `laneOpenness`'s OWN guard, `src/ai/perception.ts`:
 * `if (dist(cp, from) < 1.5) continue; // Ignore defenders standing right on top of the passer`
 * — the kick clears a body at the passer's feet. The exposure limb inherits it verbatim
 * rather than inventing its own near-field rule. G-TRACE asserts the source line.
 */
export const DV_CLEAR_RADIUS = 1.5;

/**
 * ⭐⭐ THE ZONING — the census's own, RE-DERIVED from the pitch, never typed.
 *
 * DV-C0 §FORM froze the primary table's boundary as `HALF_L / 3` (itself the #188 /
 * PM-T1 `OWN_THIRD_LOCAL_X`, inherited through the #214 goal-genealogy census), in the
 * LOSING team's own frame: `localX < −HALF_L/3` = own third · `> +HALF_L/3` = final
 * third · else middle. This is the ONLY thing this file takes from the census — the
 * SHAPE OF THE QUESTION. Per #247 the ANSWERS (the hazard values) stay instrument-side
 * and are never wired into a player.
 */
export const DV_THIRD_BOUNDARY_LOCAL_X = HALF_L / 3;

/** The FROZEN zone order of the belief vector — the census's own `ordering` axis. */
export const DV_ZONES = ['own', 'middle', 'final'] as const;
export type DvZone = (typeof DV_ZONES)[number];

/**
 * The seat as the brain holds it for ONE on-ball decision: the two evolvable taste
 * weights, and nothing else. There is no world state in here at all — see the
 * no-new-channel note at the head of this file.
 */
export interface DeliveryValueSeat {
  /** `dvExposureWeightOf(g)` ∈ [0,1]. 0 ⇒ the exposure term is exactly `+0`. */
  readonly exposureWeight: number;
  /** The three per-zone loss-cost beliefs ∈ [0,1], in `DV_ZONES` order. */
  readonly belief: readonly number[];
}

/**
 * ⭐ THE ARMING RULE (M-DV.3's form for this stage), in ONE place: the risk price is
 * formed only when the flag's door is open (the caller's single fork) AND at least one
 * of the four DV genes is NON-ABSENT.
 *
 * Returning `null` for a fully absent set is the BORN-ABSENT IDENTITY made STRUCTURAL
 * rather than merely arithmetic: with no seat the pricer never computes an exposure,
 * never reads a belief and never performs the subtraction — it runs the shipped
 * statements alone. (With ANY of the four present the seat forms and the subtraction
 * happens at whatever the weights are; at all-zero the subtraction is exactly `−(+0)`,
 * which is an IEEE-754 identity. That identity is MEASURED as G-ZERO, not assumed.)
 *
 * PURE: no rng, no writes, no reads of anything but the genome.
 */
export function deliveryValueSeatOf(g: TacticalGenome): DeliveryValueSeat | null {
  if (g.dvExposureWeight === undefined && g.dvLossBelief === undefined) return null;
  return { exposureWeight: dvExposureWeightOf(g), belief: dvLossBeliefVector(g) };
}

/**
 * ⭐⭐ LIMB ONE — THE FLIGHT EXPOSURE (M-DV.1). THE EXACT FORM, and it is a MAX over the
 * opponents of a per-opponent hazard evaluated AT HIS OWN CLOSEST APPROACH to the flight:
 *
 * ```text
 * exposure(from, aim) = max over opponents o, o not sent off:
 *     cp    = closestPointOnSegment(from, aim, o.pos)      [laneOpenness's own geometry]
 *     SKIP    if dist(cp, from) < DV_CLEAR_RADIUS          [laneOpenness's own guard]
 *     t(o)  = dist(from, cp) / DV_FLIGHT_SPEED             [the ball's travel time to cp]
 *     lack  = dist(cp, o.pos) − o.topSpeed · t(o)          [the metres he STILL lacks
 *                                                           after closing for the whole
 *                                                           flight — his CAPABILITY]
 *     e(o)  = 1 − clamp01(lack / DV_CORRIDOR_SCALE)        [laneOpenness's own scale]
 *   with exposure = 0 when no opponent contributes.
 * ```
 *
 * ⭐ WHY THIS FORM AND NOT A SAMPLED INTEGRAL (declared sharpening — the contract says
 * "integrated over the ball's own travel" and is silent on the quadrature). A sampled
 * integral needs a SAMPLE COUNT, which would be an invented constant, and it needs a
 * per-sample kernel, which would be a second invented shape. The closest-approach point
 * is where the corridor family ALREADY evaluates a defender against a lane — it is the
 * point that maximises his chance over the whole segment for a straight-line closer — so
 * this form is the same integral's arg-max taken exactly, at zero new constants. The
 * aggregation over bodies is `laneOpenness`'s own (`worst = min`, here written as a
 * running max because exposure is openness's complement), so a lane's exposure is set by
 * its most dangerous body exactly as its openness is set by its nearest one.
 *
 * ⭐ IT DEGENERATES ONTO TODAY'S CORRIDOR READ, which is what makes it a SHARPENING and
 * not a new sense: at `topSpeed = 0` (or `t = 0`) the expression is
 * `1 − clamp01(d / 4)` — precisely `1 −` the term `laneOpenness` contributes for that
 * body. Everything the limb adds is the metres he can cover WHILE THE BALL FLIES.
 *
 * ⚠ HONEST LIMIT (stated, not hidden): the closing model is `topSpeed · t` — a body's own
 * top speed times the flight, with no acceleration, no reaction delay and no facing. It
 * is deliberately the CHEAPEST capability that is still time-aware; the engine's richer
 * `estimateReach` account belongs to the observer instruments (it needs a reach profile
 * and a percept snapshot), and importing it here would be a new channel. So this limb
 * OVERSTATES a stationary defender's closing and understates nothing.
 *
 * PURE: no rng, no writes, no allocation beyond `closestPointOnSegment`'s own.
 */
export function flightExposure(
  from: Readonly<V2>, aim: Readonly<V2>, opponents: readonly Player[],
  aloft: BkCorridorFlight | null = null,
): number {
  let worst = 0;
  for (const o of opponents) {
    if (o.sentOff) continue;
    const cp = closestPointOnSegment(from as V2, aim as V2, o.pos);
    // GUARD (laneOpenness's own, verbatim): the kick clears a body at the passer's feet.
    if (dist(cp, from as V2) < DV_CLEAR_RADIUS) continue;
    // BK T3 §SEAM — THE HEIGHT HALF (the ONE statement this stage adds to the corridor
    // loop). `aloft === null` in every shipped/DV path ⇒ the loop below is HEAD's,
    // character for character. Aloft, a body the flight passes ENTIRELY above (across the
    // whole of his own strike shell) is not on the line at all and contributes nothing.
    if (aloft !== null && bkCorridorClearsBody(aloft, dist(from as V2, cp), o)) continue;
    const t = dist(from as V2, cp) / DV_FLIGHT_SPEED;
    const lack = dist(cp, o.pos) - o.topSpeed * t;
    const e = 1 - clamp01(lack / DV_CORRIDOR_SCALE);
    if (e > worst) worst = e;
  }
  return worst;
}

/**
 * THE ZONE SELECTOR — the census's frozen three-way classification of a RECEPTION point,
 * given its `localX` in the PASSING team's own frame (which is the LOSER's frame: the
 * team that would pay for the turnover is the team playing the pass).
 *
 * ⚠ THIS IS A SELECTOR, NOT A PREDICATE (#200), and the distinction is exact: it decides
 * WHICH of three evolvable weights is read, never whether a candidate forms, competes or
 * wins. Every zone's weight is born absent and evolves independently; a team whose three
 * weights are equal is a team for which the zoning does not exist at all.
 */
export function receptionZoneIndex(localX: number): number {
  if (localX < -DV_THIRD_BOUNDARY_LOCAL_X) return 0; // own third
  if (localX > DV_THIRD_BOUNDARY_LOCAL_X) return 2; // final third
  return 1; // middle third
}

/**
 * ⭐⭐ THE COMPOSITION (M-DV.3), the WHOLE of it, in ONE owner:
 *
 * ```text
 * score′ = score − wExposure · exposure(from, aim) − belief[zone(aim)] · valueScale
 * ```
 *
 * returned here as the SUBTRACTION ITSELF, so the pricer's line reads `s − price(...)`.
 *
 * * `wExposure` and `belief[·]` are the born-absent genes. NO taste term beyond these
 *   two (the #236 no-taste lesson): no attribute, no mode multiplier, no gene of the
 *   incumbent chain, no threshold.
 * * `valueScale` is handed IN by the caller and is the pricer's OWN base value of a pass,
 *   `W.passBase` — the traced scale (declared: the alternative `W.passLaneW` was
 *   rejected because that is the weight on a CORRIDOR quantity, whereas a loss cost is a
 *   VALUE quantity, and `passBase` is the score's own statement of what a pass is worth
 *   before its qualities). It rides the per-player policy, so a wildcard carrying learned
 *   weights scales this term by his own.
 * * The exposure limb carries NO scale of its own — that is the commander's frozen form
 *   (`score − w·exposure`), kept literal rather than quietly normalised.
 *
 * ⭐ THE ZERO-POINT IS IEEE-EXACT, BY ARITHMETIC. With every weight 0 the return is
 * `0 · e + 0 · v`, i.e. exactly `+0` for any finite non-negative `e` and `v`, and
 * `s − (+0) === s` for every finite `s` (and for `−0`). So an armed world whose genes are
 * all zero prices byte-identically to the shipped one, with the code path LIVE. G-ZERO
 * measures that; it does not assume it.
 *
 * PURE: no rng, no writes.
 */
export function deliveryRiskPrice(
  seat: DeliveryValueSeat,
  from: Readonly<V2>,
  aim: Readonly<V2>,
  opponents: readonly Player[],
  aimLocalX: number,
  valueScale: number,
): number {
  const exposure = flightExposure(from, aim, opponents);
  const belief = seat.belief[receptionZoneIndex(aimLocalX)];
  return seat.exposureWeight * exposure + belief * valueScale;
}

/** The belief vector's frozen width, re-exported so consumers need one import. */
export const DV_ZONE_COUNT = DV_BELIEF_SLOTS;

/* ========================================================================== */
/* BK T3 — THE CORRIDOR-HAZARD PRICE (docs/world-model/BK-T3-CORRIDOR-HAZARD.md) */
/* ========================================================================== */
/**
 * ⭐⭐ THE HEIGHT-AWARE CORRIDOR PRICE FOR THE LOFTED DELIVERY CHOOSERS. Authorized by
 * ruling #333 item 5 (the ratified design pick of #331 item 3), serving the USER MANDATE
 * of #328/#330: 门将开球直接弹到身体上然后弹回来 — the keeper looks at who is standing in
 * front of him before he hits it, and a coach who values that can LEARN to value it.
 *
 * WHY IT EXISTS, measured, not assumed (BK-C1 §R4/§R6/§R8): 85.9 % of blocked GK lofted
 * launches had a clearing line available at the same target inside the shipped
 * parameterization; raising the ceiling flips ZERO of them; the pressure signature has no
 * rising limb (blind launching); and the punt's own score carries NO lane, corridor or
 * flight term at all. The gap is PRICING.
 *
 * ⛔ WHAT THIS IS NOT (#328 item 3, held absolutely): no default arc is raised, no launch
 * parameterization is touched, and there is no hand rule saying "don't hit people". This
 * is a PRICE on the option the chooser is already comparing. The chooser decides.
 *
 * ⭐ NO NEW MAGNITUDE. Every quantity below is either an anchored src extraction (the
 * strike surface's own 1.35 m edge and its own shell, `GRAVITY`, the four family tuples
 * `loftKick` is CALLED with) or the DV seat's own already-traced corridor constants
 * (`DV_CLEAR_RADIUS`, `DV_CORRIDOR_SCALE`, `DV_FLIGHT_SPEED`). The only threshold is
 * DERIVED (#200): the contact law's own strike edge, so the price asks exactly the
 * question the contact law answers.
 *
 * ⭐ THE GENE IS THE DV SEAT'S OWN, BORN ABSENT. The price is `deliveryRiskPrice`'s
 * EXPOSURE LIMB — the same `dvExposureWeight` gene, the same IEEE-exact zero point — with
 * the height half added. The LOSS-BELIEF limb is deliberately NOT extended to lofted
 * deliveries (that would be a second pricing decision this slice was not given).
 */
export interface BkCorridorFamily {
  readonly tBase: number;
  readonly tPerM: number;
  readonly tMin: number;
  readonly tMax: number;
}

/**
 * ⭐ THE FOUR FAMILY TUPLES — the ARGUMENTS the engine already calls `loftKick` with, at
 * its own NAMED call sites, transcribed here and PINNED to those sites by anchored
 * extraction (canon: "a src-extracted constant pins its extraction to the NAMED call
 * site — anchored match + line receipt — never first-occurrence"). Nothing in
 * `mechanics.ts` is edited: the literals stay where the strike reads them, and the pin
 * suite fails the moment these two representations drift.
 *
 * `punt` and `loftSwitch` are ONE family — both are `performLoftedPass`, which is why the
 * punt's arc was never the keeper's own dial (BK-C1 §R2: the whole arc is one number, T).
 * The CROSS family is deliberately ABSENT: 92/116 crosses blocked short is a wide-play
 * question of its own (BK-C1 §R8's honest exclusion), and an absent family cannot be
 * priced by accident.
 */
export const BK_CORRIDOR_FAMILIES = {
  /** `performLoftedPass` — the open-play switch AND the keeper's punt. */
  loft: { tBase: 0.55, tPerM: 0.033, tMin: 1.1, tMax: 2.1 },
  /** `performKeeperThrow` — the hand distribution's gentle arc. */
  keeperThrow: { tBase: 0.62, tPerM: 0.03, tMin: 0.9, tMax: 1.5 },
  /** `performThroughBall`'s LOFTED branch — the dink over the top. */
  dink: { tBase: 0.55, tPerM: 0.045, tMin: 0.8, tMax: 2.0 },
} as const satisfies Record<string, BkCorridorFamily>;

/**
 * The flight as the CHOOSER can know it, before any noise draw: the family's own flight
 * time at the design distance, and that distance. `loftKick`'s own expression
 * (`const T = clamp(tBase + dEff * tPerM, tMin, tMax);`) evaluated at the design distance
 * `d` rather than the struck `dEff` — the chooser prices the ball he MEANS to hit, which
 * is the only ball he can price (the range error is drawn inside the strike, after the
 * choice, and reading it here would be a truth channel).
 */
export interface BkCorridorFlight {
  readonly d: number;
  readonly T: number;
}

/** `loftKick`'s own clamp, at the design distance. */
export function bkCorridorFlightOf(family: BkCorridorFamily, d: number): BkCorridorFlight {
  return { d, T: clamp(family.tBase + d * family.tPerM, family.tMin, family.tMax) };
}

/**
 * ⭐⭐ THE TRAJECTORY'S OWN HEIGHT at along-line distance `x`, from the family's own T and
 * nothing else — BK-C1's closed form, re-derived rather than sampled:
 *
 * `loftKick` launches `vz = GRAVITY·T/2` at `|v| = d/T`, so `x = (d/T)·t` and
 * `z = vz·t − g·t²/2` ⇒ `z(x) = (g·T²/2)·(x/d)·(1 − x/d)`, a symmetric parabola whose
 * apex is `g·T²/8` at `x = d/2`. Exact for the airborne phase (an airborne ball is
 * friction-free, BK-C1 §5), spin-invariant (Magnus rotates the path, not the height).
 */
export function bkCorridorHeightAt(x: number, flight: BkCorridorFlight): number {
  const u = x / flight.d;
  return ((GRAVITY * flight.T * flight.T) / 2) * u * (1 - u);
}

/**
 * ⭐⭐ THE HEIGHT GATE — "does this ball fly OVER him", asked with the strike surface's own
 * geometry so the price asks exactly the question the contact law answers (BK-C1 §R3):
 *
 * * the SHELL is the contact law's own (`Match.ts`: `const shell = p.coreRadius +
 *   ball.radius;`), taken from the BODY's own core and the ball's own radius;
 * * the EDGE is the armed partition's own (`Match.ts`: `ball.z >= HEADER_MIN_HEIGHT` ⇒
 *   heads; below it the ENTIRE ground channel), so a body can only be struck where the
 *   flight sits UNDER 1.35 m.
 *
 * `z` is concave, so its minimum over the shell interval sits at an ENDPOINT — no
 * sampling, no sample count to invent. Cleared ⇔ the flight stays at or above the strike
 * edge across the whole of his shell. Outside `[0, d]` the parabola is NEGATIVE, so a body
 * straddling the launch or the landing is never cleared — which is the truth (the ball IS
 * on the grass there). ⭐ NO CLIPPING TERM: an explicit clamp to `[0, d]` was DROPPED
 * because it is provably inert here — it can only raise a negative height to `0`, and both
 * are below the strike edge. Every term left in this function is pinned.
 */
export function bkCorridorClearsBody(
  flight: BkCorridorFlight, along: number, body: Player,
): boolean {
  if (!(flight.d > 0)) return false;
  const shell = body.coreRadius + BALL_RADIUS;
  const lowest = Math.min(
    bkCorridorHeightAt(along - shell, flight),
    bkCorridorHeightAt(along + shell, flight),
  );
  return lowest >= HEADER_MIN_HEIGHT;
}

/**
 * ⭐ THE HAZARD — `flightExposure`'s SHIPPED form restricted to the bodies this flight can
 * actually strike. It DEGENERATES onto the shipped exposure exactly (every body kept)
 * when the flight never clears anybody, which is what makes it a SHARPENING of the
 * corridor read and not a new sense; and it is `0` for a delivery that flies over
 * everyone. Range [0, 1], `flightExposure`'s own.
 */
export function bkCorridorHazard(
  from: Readonly<V2>, aim: Readonly<V2>, opponents: readonly Player[],
  family: BkCorridorFamily,
): number {
  return flightExposure(from, aim, opponents, bkCorridorFlightOf(family, dist(from as V2, aim as V2)));
}

/**
 * ⭐⭐ THE PRICE, the whole of it: `wExposure · hazard`, returned as the SUBTRACTION so a
 * chooser's line reads `s -= bkCorridorPriceOf(...)`.
 *
 * It is `deliveryRiskPrice`'s exposure limb at `deliveryRiskPrice`'s own born-absent gene:
 * no scale of its own, no attribute, no mode multiplier, no threshold, no second gene.
 * THE ZERO POINT IS IEEE-EXACT: at `exposureWeight = 0` the return is `0 · h`, i.e.
 * exactly `+0` for any finite non-negative `h`, and `s − (+0) === s` for every finite `s`
 * — so an armed world whose gene is zero prices BYTE-IDENTICALLY with the path LIVE.
 *
 * PURE: no rng, no writes.
 */
export function bkCorridorPriceOf(
  seat: DeliveryValueSeat,
  from: Readonly<V2>, aim: Readonly<V2>, opponents: readonly Player[],
  family: BkCorridorFamily,
): number {
  return seat.exposureWeight * bkCorridorHazard(from, aim, opponents, family);
}

/**
 * ⭐⭐ BK T4 §RIDER — THE LEAD THE STRIKE ACTUALLY USES (authorized by ruling #335 item 5;
 * the gap disclosed at BK-T3 §P10 item 4 and struck as a verify LOW at #334 item 3).
 *
 * `performLoftedPass` and `performKeeperThrow` do NOT strike at the receiver's body: each
 * computes its own `flight0` — the family's own `clamp(tBase + d·tPerM, tMin, tMax)` at the
 * BODY distance — and then strikes at
 *
 * ```text
 * const lead = add(mate.pos, scale(mate.vel, flight0 * 0.7));   ← both call sites, verbatim
 * ```
 *
 * BK-T3 priced `mate.pos` (M-PTP.4's body pricing), so the priced line and the FLOWN line
 * disagreed by a measured mean 0.72 m — the chooser paid for a corridor the ball never
 * flew down. This function is that same lead, and nothing else: the family's own T from
 * `bkCorridorFlightOf` (one owner, no re-typed clamp) times the strike's own
 * `BK_CORRIDOR_LEAD_FLIGHT_FRACTION`, applied to the target's own velocity.
 *
 * ⭐ NO NEW MAGNITUDE and NO NEW CHANNEL: `0.7` is an anchored extraction of the two
 * shipped strike sites, and a receiver's own `vel` is already read by the shipped choosers
 * (`passMul`, `runBurstPoint`) one statement away. THE FLOWN BALL IS UNTOUCHED —
 * `mechanics.ts` is byte-identical; this changes only WHICH LINE THE PRICE READS.
 *
 * ⚠ DECLARED, NOT CLOSED (the honest bound): the DINK's own strike leads through
 * `runBurstPoint(runner, team, opp, flight0 · 0.85)`, a different machine, and its chooser
 * already prices a PROJECTED point rather than a standing body. That aim gap is NOT closed
 * here — the authorization named the `0.7·flight` lead of these two strike sites.
 *
 * PURE: no rng, no writes.
 */
export const BK_CORRIDOR_LEAD_FLIGHT_FRACTION = 0.7;

/** Exactly what the two shipped strike sites read off their target: position and velocity. */
export interface BkCorridorTarget {
  readonly pos: Readonly<V2>;
  readonly vel: Readonly<V2>;
}

export function bkCorridorLeadAim(
  from: Readonly<V2>, target: BkCorridorTarget, family: BkCorridorFamily,
): V2 {
  const flight0 = bkCorridorFlightOf(family, dist(from as V2, target.pos as V2)).T;
  return add(
    target.pos as V2,
    scale(target.vel as V2, flight0 * BK_CORRIDOR_LEAD_FLIGHT_FRACTION),
  );
}

/**
 * ⭐ THE PRICE AT THE LED AIM — `bkCorridorPriceOf` at `bkCorridorLeadAim`'s point, so a
 * chooser's line stays ONE statement and the two representations of "which line is priced"
 * can never drift apart. A STATIONARY target leads by exactly `+0` metres, so this returns
 * `bkCorridorPriceOf`'s own value bit for bit (the pin suite measures that identity rather
 * than assuming it), and at `exposureWeight = 0` it is still exactly `+0`.
 *
 * PURE: no rng, no writes.
 */
export function bkCorridorPriceLed(
  seat: DeliveryValueSeat,
  from: Readonly<V2>, target: BkCorridorTarget, opponents: readonly Player[],
  family: BkCorridorFamily,
): number {
  return bkCorridorPriceOf(
    seat, from, bkCorridorLeadAim(from, target, family), opponents, family,
  );
}

/* ========================================================================== */
/* GC T0 — THE GROUND-CORRIDOR HAZARD (docs/world-model/GC-T0-DORMANT-SEAM.md) */
/* ========================================================================== */
/**
 * ⭐⭐ THE GROUND LINE'S OWN SHELL PREDICATE — BK-C2 §P.4's discriminator, TRANSLATED, and
 * nothing is invented here. Contract `GC-GROUND-CORRIDOR-CONTRACT.md` §2 M-GC.2; ruling
 * #343 item 4; serving the user's play-test RED of #341 (弹身体感觉很影响比赛).
 *
 * ```text
 * groundShellHazard(from, aim) = 1 iff SOME body o satisfies all of:
 *     o is NOT sent off
 *     o.gid !== kickerGid                                  [the kicker is not on his own line]
 *     o.gid !== receiverGid                                [BK-C1 §4(ii)'s ARRIVING RULE]
 *     dist(closestPointOnSegment(from, aim, o.pos), o.pos) < o.coreRadius + BALL_RADIUS
 *     dist(from, cp) < dist(from, aim) − (o.coreRadius + BALL_RADIUS)   [SHORT OF THE TARGET]
 *   otherwise 0.
 * ```
 *
 * ⭐⭐ BOTH TEAMS, and that is the point (BK-C2 §CORR 3's ADOPTED departure from BK-T3's
 * opponents-only form): **40.9/43.1 % of attributable caroms strike the passer's OWN
 * TEAMMATE**, which an opponents-only body set structurally cannot see. The widening is
 * adopted BY MEASUREMENT, never by taste.
 *
 * ⭐⭐ THE INTENDED RECEIVER IS NAMED OUT — BK-C1 §4(ii)'s own anchored condition, reused
 * verbatim in substance: *"a delivery that reaches its man and is met there is a delivery
 * ARRIVING, not a block"*. He stands AT the aim point, so leaving him in would make every
 * line blocked and the predicate would carry no information at all (BK-C2 §P.4, measured
 * in its sizing smoke before the freeze: **without this exclusion 74 of 74 ground lines
 * read BLOCKED**).
 *
 * ⭐ NO NEW CONSTANT. The SHELL is the contact law's own clearance expression
 * (`Match.ts`: `const shell = p.coreRadius + ball.radius;`), taken from the BODY's own
 * core and the ball's own radius. The SHORT-OF-TARGET condition is BK-C1 §4(ii)'s own
 * `along < d − shell`. Nothing else gates.
 *
 * ⛔ NO 1.5 m GUARD (deliberate, and it is the census's own choice, not a slip):
 * `DV_CLEAR_RADIUS` is `laneOpenness`'s *"the kick clears them"* assumption, which #340
 * item 2(c) named as NOW-FALSE under the contact law. BK-C2 §P.4 does not apply it to the
 * shell predicate and publishes its size beside it (`groundShellBlockedOnlyInsideGuardShare`
 * — the false 1.5 m clearance is real but MINOR: 7.2/7.4 %). This function inherits that.
 *
 * ⛔ NO COOLDOWN GATE. BK-C2 (iii): the striking body's median distance from the pass line
 * AT KICK TIME sits in the first half-metre while the cooling-at-choice hazard bin is
 * near-empty — *position at choice predicts, cooldown status at choice does NOT* — so the
 * hazard is GEOMETRIC and reads no clock.
 *
 * ⛔ NO GRADING. The binary form is what BK-C2 MEASURED (on lines the chooser's own gate
 * called OPEN, carom rate shell-blocked vs shell-clear = 0.293 vs 0.089 (w9) · 0.286 vs
 * 0.086 (w11), intervals disjoint in both arms); a graded refinement is a NAMED DOOR in
 * the contract's §4, not a liberty taken here.
 *
 * ⭐ NO NEW CHANNEL (M-GC.3). `players` is the caller's OWN collections — the very arrays
 * `laneOpenness(p.pos, aim, opp.players)` and the mate loop are already reading, which are
 * snapshot-borne wherever the percept world is armed (PlayerBrain L155-159's
 * byte-identical-in-source-and-snapshot convention). This module still does not import
 * `Match` and cannot reach a percept snapshot or any other channel.
 *
 * PURE: no rng, no writes, no allocation beyond `closestPointOnSegment`'s own.
 */
export function groundShellHazard(
  from: Readonly<V2>,
  aim: Readonly<V2>,
  players: readonly (readonly Player[])[],
  kickerGid: number,
  receiverGid: number,
): number {
  const d = dist(from as V2, aim as V2);
  for (const side of players) {
    for (const o of side) {
      if (o.sentOff) continue;
      if (o.gid === kickerGid) continue;
      if (o.gid === receiverGid) continue;
      const cp = closestPointOnSegment(from as V2, aim as V2, o.pos);
      const shell = o.coreRadius + BALL_RADIUS;
      if (dist(cp, o.pos) < shell && dist(from as V2, cp) < d - shell) return 1;
    }
  }
  return 0;
}
