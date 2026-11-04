// DLC T0s — THE GROUND STRIKE-PLANE SEAM (docs/world-model/DLC-T0S-DORMANT-SEAM.md).
// Contract: docs/world-model/DELIVERY-CHOICE-CONTRACT.md §2 M-DLC.1″ (slice ONE-S).
// Rulings #240 (continuous aim ruled in; the gene's MAGNITUDE role retires) and #241
// (控制的是那一脚 — the control variables are the STRIKE's own parameters).
//
// 控制的是那一脚: the carrier does not choose a POINT from a menu — he chooses a KICK.
// Armed, the ordinary pass loop prices, per support-mode mate, a SAMPLED GRID of GROUND
// strikes: DIRECTION × POWER, elevation 0 and spin 0 (that is the whole of slice one-s;
// elevation is two-s's and spin is three-s's, and neither is authorized here).
//
//   candidate(i, j) = the ball struck along the mate-ward bearing ROTATED by i·θ, with
//                     the weight that carries it a distance L = d0 + j·reach
//   i, j ∈ {-1, 0, +1}   ⇒   K = 9 candidates, of which (0, 0) IS THE INCUMBENT KICK
//
// ⭐ THE GRID IS TRACED, NEVER INVENTED. Its ONE scale is `reach` — the displacement the
// engine ALREADY believes a receiver covers while the ball is in the air, i.e. the banked
// PTP-T0 projection `motion · (d0 / PTP_FLIGHT_SPEED) · PTP_LEAD_FLIGHT_MUL` (the
// through-ball loop's own `/ 18` and `runBurstPoint`'s own `* 1.6`), taken at FULL weight.
// The angular step is the angle that reach SUBTENDS at the pass distance,
// `θ = atan2(reach, d0)`, and the power step is that same reach along the bearing. So
// every grid member is a ball this mate could MEET: the sampled plane is exactly the
// receiver-reachable set, computed from the flight/projection family the engine owns.
//
// ⭐ THE GENE'S MAGNITUDE HAS RETIRED (#240/#241), and it is retired LITERALLY here: the
// projection is evaluated at `weight: 1`, so `passLeadSupport`'s VALUE scales nothing at
// all. What the gene still does is GATE PRESENCE — born absent ⇒ no seat ⇒ no grid ⇒
// byte-identical. (This is why this stage's identity gate is G-VALUE-INERT, not a
// "zero-dose" gate: at 0 the grid forms exactly as it does at 1.)
//
// ⭐ INFORMATION HONESTY IS INHERITED, NOT RE-OPENED. The motion source, the percept
// rules, the support-mode scope gate and the two traced constants are the banked PTP-T0
// seat's, reached through `passLeadOffset` itself so the gate has ONE owner. This file
// adds no channel, no constant of its own and no read. `match` is named here for exactly
// one reason — to hand it to `passLeadSeatOf`, which pulls this body's own snapshot.
//
// ⭐ NO PREDICATES (#200). The complete conditional set of this file is GATE (the arming
// rule) and GUARD (the degenerate `d0 === 0` case). A mate the chooser has no motion for
// — not in support mode, never seen, standing still — has `reach === 0`, and then EVERY
// grid member's displacement is EXACTLY ±0 by the arithmetic below: the whole plane
// collapses onto the incumbent kick, without a branch and without a threshold.
//
// Dormant: `dlcStrikePlane` is a hard `false` in every production path, so nothing in
// this file is reached in the shipped game.
import type { V2 } from '../utils/vec';
import type { Match } from '../sim/Match';
import type { Player } from '../sim/Player';
import type { TacticalGenome } from '../evolution/genome';
import { passLeadOffset, passLeadSeatOf, type PassLeadSeat } from './passLeadSeat';

/**
 * ⭐ THE GRID'S STEPS, frozen. Three per axis — one step either side of the incumbent —
 * which is the SMALLEST grid that contains the zero-point and samples both signs of both
 * control variables. K is the scoping lever (the OBM-T0 / DLC-T0 cost lesson: sampling is
 * where a chooser's cost lives), so it is stated, small, and never widened quietly.
 */
export const STRIKE_PLANE_STEPS: readonly number[] = [-1, 0, 1];
/** 3 directions × 3 powers. */
export const STRIKE_PLANE_K = 9;
/** ⭐ The ZERO-POINT candidate's index: direction step 0, power step 0 — TODAY'S KICK. */
export const STRIKE_PLANE_ZERO_INDEX = 4;

/** One sampled ground strike, in the two forms the loop needs. */
export interface GroundStrike {
  /** −1 / 0 / +1: the strike's bearing, rotated by this many θ off the mate-ward one. */
  readonly dirStep: number;
  /** −1 / 0 / +1: the strike's weight, as this many `reach` off the incumbent length. */
  readonly powerStep: number;
  /**
   * THE DISPLACEMENT the strike is expressed as — `receivingPoint − mate.pos`. This is
   * what rides the BANKED led-strike statement into `performPass`, which composes it onto
   * its own strike-time correction exactly as PTP-T0 measured (`struck = struckLead +
   * ptpLead`), so the ball is struck BEYOND the priced point rather than on it. EXACTLY
   * ±0 for the zero-point member, which is what makes the incumbent kick reachable.
   */
  readonly strike: Readonly<V2>;
  /** THE RECEIVING POINT this candidate is PRICED at: `mate.pos + strike`. */
  readonly aim: Readonly<V2>;
}

/**
 * ⭐ THE ARMING RULE (M-DLC.4's form for this slice), in ONE place: the plane forms
 * candidates only when the flag's door is open (the caller's single fork) AND the gene is
 * NON-ABSENT. Returning `null` for an absent gene is the BORN-ABSENT IDENTITY made
 * structural: with no seat there is no grid, no scoring pass and no allocation — the loop
 * runs the shipped statements alone.
 *
 * PURE apart from the one percept pull inside `passLeadSeatOf`, which draws no rng.
 */
export function strikePlaneSeatOf(
  p: Player, match: Match, g: TacticalGenome, perceivedWorld: boolean,
): PassLeadSeat | null {
  if (g.passLeadSupport === undefined) return null;
  return passLeadSeatOf(p, match, g, perceivedWorld);
}

/**
 * ⭐ THE GRID'S SCALE, and the whole of the #240/#241 magnitude retirement.
 *
 * `reach` is the BANKED projection's own magnitude at FULL weight — the engine's standing
 * answer to *"how far does this receiver get while a ball of this flight is travelling"*.
 * It is obtained by calling `passLeadOffset` itself on a weight-1 view of the seat, so
 * the support-mode SCOPE GATE, the percept-honest motion source and both traced constants
 * have exactly ONE owner and cannot drift into a second copy here.
 *
 * BOUNDED BY CONSTRUCTION, and that is why no clamp is taken (a clamp would be an
 * engineer's ceiling on a chooser's option — the PTP-T0 §NO-CAP precedent):
 * `reach = |motion| · (d0 / 18) · 1.6 = d0 · |motion| / 11.25`, and no body in this engine
 * can carry |motion| ≥ 11.25 m/s (`BASE_SPEED` tops out at 7.9 and `topSpeed` scales it by
 * ≤ 1.12 ⇒ ≤ 8.848 m/s), so `reach < d0` ALWAYS ⇒ every power variant's length is
 * POSITIVE and every direction variant's rotation is under 45°. The probe measures the
 * observed minimum rather than trusting this note.
 */
export function strikeReach(seat: PassLeadSeat, from: Readonly<V2>, mate: Player): number {
  const disp = passLeadOffset(
    { weight: 1, perceived: seat.perceived, snapshot: seat.snapshot }, from, mate,
  );
  return Math.sqrt(disp.x * disp.x + disp.y * disp.y);
}

/**
 * ⭐ THE STRIKE PLANE ITSELF: the K = 9 sampled ground strikes, in a FROZEN order —
 * direction-major, then power, both ascending, so index = (dirStep + 1) · 3 +
 * (powerStep + 1) and the ZERO-POINT sits at `STRIKE_PLANE_ZERO_INDEX`.
 *
 * ```text
 * u    = (mate.pos − from) / d0                 the mate-ward bearing (the incumbent's)
 * θ    = atan2(reach, d0)                       the angle reach subtends at this distance
 * r(i) = u rotated by i·θ                       THE DIRECTION control
 * L(j) = d0 + j·reach                           THE POWER control (the shipped speed law
 *                                               `clamp(d·0.6 + 8.2, 9, 22)` is monotone in
 *                                               the struck distance, so length IS weight)
 * strike(i,j) = r(i)·L(j) − u·d0                the displacement off the incumbent point
 * ```
 *
 * ⭐ WHY IT IS WRITTEN AS A DIFFERENCE OF DISPLACEMENTS rather than as an absolute point:
 * at i = 0, j = 0 the expression is `u·d0 − u·d0`, which is EXACTLY ±0 in IEEE-754 — so
 * the zero-point candidate's aim has `mate.pos`'s own coordinates (`x + ±0 === x`), the
 * shared pricing function returns the SAME double as the incumbent's, and the loop's
 * strict `>` keeps the incumbent. Writing `from + u·L` instead would have left a ~1e-16
 * residue and the incumbent kick would not have been a member of its own grid.
 *
 * PURE: no rng, no writes, no truth in a percept world.
 */
export function groundStrikeGrid(
  seat: PassLeadSeat, from: Readonly<V2>, mate: Player,
): readonly GroundStrike[] {
  const dx = mate.pos.x - from.x;
  const dy = mate.pos.y - from.y;
  const d0 = Math.sqrt(dx * dx + dy * dy);
  const out: GroundStrike[] = [];
  // GUARD (not a predicate): a carrier standing exactly on his mate has no bearing to
  // rotate, so every member degenerates onto the incumbent point.
  const ux = d0 > 0 ? dx / d0 : 0;
  const uy = d0 > 0 ? dy / d0 : 0;
  const reach = d0 > 0 ? strikeReach(seat, from, mate) : 0;
  const theta = Math.atan2(reach, d0);
  for (const dirStep of STRIKE_PLANE_STEPS) {
    const a = dirStep * theta;
    const c = Math.cos(a);
    const s = Math.sin(a);
    const rx = ux * c - uy * s;
    const ry = ux * s + uy * c;
    for (const powerStep of STRIKE_PLANE_STEPS) {
      const L = d0 + powerStep * reach;
      const strike = { x: rx * L - ux * d0, y: ry * L - uy * d0 };
      out.push({
        dirStep,
        powerStep,
        strike,
        aim: { x: mate.pos.x + strike.x, y: mate.pos.y + strike.y },
      });
    }
  }
  return out;
}
