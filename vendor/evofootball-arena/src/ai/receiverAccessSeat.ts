// RA T0 — THE RECEIVER-ACCESS DORMANT SEAM (docs/world-model/RA-T0-DORMANT-SEAM.md).
// Rulings #358 (the user's reality question re-cut the DX fork: the lead is a RENDEZVOUS
// solve, and the shared pricer had NO receiver-access term), #359 (the user's election,
// verbatim: 「①′ 接应时间入价」; DX-C2 dispatched), #360 (DX-C2 DISCRIMINATES — 72.78 % of
// carried elections unmeetable, Δ unresolved +0.0865 entirely above zero ⇒ the price has
// its LICENCE; this seam dispatched).
//
// 接应时间入价: the carrier's pass model gains the question real football asks FIRST —
// 「他赶得到吗」. For every ground candidate priced toward ANOTHER body, the seam charges
// the seconds by which the intended receiver's own chase arithmetic says he MISSES the
// elected point:
//
//   deficit(E) = max(0, tMate(E) − tBall(E))          [the unreachable seconds]
//   score′     = score − raAccessWeight · deficit(E) · passBase
//
// ⭐ THE ACCOUNT IS TRACED, NEVER INVENTED (DX-C2 §P.A BYTE FOR BYTE — the census that
// licensed this seam froze it and measured it):
//   tBall(E) = dist(from, E) / PTP_FLIGHT_SPEED       [the chooser's own flight law — the
//              through-ball loop's `/ 18`, the SAME family member the lead law and the DV
//              exposure limb already price with; the constant is IMPORTED, never re-typed]
//   tMate(E) = dist(mate, E) / max(mate.topSpeed, RA_CHASE_MIN_SPEED) + RA_CHASE_REACTION
//              [`interceptBall`'s OWN time-to-point form, `src/ai/perception.ts`:
//               `const ts = Math.max(p.topSpeed, 0.1);` and
//               `const tMe = Math.sqrt(dx * dx + dy * dy) / ts + 0.15;` — the receiver's
//               REAL chase machine, the one `ReceivePass` executes through]
//   PRESENCE — a mate already standing at the point needs no chase: within the engine's
//              own `CONTROL_RADIUS` the deficit is EXACTLY 0 (the traced form charges a
//              0.15 s reaction beat even to a body AT the point, which would read every
//              pass under ~2.7 m as deficient by arithmetic — DX-C2 §P.A's own clause,
//              anchored on the engine's own control cut, and it cannot fire on the
//              carried class's multi-metre leads).
// ⭐ The defence's half of the SAME account already ships — the marking law's
// `t_ball = dist(ballPos, markPos) / MARK_SAG_BALL_SPEED` (`actionExecutor.ts`, the #201
// mechanism). This seam gives the attack the half it never had (#358 item 3(c)).
//
// ⭐ NO NEW CHANNEL (the DV epistemic pin, unweakened): this module never names `Match`,
// so it CANNOT read a percept snapshot, a truth channel or anything else. It takes the
// SAME `mate` object the pricer's own loop already reads (snapshot-borne wherever the
// percept world is armed — the IN-T0 shadowing convention), plus `Player.topSpeed` — a
// body's physics, which this pricer family already credits for OPPONENTS (the DV exposure
// limb's own `o.topSpeed` closing read); crediting a TEAMMATE's is training-ground
// knowledge, strictly weaker.
//
// ⭐ NO PREDICATES (#200). The deficit is continuous and unconditional. The complete
// conditional set of this file is GATE (the arming rule; the SELF-DELIVERY scope gate —
// a knock's reception point is by construction where the carrier's own race resolves,
// CB-T2's law, so the account has nothing to price there), GUARD (the presence clause and
// the min-speed clamp, both traced), and the `max(0, ·)` half-wave of the account's own
// sign. NO CAP is taken, and that is a decision, not an omission: the deficit is bounded
// BY CONSTRUCTION (tMate ≤ pitch-scale distances over a body's own top speed; tBall ≥ 0),
// so a hopeless ball prices ITSELF out through the receiver's own physics rather than
// through an engineer's ceiling.
//
// Dormant: `raAccessPrice` is a hard `false` in every production path, so nothing in this
// file is reached in the shipped game.
import { dist } from '../utils/vec';
import type { V2 } from '../utils/vec';
import { CONTROL_RADIUS } from '../sim/constants';
import type { Player } from '../sim/Player';
import { raAccessWeightOf, type TacticalGenome } from '../evolution/genome';
import { PTP_FLIGHT_SPEED } from './passLeadSeat';

/**
 * ⭐ THE FROZEN FLIGHT SPEED — TRACED, NOT INVENTED, and not even re-typed: it IS the
 * banked PTP-T0 seat's exported constant, imported (the DV_FLIGHT_SPEED precedent,
 * byte for byte). The account asks the through-ball family's own question — "how long
 * is the ball travelling on the way to that point" — so the family member is chosen by
 * QUESTION IDENTITY, and reusing the SAME symbol means the lead family, the exposure
 * family and the access family can never drift apart.
 */
export const RA_FLIGHT_SPEED = PTP_FLIGHT_SPEED;

/**
 * ⭐ THE FROZEN CHASE REACTION — TRACED, NOT INVENTED. `0.15` is `interceptBall`'s OWN
 * reaction beat, `src/ai/perception.ts` (both branches of its time-to-point form):
 * `const tMe = Math.sqrt(dx * dx + dy * dy) / ts + 0.15;`
 * — the engine's standing answer to *"how long before a body's chase of a moving ball
 * actually begins"*. The pin suite asserts the source line VERBATIM (2 occurrences,
 * airborne + ground, both the same literal), so the family cannot drift.
 * Never re-cut: if RA-T1 needs a different beat that is a fork for the commander WITH
 * numbers, not a quiet re-freeze after sight.
 */
export const RA_CHASE_REACTION = 0.15;

/**
 * ⭐ THE FROZEN MIN CHASE SPEED — TRACED, NOT INVENTED. `0.1` is `interceptBall`'s OWN
 * clamp, `src/ai/perception.ts`: `const ts = Math.max(p.topSpeed, 0.1);` — the guard
 * that keeps a stopped body's chase time finite. Same drift pin, same never-re-cut rule.
 */
export const RA_CHASE_MIN_SPEED = 0.1;

/**
 * The seat as the brain holds it for ONE on-ball decision: the one evolvable care
 * weight, and nothing else. No world state in here at all — see the no-new-channel note
 * at the head of this file.
 */
export interface ReceiverAccessSeat {
  /** `raAccessWeightOf(g)` ∈ [0,1]. 0 ⇒ the deficit term is exactly `+0`. */
  readonly weight: number;
}

/**
 * ⭐ THE ARMING RULE (the DLC/DV form, in ONE place): the seat exists only when the
 * caller's flag fork is open AND the gene is NON-ABSENT. Returning `null` for an absent
 * gene is the BORN-ABSENT IDENTITY made structural rather than arithmetic: with no seat
 * there is no deficit read and no subtraction — the pricer runs the shipped statements
 * alone (G-BORN). Present at ANY value, including 0, the seat forms and the term is
 * exactly `−(+0)` (G-ZERO, measured never assumed).
 *
 * PURE: no rng, no reads beyond the genome.
 */
export function receiverAccessSeatOf(g: TacticalGenome): ReceiverAccessSeat | null {
  if (g.raAccessWeight === undefined) return null;
  return { weight: raAccessWeightOf(g) };
}

/**
 * ⭐⭐ THE DEFICIT (DX-C2 §P.A's account, the half-wave the price charges).
 *
 * ```text
 * GATE   mate.gid === kickerGid            ⇒ 0   (self-delivery: the knock's own seam)
 * GUARD  dist(mate, E) ≤ CONTROL_RADIUS    ⇒ 0   (presence — the engine's own control cut)
 * tBall  = dist(from, E) / RA_FLIGHT_SPEED
 * tMate  = dist(mate, E) / max(mate.topSpeed, RA_CHASE_MIN_SPEED) + RA_CHASE_REACTION
 * deficit = max(0, tMate − tBall)                 (seconds; 0 for every meetable ball)
 * ```
 *
 * ZERO IS ARITHMETIC-EXACT where it matters: a meetable ball's deficit is exactly `0`
 * (the `max`), a zero-weight seat multiplies any deficit to exactly `±0`, and
 * `x − ±0 === x` in IEEE-754 for every finite `x` — which is what G-ZERO measures.
 *
 * PURE: no rng, no writes, reads only its arguments.
 */
export function receiverAccessDeficit(
  from: Readonly<V2>, aim: Readonly<V2>, mate: Player, kickerGid: number,
): number {
  if (mate.gid === kickerGid) return 0;
  const dMate = dist(mate.pos, aim);
  if (dMate <= CONTROL_RADIUS) return 0;
  const tBall = dist(from, aim) / RA_FLIGHT_SPEED;
  const tMate = dMate / Math.max(mate.topSpeed, RA_CHASE_MIN_SPEED) + RA_CHASE_REACTION;
  return Math.max(0, tMate - tBall);
}
