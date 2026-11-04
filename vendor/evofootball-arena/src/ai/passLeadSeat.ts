// PTP T0 — THE PASS-LEAD SEAM (docs/world-model/PTP-T0-DORMANT-SEAM.md).
// Contract: docs/world-model/PASS-TO-PATH-CONTRACT.md §2 M-PTP.1–4. Ruling #231.
//
// 传球到路: the carrier's pass model gains SIGHT of a SUPPORT-mode receiver's motion.
// The ordinary pass loop has always priced every support receiver AT HIS FEET; the
// through-ball loop alone leads a body, and only a LICENSED `MakeRun` runner. This
// seat extends that same lead arithmetic — the through-ball family's own, traced,
// never re-derived — to the ordinary loop's support mates, weighted by ONE gene.
//
//   aim = mate.pos + passLeadSupport · projectedDisplacement(mate, flight)
//
// NO PREDICATES (#200): the lead is unconditional geometry × gene. A STILL mate's
// projected displacement is zero, so his aim point IS his feet — to-feet EMERGES, it
// is never branched on. The complete conditional set of this file is GATE (the slice
// scope: support mode; the flag, read by the single caller), GUARD (the finite/absent
// checks and the "did I see him at all" zero) and ZERO (born-absent ⇒ 0).
//
// ⭐ INFORMATION HONESTY IS THE HARD RULE OF THIS FILE (contract M-PTP.1, VISION §1
// 感知诚实). The MOTION the projection consumes is the motion THAT WORLD'S CHOOSER
// can honestly have:
//   * bare world (`edsPerceivedChoice` false) — the pass loop prices truth positions,
//     so the motion is truth velocity: the SAME source, no new channel;
//   * percept world (`edsPerceivedChoice` true) — the chooser swaps onto this body's
//     own perceived snapshot, so the motion is the REMEMBERED velocity of that mate
//     in that snapshot (`ObservedPlayer.vel`, recorded at `observedTick`, stale by
//     `ageTicks`). A mate he has not seen has NO motion for him: zero ⇒ to feet.
// `perceivedSnapshot` is the ONLY member of `match` this module touches, and the
// world shape is handed IN by the caller (never read off `match` here), the OBM-T0
// `ctbPlaneArmed` precedent — so the source pin is machine-checkable (G-EPI-MOTION in
// the probe and in `tests/ptpPassLead.test.ts`).
//
// ⚠ THE ANCHOR STAYS THE INCUMBENT'S (an honesty limit, stated not hidden). The BASE
// of the aim point is `mate.pos` — TRUTH — in BOTH world shapes, because that is what
// the ordinary pass loop has always priced and because the zero-point identity
// requires it (`x + 0 === x`). This slice adds a MOTION channel, and that channel is
// world-appropriate; it does NOT re-anchor the incumbent's position channel, which is
// a separate (and much larger) question that belongs to the percept trunk, not here.
//
// Dormant: `ptpPassLead` is a hard `false` in every production path, so nothing in
// this file is reached in the shipped game.
import { dist } from '../utils/vec';
import type { V2 } from '../utils/vec';
import type { Match } from '../sim/Match';
import type { Player } from '../sim/Player';
import type { PerceptionSnapshot } from './perceptionSnapshot';
import { passLeadSupportWeight, type TacticalGenome } from '../evolution/genome';

/**
 * ⭐ THE FROZEN FLIGHT-TIME SPEED (M-PTP.1, "flightTime … reuse the through-ball
 * family's own traced arithmetic … no new constants").
 *
 * TRACED, NOT INVENTED. `18` is the THROUGH-BALL LOOP'S OWN flight-time divisor — the
 * one number the lead-pricing family already uses to turn a pass distance into a
 * travel time, in `src/ai/PlayerBrain.ts`'s through-ball loop:
 * `const flight = dist(p.pos, mate.pos) / 18;`
 * This seat asks the through-ball's question of a support mate ("how long is the ball
 * in the air on the way to him"), so the family member is chosen by QUESTION IDENTITY:
 * the ordinary-loop `18` that already prices a LED pass, not `performPass`'s executed
 * `16 · powerMul` (which is a specific body's orientation and chosen weight — the
 * chooser does not know it while scoring) and not `MARK_SAG_BALL_SPEED`'s access-time
 * account. The source line is asserted VERBATIM by the probe and the test, so the
 * family cannot drift.
 *
 * Never re-cut: if PTP-T1 needs a different speed that is a fork for the commander
 * WITH numbers, not a quiet re-freeze after sight.
 */
export const PTP_FLIGHT_SPEED = 18;

/**
 * ⭐ THE FROZEN LEAD FACTOR (M-PTP.1, the same clause).
 *
 * TRACED, NOT INVENTED. `1.6` is `runBurstPoint`'s OWN in-stride lead factor — the
 * engine's standing answer to *"how far along his own velocity do I aim at a moving
 * receiver over a flight of `flight` seconds"*, in `src/ai/formations.ts`:
 * `return v2(p.pos.x + p.vel.x * flight * 1.6, p.pos.y + p.vel.y * flight * 1.6);`
 * That IS the projection this slice extends from licensed runners to support mates,
 * so it is taken whole rather than re-derived. (For the record, the rest of the
 * family: `performPass`'s EXECUTION lead is `mate.vel · flight · 0.8` — a strike-time
 * correction on the incumbent's own flight estimate, not a chooser's projection; and
 * `runBurstPoint`'s standing-runner branch projects along the RUN TARGET, which is a
 * licensed runner's business and stays out of this slice, M-PTP.4.)
 *
 * Never re-cut: same rule as above.
 */
export const PTP_LEAD_FLIGHT_MUL = 1.6;

/**
 * The seat as the brain holds it for ONE on-ball decision: the gene weight, and the
 * world-appropriate motion source. Built ONCE per decision behind the single
 * `ptpPassLead` fork (so a percept world pulls at most one snapshot per decision,
 * never one per candidate mate).
 */
export interface PassLeadSeat {
  /** `passLeadSupportWeight(g)` ∈ [0,1]. 0 ⇒ every displacement is exactly `0`. */
  readonly weight: number;
  /** TRUE ⇒ motion comes from `snapshot`; FALSE ⇒ from truth velocity. */
  readonly perceived: boolean;
  /** THIS body's own percept, or null (blind, or a bare world). */
  readonly snapshot: PerceptionSnapshot | null;
}

/**
 * Build the seat. `perceivedWorld` is the CHOOSER'S OWN world-shape fork
 * (`match.edsPerceivedChoice`), handed in by the caller so this module names only
 * `perceivedSnapshot` on `match`.
 *
 * PURE apart from the one percept pull, which draws no rng and writes nothing.
 */
export function passLeadSeatOf(
  p: Player, match: Match, g: TacticalGenome, perceivedWorld: boolean,
): PassLeadSeat {
  return {
    weight: passLeadSupportWeight(g),
    perceived: perceivedWorld,
    snapshot: perceivedWorld ? match.perceivedSnapshot(p) : null,
  };
}

/**
 * The MOTION this world honestly gives the chooser about `mate`:
 *  * bare world ⇒ `mate.vel` (truth — the same source the loop's `mate.pos` is);
 *  * percept world ⇒ the REMEMBERED velocity in this body's snapshot, or `{0,0}` if
 *    he has no snapshot at all or has never seen that mate. Zero is SILENCE, not a
 *    claim that the mate is standing still — read exactly that way at T1.
 *
 * PURE: no rng, no writes.
 */
export function passLeadMotion(seat: PassLeadSeat, mate: Player): Readonly<V2> {
  if (!seat.perceived) return mate.vel;
  const snapshot = seat.snapshot;
  if (snapshot === null) return ZERO_MOTION;
  for (const seen of snapshot.players) {
    if (seen.gid === mate.gid) return seen.vel;
  }
  return ZERO_MOTION;
}

const ZERO_MOTION: Readonly<V2> = { x: 0, y: 0 };

/**
 * THE PROJECTION (M-PTP.1). The displacement the chooser expects `mate` to make
 * while the ball is in the air, ALREADY weighted by the gene:
 *
 * ```text
 * flight = dist(from, mate.pos) / PTP_FLIGHT_SPEED           (the through-ball's own)
 * disp   = motion · flight · PTP_LEAD_FLIGHT_MUL             (runBurstPoint's own)
 * lead   = passLeadSupport · disp
 * ```
 *
 * ⭐ THE SLICE SCOPE, declared as a GATE and not smuggled: only a mate in SUPPORT
 * mode is led (contract M-PTP.1 — "for a support-mode mate in the ordinary pass
 * loop"). A `MakeRun` mate keeps his licensed through-ball path untouched (M-PTP.4),
 * and every other action type is out of slice one. This is a scope gate on WHO this
 * limb is about, NOT a predicate on a continuous feature: nothing here asks whether
 * the mate is moving, checking, fast or free.
 *
 * ZERO IS ARITHMETIC-EXACT: gene absent or 0 ⇒ `weight === 0` ⇒ both components are
 * `v · f · m · 0`, i.e. exactly `±0`, and `x + ±0 === x` in IEEE-754 for every finite
 * `x`. That is what G-ZERO measures rather than asserts.
 *
 * NO CAP is taken at T0, and that is a decision, not an omission: the displacement is
 * bounded BY CONSTRUCTION (|motion| ≤ a body's top speed, flight ≤ the loop's own
 * long-ball distance / 18, gene ≤ 1), and the pricing is evaluated AT the led point —
 * so a lead too greedy to be a real pass prices ITSELF out through lane/open/gain
 * rather than through an engineer's ceiling. Any cap is a T1 fork WITH numbers.
 *
 * PURE: no rng, no writes, no truth in a percept world.
 */
export function passLeadOffset(
  seat: PassLeadSeat, from: Readonly<V2>, mate: Player,
): Readonly<V2> {
  if (mate.action.type !== 'SupportBallCarrier') return ZERO_MOTION;
  const motion = passLeadMotion(seat, mate);
  const flight = dist(from, mate.pos) / PTP_FLIGHT_SPEED;
  return {
    x: seat.weight * (motion.x * flight * PTP_LEAD_FLIGHT_MUL),
    y: seat.weight * (motion.y * flight * PTP_LEAD_FLIGHT_MUL),
  };
}

// THE AIM POINT itself is composed at its ONE use site — `aim = mate.pos + lead` in
// `PlayerBrain.decideOnBall`'s pass loop — deliberately, so the composition has a
// single owner and the strike can be handed the SAME `lead` object the pricing used.
//
// ⭐ STATED EXACTLY (the verify-round correction): "execution follows pricing" means the
// chooser's OWN priced displacement is CARRIED into the strike, NOT that the ball is
// struck at the priced point. `performPass` ADDS it to the incumbent strike-time
// correction it has always applied (`struck = struckLead + ptpLead`), so the struck
// point sits BEYOND the priced aim — measured at mean +3.26 m / +3.37 m (percept /
// bare) on the stage's chosen-pass smoke. That composition is the design (the
// incumbent's body knowledge is not replaced) and it is why the zero-gene world is
// byte-identical rather than merely close.
