/**
 * CB T0 — THE LAYER-1 CARRY-BEAT PHYSICS (docs/world-model/CB-T0-DORMANT-LAYER1-SEAM.md).
 *
 * Contract CB-CARRY-BEAT-CONTRACT.md §2 M-CB.1, dispatched by ruling #266.5. Two capabilities,
 * both DORMANT behind their own explicit flags (`cbCommitPhysics` / `cbTouchPast`):
 *
 *   (a) COMMITMENT-HONEST DISPOSSESSION — a challenge's outcome depends on the taker's own
 *       approach (speed, angle, momentum), and a beaten lunger pays the recovery interval HIS
 *       OWN motion model needs. Today's duel is GEOMETRY-BLIND (CB-C0: the take probability
 *       contains no taker-velocity term at all) and the miss price is a CONSTANT.
 *   (b) THE DIRECTIONAL TOUCH-PAST — the carrier knocks the ball a real distance into chosen
 *       space; the ball genuinely leaves his feet and the race is the engine's own loose-ball
 *       race. Whether a defender is BEATEN is decided by geometry alone — never a roll.
 *
 * ⭐ EPISTEMIC HONESTY, closed at the import list: this module imports the engine's own motion
 * and turf constants and NOTHING else. It cannot name `Match`, `Player`, `Team`, an rng, a
 * percept or a file path, so nothing here can read an opponent's internals or any census
 * artifact. Every body it is told about arrives as a plain kinematic record — the public facts
 * anyone on the pitch can see (where he is, how fast he is going, how hard he can accelerate).
 *
 * ⭐ EVERY CONSTANT TRACES (#200). The only numerals below are (i) `0`, (ii) the arithmetic of
 * the closed forms themselves — the `2` of `v²/2a`, the `1` of `1 − e^{−kt}` — which are
 * algebra, shown in place, not chosen values, and (iii) `touchPastPush`, which is the ENGINE'S
 * OWN push law reproduced verbatim from `performDribbleTouch` (Phase 36/36.1) so that a
 * touch-past is the carry regime the engine already has, aimed — G-TRACE reads that expression
 * back out of `mechanics.ts` and asserts it. Nothing here is tuned and nothing is imported from
 * a census.
 */
import {
  BALL_FRICTION_K, CONTROL_RADIUS, DT,
  TOUCH_PUSH_BASE, TOUCH_PUSH_SPACE, TOUCH_RECOLLECT_BASE, TOUCH_RECOLLECT_PER_PUSH,
} from './constants';
import { TURN_RATE } from './Player';

/**
 * THE CHALLENGE RADIUS, traced to `mechanics.ts`'s `tryTackles` candidate scan
 * (`if (d < 1.15 && d < best)`) — the distance inside which the engine offers the duel at all.
 * It is REPEATED here rather than hoisted out of that scan so no banked instrument's source
 * trace moves; CB-T0's own G-TRACE reads the literal back out of `mechanics.ts` and asserts
 * equality, so the duplication cannot drift silently.
 */
export const CB_TACKLE_RADIUS = 1.15;

/** A public kinematic record — everything this module is ever told about a body. */
export interface CbBody {
  readonly pos: { readonly x: number; readonly y: number };
  readonly vel: { readonly x: number; readonly y: number };
  /** His OWN acceleration constant (`Player.accel` = `ACCEL·(0.9 + pace·0.2)`). */
  readonly accel: number;
}

const hypot = (x: number, y: number): number => Math.sqrt(x * x + y * y);

/**
 * ⭐ THE BODY'S OWN DUEL HORIZON. `physicsStep` approaches `desiredVel` at `accel·dt` applied to
 * the VECTOR difference, so the deceleration model IS the acceleration model: |dv/dt| ≤ a. A
 * body arriving at v needs `v²/2a` metres to stop, so the arrival that cannot be stopped inside
 * the challenge radius is `v* = sqrt(2·a·R)` (CB-C0's overcommitment identity, re-derived here
 * from the same two constants), and the time it takes him to brake from it is
 *
 *     T = (v*) / a = sqrt(2·R/a)      with the identity   ½·a·T² = R   exactly.
 *
 * So T is simultaneously (i) the duel's own timescale — how long a committed arrival takes to
 * come to rest — and (ii) the horizon over which a body starting from rest can cover exactly
 * the challenge radius. Nothing is chosen: R and a are the engine's.
 */
export function duelHorizon(accel: number): number {
  return Math.sqrt((2 * CB_TACKLE_RADIUS) / accel);
}

/** The arrival speed that cannot be braked inside the challenge radius: `sqrt(2·a·R)`. */
export function overcommitSpeed(accel: number): number {
  return Math.sqrt(2 * accel * CB_TACKLE_RADIUS);
}

/**
 * ⭐⭐ THE ONE PRIMITIVE — REACHABILITY SLACK, in metres.
 *
 * A body carries his current velocity (he cannot teleport it away) and may add at most `a·t` of
 * velocity change over `t`, so the set of points his own motion model can put him on at time t
 * is the disc centred on his BALLISTIC drift `pos + vel·t` of radius `½·a·t²`. The target drifts
 * too (a carried ball rides at the carrier's velocity — `stepBall` writes `ball.vel = owner.vel`
 * — so a first-order projection of the target is a projection of the CARRIER's motion).
 *
 * The slack at time t is how many metres of that disc are to spare:
 *
 *     slack(t) = ½·a·t²  −  | (target + targetVel·t) − (pos + vel·t) |
 *
 * and the body can be ON the target at some point inside his own horizon iff the slack is ever
 * non-negative there. The returned value is the BEST slack over the horizon, sampled on the
 * engine's own timestep DT (the grid the world itself is integrated on).
 *
 * This single number carries speed, angle and momentum at once: a defender flying past is
 * carried out of the disc by his own `vel·t`; a defender who has planted can spend the whole
 * disc on the ball; a defender in the carrier's path meets a shrinking gap while one chasing
 * from behind meets a constant or growing one. It is not a distance test — two bodies at the
 * same distance with different velocities get different answers, which is the whole point.
 */
export function reachSlack(body: CbBody, target: CbBody['pos'], targetVel: CbBody['vel']): number {
  const horizon = duelHorizon(body.accel);
  const steps = Math.ceil(horizon / DT);
  let best = -Infinity;
  for (let i = 0; i <= steps; i++) {
    const t = Math.min(i * DT, horizon);
    const dx = (target.x + targetVel.x * t) - (body.pos.x + body.vel.x * t);
    const dy = (target.y + targetVel.y * t) - (body.pos.y + body.vel.y * t);
    const slack = (accelDisc(body.accel, t)) - hypot(dx, dy);
    if (slack > best) best = slack;
  }
  return best;
}

/** The radius his own motion model can add to the ballistic drift by time t: `½·a·t²`. */
function accelDisc(accel: number, t: number): number {
  return (accel * t * t) / 2;
}

/**
 * ⭐ THE COMMITMENT FACTOR χ ∈ [0, 1] — the slack expressed in units of the challenge radius,
 * which is the very distance the disc spans over the horizon (`½·a·T² = R`). χ = 1 is a body
 * whose projected position and the projected ball coincide; χ = 0 is a body whose own motion
 * model CANNOT put him on the ball inside his own horizon — an overcommitted lunge, which the
 * armed duel resolves as a miss with no roll left to save it.
 */
export function commitmentFactor(taker: CbBody, ball: CbBody['pos'], ballVel: CbBody['vel']): number {
  const slack = reachSlack(taker, ball, ballVel) / CB_TACKLE_RADIUS;
  if (!(slack > 0)) return 0;
  return slack > 1 ? 1 : slack;
}

/** The three legs of a beaten lunger's own recovery, in seconds. */
export interface CbRecovery {
  /** Braking to rest from his arrival speed at his own acceleration: `v/a`. */
  readonly brake: number;
  /** Turning his own body back onto the ball at the engine's heading cap: `θ/TURN_RATE`. */
  readonly turn: number;
  /** Closing the gap the miss left him with, from rest at his own acceleration: `sqrt(2d/a)`. */
  readonly close: number;
  /** The interval his motion model needs to be back in the duel: the sum. */
  readonly total: number;
  /** The angle he must turn through (rad) — published for the exam, never a price of its own. */
  readonly turnAngle: number;
}

/**
 * ⭐⭐ THE PHYSICS-DERIVED RECOVERY INTERVAL — the time a beaten lunger's OWN motion model needs
 * to be back in the duel, and NOT an invented stun timer. Three legs, each a closed form of the
 * engine's own constants and this body's own state at the miss:
 *
 *   brake = |v| / a                 (his deceleration model IS his acceleration model)
 *   turn  = θ / TURN_RATE           (θ = the angle from where his momentum points to the ball)
 *   close = sqrt(2·d / a)           (d = the gap the miss left; the braking identity inverted)
 *
 * A body that arrived under control and planted pays almost nothing; one carried through at
 * speed, pointing the wrong way, pays for every metre and radian of it. The incumbent price is
 * the constant pair (1.2 s cooldown, 0.35 s stun) — the same for a walk-in and a full-tilt dive
 * (CB-C0's `missPriceIsConstant`).
 */
export function recoveryInterval(taker: CbBody, ball: CbBody['pos'], heading: CbBody['vel']): CbRecovery {
  const speed = hypot(taker.vel.x, taker.vel.y);
  const brake = speed / taker.accel;
  // Where his momentum points — his own velocity direction, falling back to the body's facing
  // when he is not moving at all (both are the engine's own state; nothing is invented).
  let fx = taker.vel.x;
  let fy = taker.vel.y;
  if (speed === 0) {
    fx = heading.x;
    fy = heading.y;
  }
  const gx = ball.x - taker.pos.x;
  const gy = ball.y - taker.pos.y;
  const gd = hypot(gx, gy);
  const fd = hypot(fx, fy);
  const turnAngle = gd === 0 || fd === 0
    ? 0
    : Math.acos(Math.min(1, Math.max(-1, (fx * gx + fy * gy) / (fd * gd))));
  const turn = turnAngle / TURN_RATE;
  const close = Math.sqrt((2 * gd) / taker.accel);
  return { brake, turn, close, total: brake + turn + close, turnAngle };
}

/* ------------------------------------------------------------------ */
/* (b) THE DIRECTIONAL TOUCH-PAST                                      */
/* ------------------------------------------------------------------ */

/**
 * The knock's length, the engine's OWN push law (`performDribbleTouch`, Phase 36/36.1) reused
 * verbatim: base push plus a push per metre of open field, tightened by technique. Nothing new
 * is introduced — a touch-past is the carry regime the engine already has, aimed.
 */
export function touchPastPush(openAhead: number, dribbling: number): number {
  const open = Math.min(Math.max(openAhead - 2, 0), 9);
  return (TOUCH_PUSH_BASE + open * TOUCH_PUSH_SPACE) * (1.05 - dribbling * 0.15);
}

/**
 * The engine's own no-recollect window for a push of this length (`TOUCH_RECOLLECT_BASE +
 * push·TOUCH_RECOLLECT_PER_PUSH`) — which IS the duration of the loose-ball race the touch
 * starts, and therefore the horizon over which "did anyone beat me to it" is a real question.
 */
export function touchRaceWindow(push: number): number {
  return TOUCH_RECOLLECT_BASE + push * TOUCH_RECOLLECT_PER_PUSH;
}

/**
 * ⭐⭐ THE KNOCK'S CLAIM HORIZON — how long a knocked ball stays HIS knock (ruling #272.4(a),
 * docs/world-model/CB-AFTERMATH-POLISH.md §FIX-③). It replaces a HAND CONSTANT: the aimed
 * touch-past used to mark the ball for a flat 1.6 s, which is nobody's physics — 17.5 % of races
 * were still live when it expired, and in a sixth of those the knocker's brain walked away from a
 * ball two metres off because the MARKER, not the race, had ended.
 *
 * The marker answers one question — is this loose ball still his? — and it is still his for as
 * long as his own motion model can still end the race. That interval is ALREADY derived in this
 * module for a body who must get himself back onto a ball his momentum has carried him past:
 * `recoveryInterval` (brake + turn + close). Nothing new is invented here; the only thing chosen
 * is the point that law is aimed at, and the knock itself defines it — THE BALL'S ROLL-OUT
 * ENDPOINT, the farthest point the ball can ever reach along the line it was struck on:
 *
 *     D∞ = lim_{t→∞} rolledDistance(v0, t) = v0 / BALL_FRICTION_K       (closed form, above)
 *     rollOut = ballPos + dir · D∞
 *     L = max( touchRaceWindow(push) , recoveryInterval(knocker, rollOut, heading).total )
 *
 * The floor is the engine's own no-recollect window: the marker may never expire while the engine
 * still FORBIDS him to touch the ball. Every term is the engine's — its turf constant, its turn
 * cap, his own acceleration — and nothing is tuned.
 *
 * ⚠ It is a TIME law read off the release, not a liveness test: "is the ball still loose and am I
 * nearest" would be a per-tick query about OTHER bodies (an information channel this world has
 * not earned) and could not be re-derived from the knock. See the stage doc for the rejection.
 *
 * SCOPE: the AIMED touch-past only. `performDribbleTouch` keeps its incumbent flat marker.
 */
export function knockClaimLifetime(
  knocker: CbBody, heading: CbBody['vel'], ballPos: CbBody['pos'], dir: CbBody['vel'],
  releaseSpeed: number, push: number,
): number {
  const dInfinity = releaseSpeed / BALL_FRICTION_K;
  const rollOut = { x: ballPos.x + dir.x * dInfinity, y: ballPos.y + dir.y * dInfinity };
  const claim = recoveryInterval(knocker, rollOut, heading).total;
  const window = touchRaceWindow(push);
  return claim > window ? claim : window;
}

/** Where a knocked ball is after `t` seconds: the engine's own exponential decay, closed form. */
export function rolledDistance(speed: number, t: number): number {
  return (speed * (1 - Math.exp(-BALL_FRICTION_K * t))) / BALL_FRICTION_K;
}

/**
 * ⭐⭐ IS THIS DEFENDER BEATEN BY THIS TOUCH? GEOMETRY ONLY — never a dice roll, never an
 * attribute duel (M-CB.1(b), and §-1's criterion: the duel is born from geometry).
 *
 * The ball leaves along `dir` at `speed` and decays on the engine's own turf constant; the
 * defender carries his velocity and may add `½·a·t²` in any direction, and he needs the ball
 * inside the engine's own control reach to do anything about it. He is NOT beaten iff there is
 * a moment inside the race window at which
 *
 *     | ball(t) − (D.pos + D.vel·t) |  ≤  ½·a·t² + CONTROL_RADIUS.
 *
 * Sampled on the engine's own timestep. Everything in the test is the engine's: its friction,
 * its control radius, its timestep, his own acceleration constant, the race window the push
 * itself sets.
 */
export function beatsDefender(
  ballPos: CbBody['pos'], dir: CbBody['vel'], speed: number, push: number, defender: CbBody,
): boolean {
  const window = touchRaceWindow(push);
  const steps = Math.ceil(window / DT);
  for (let i = 0; i <= steps; i++) {
    const t = Math.min(i * DT, window);
    const rolled = rolledDistance(speed, t);
    const bx = ballPos.x + dir.x * rolled;
    const by = ballPos.y + dir.y * rolled;
    const dx = bx - (defender.pos.x + defender.vel.x * t);
    const dy = by - (defender.pos.y + defender.vel.y * t);
    if (hypot(dx, dy) <= accelDisc(defender.accel, t) + CONTROL_RADIUS) return false;
  }
  return true;
}
