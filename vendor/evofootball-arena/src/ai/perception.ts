import { clamp01 } from '../utils/math';
import {
  add, closestPointOnSegment, dist, len, norm, scale, sub, type V2,
} from '../utils/vec';
import { BALL_FRICTION_K, GRAVITY, HALF_L, HALF_W, UNSET_BLOCK_WEIGHT } from '../sim/constants';
import { CONTROL_RADIUS } from '../sim/constants';
import type { Ball } from '../sim/Ball';
import type { Player } from '../sim/Player';

/**
 * Perception helpers — small pure queries the utility scorers are built from.
 * All return values are normalized to [0, 1] so scoring math stays readable.
 */

/**
 * ⭐ THE INCUMBENT PRESSURE RADIUS, named here at its own use site by OBM-T0 (#227).
 * PURE CODE MOTION: `6` is the very metre count `pressureAt` has always divided by —
 * the engine's standing answer to "from how far away does an opponent's proximity
 * still count as pressure on a point". Given a name so the off-ball eyes seat can
 * write its proximity features as a reference to the incumbent constant instead of
 * as a fresh literal (the #202 form: traced, derived in code, never typed).
 */
export const PRESSURE_RADIUS_M = 6;

/** Pressure on a position from the nearest opponent: 1 at 0m, 0 beyond 6m. */
export function pressureAt(pos: V2, opponents: Player[]): number {
  let best = Infinity;
  for (const o of opponents) {
    if (o.sentOff) continue;
    const d = dist(o.pos, pos);
    if (d < best) best = d;
  }
  return clamp01(1 - best / PRESSURE_RADIUS_M);
}

/**
 * 脱压带球 (Phase 34.2, user report "球员不会向后带球"): a pressured
 * carrier outside the final third whose FORWARD path is closed should
 * carry the ball AWAY from the press — back or sideways — to buy time,
 * instead of stopping dead or driving into bodies. Returns the escape
 * direction (opponent-repulsion within 8m, tilted lateral so the carry
 * arcs to the safe wing rather than straight into his own goalmouth) and
 * the space along it, or null when this is not an escape situation.
 * Shared by the SCORER and the EXECUTOR so the utility and the legs agree.
 */
export function escapeCarry(
  p: Player,
  attackDir: number,
  localX: number,
  opponents: Player[],
  holdCorner = false,
): { dir: V2; space: number } | null {
  // 打卡油角 (Phase 35): a side killing the game late carries INTO the
  // attacking corner and shields — for it, the final-third gate opens.
  if (localX > 15 && !holdCorner) return null; // final third: go at them or release, never turn tail
  const pressure = pressureAt(p.pos, opponents);
  if (pressure < 0.45) return null;
  let rx = 0;
  let ry = 0;
  for (const o of opponents) {
    if (o.sentOff) continue;
    const dx = p.pos.x - o.pos.x;
    const dy = p.pos.y - o.pos.y;
    const d2 = dx * dx + dy * dy;
    if (d2 > 64 || d2 < 1e-6) continue;
    rx += dx / d2;
    ry += dy / d2;
  }
  if (rx === 0 && ry === 0) return null;
  if (holdCorner && localX > 0) {
    // Corner-flag holding (Phase 35): blend the repulsion with a pull
    // toward the attacking corner, guarded off the lines themselves —
    // on the touchline the pull runs ALONG it, at the byline it holds.
    const rep = norm({ x: rx, y: ry });
    const cx = localX > HALF_L - 8 ? 0 : attackDir;
    const cy = Math.abs(p.pos.y) > HALF_W - 6 ? 0 : Math.sign(p.pos.y || 1);
    if (cx !== 0 || cy !== 0) {
      const corner = norm({ x: cx, y: cy });
      rx = rep.x + corner.x * 1.2;
      ry = rep.y + corner.y * 1.2;
    }
  } else {
    // Tilt lateral: straight retreats toward the own goal are the last resort.
    // 边锋 (34.3, user report): a WIDE carrier escapes to HIS touchline or
    // backward — never on an inward arc across the press. Guarded near the
    // line itself, where the outward pull would carry into touch.
    const wide = Math.abs(p.pos.y) > 8 && Math.abs(p.pos.y) < HALF_W - 5;
    const tiltSign = wide ? Math.sign(p.pos.y) : Math.sign(ry || p.pos.y || 1);
    if (wide && Math.sign(ry) !== tiltSign) ry = Math.abs(ry) * tiltSign * 0.6;
    ry += tiltSign * 0.35 * Math.hypot(rx, ry);
  }
  let dir = norm({ x: rx, y: ry });
  const forward = spaceAhead(p, { x: attackDir, y: 0 }, opponents);
  // Holding late in the attacking half, "the front door is open" is not a
  // reason to charge at goal — the corner carry stands.
  if (forward > 0.55 && !(holdCorner && localX > 0)) return null;
  const space = spaceAhead(p, dir, opponents);
  if (space < 0.25) return null; // boxed in on every side — not an escape
  return { dir, space };
}

/**
 * Friction-free landing of an airborne ball: time to touch down and the
 * exact point. The same closed form used to live inline in interceptBall,
 * TeamBrain's drop-chaser and the executor's crash re-route — ONE
 * projector now, so when the ball learns to curve (Phase 37 Magnus) every
 * consumer reads the same corrected flight.
 */
export function ballLanding(ball: Ball): { t: number; x: number; y: number } {
  const t = (ball.vz + Math.sqrt(ball.vz * ball.vz + 2 * GRAVITY * ball.z)) / GRAVITY;
  const dx = ball.vel.x * t;
  const dy = ball.vel.y * t;
  // Magnus (Phase 37): a constant-rate spin flies a circular arc whose
  // chord is the straight displacement rotated by HALF the total turn —
  // the same closed form the kick's pre-compensation used, so designed
  // deliveries land where they were designed to.
  if (ball.spin !== 0) {
    const half = ball.spin * t * 0.5;
    const c = Math.cos(half);
    const s = Math.sin(half);
    return { t, x: ball.pos.x + dx * c - dy * s, y: ball.pos.y + dx * s + dy * c };
  }
  return { t, x: ball.pos.x + dx, y: ball.pos.y + dy };
}

/**
 * How clean an AERIAL lane is (Phase 28): a lofted ball only cares about
 * opponents close enough to the kicker to charge it down before it rises —
 * everything downfield is flown over. Landing safety is the receiver's
 * openness, scored separately by the caller.
 */
export function airLaneOpenness(from: V2, opponents: Player[]): number {
  let worst = 1;
  for (const o of opponents) {
    if (o.sentOff) continue;
    const d = dist(o.pos, from);
    if (d < 1.5) continue; // right on top of the kicker — the chip clears them
    worst = Math.min(worst, clamp01((d - 1.5) / 3));
  }
  return worst;
}

/** How clean the passing lane from `from` to `to` is (1 = wide open). */
export function laneOpenness(from: V2, to: V2, opponents: Player[]): number {
  let worst = 1;
  for (const o of opponents) {
    if (o.sentOff) continue;
    const cp = closestPointOnSegment(from, to, o.pos);
    // Ignore defenders standing right on top of the passer — the kick clears them.
    if (dist(cp, from) < 1.5) continue;
    const d = dist(cp, o.pos);
    worst = Math.min(worst, clamp01(d / 4));
  }
  return worst;
}

/**
 * ⭐⭐⭐ OP T0 — 「身前那个人 · 缝」 (docs/world-model/OP-T0-FRONT-MAN-SEAM.md; contract
 * OP-FRONT-MAN-CONTRACT.md §2 M-OP.2; COMMANDER RULING #432 — the user's 「甲吧」 ⇒
 * 「身前贴着的人要算进去」). `laneOpenness` CHARACTER FOR CHARACTER except the clear-the-kicker
 * guard, made true to the engine's contact law:
 *   * a man is SKIPPED only when the kick truly passes him by — his closest point on the
 *     segment IS the kicker (`closestPointOnSegment` clamps to t = 0, so `dist(cp, from) === 0`:
 *     he is level with or behind the ball's start; the degenerate segment keeps the shipped
 *     behaviour, `clone(from)`);
 *   * a man whose closest point lies strictly AHEAD of the kicker and within the shipped
 *     guard's 1.5 m is READ, at the reach the engine grants a body over that stretch:
 *     `clamp01(d / CONTROL_RADIUS)`;
 *   * beyond 1.5 m along the line: unchanged, `clamp01(d / 4)`.
 * NO NEW CONSTANT: 1.5 (the shipped guard), `CONTROL_RADIUS` (the engine's), 4 (the shipped
 * normaliser). Its ONE caller is the licence's lane seat inside `groundCandidate`, behind the
 * dormant `match.opFrontMan` door (M-OP.1); no other caller exists.
 */
export function laneOpennessFront(from: V2, to: V2, opponents: Player[]): number {
  let worst = 1;
  for (const o of opponents) {
    if (o.sentOff) continue;
    const cp = closestPointOnSegment(from, to, o.pos);
    // Ignore a defender only when the kick truly passes him by — his closest point IS the kicker.
    const along = dist(cp, from);
    if (along === 0) continue;
    const d = dist(cp, o.pos);
    worst = Math.min(worst, clamp01(d / (along < 1.5 ? CONTROL_RADIUS : 4)));
  }
  return worst;
}

/**
 * Bodies parked on a shot path (Phase 31): outfield opponents within ~1m of
 * the corridor's FIRST 60% — the final stretch belongs to the keeper (who
 * has the save path, not the block path). This is what `shotQuality`'s
 * distance·angle·pressure model cannot see: four set defenders between the
 * ball and the goal read as "low pressure" while the drive has zero chance.
 */
export function laneBlockers(from: V2, goal: V2, opponents: Player[]): number {
  const end = add(from, scale(sub(goal, from), 0.6));
  let n = 0;
  for (const o of opponents) {
    if (o.sentOff || o.role === 'GK') continue;
    const cp = closestPointOnSegment(from, end, o.pos);
    if (dist(cp, o.pos) < 1.0) n++;
  }
  return n;
}

/**
 * How ready this body is to BLOCK a strike from `from` (Phase 60): 1 = set
 * and facing the shooter, floored at UNSET_BLOCK_WEIGHT for a sprinting or
 * blind body — the collapsing block's retreaters can't organize a wall
 * against the first-time hit. Shared by the shoot decision
 * (effectiveBlockers) and the block physics (tryShotBlock).
 */
export function blockReadiness(o: Player, from: V2): number {
  const dx = from.x - o.pos.x;
  const dy = from.y - o.pos.y;
  const d = Math.hypot(dx, dy);
  const facing = d > 1e-6 ? (1 + (dx * o.heading.x + dy * o.heading.y) / d) / 2 : 1;
  const stillness = clamp01((3.5 - Math.hypot(o.vel.x, o.vel.y)) / 2.5);
  return UNSET_BLOCK_WEIGHT + (1 - UNSET_BLOCK_WEIGHT) * facing * stillness;
}

/**
 * laneBlockers with each body weighted by blockReadiness (Phase 60): the
 * count the shoot APPETITE should see. Four set defenders still read ~4;
 * four mid-collapse retreaters read closer to 1.5 — dare the strike.
 */
export function effectiveBlockers(from: V2, goal: V2, opponents: Player[]): number {
  const end = add(from, scale(sub(goal, from), 0.6));
  let n = 0;
  for (const o of opponents) {
    if (o.sentOff || o.role === 'GK') continue;
    const cp = closestPointOnSegment(from, end, o.pos);
    if (dist(cp, o.pos) < 1.0) n += blockReadiness(o, from);
  }
  return n;
}

/**
 * How much free space there is AT A POINT (nearest opponent distance / 8m).
 *
 * ⭐ PURE CODE MOTION (PTP-T0, #231): this is `opennessOf`'s body verbatim with the
 * receiver's position as the argument — the same loop, the same order, the same
 * arithmetic — extracted so a pass can be priced at the point it is AIMED at rather
 * than only at a body. `opennessOf` below is now the one-line body form of it, so
 * there is zero duplicated arithmetic and its signature and behaviour are untouched.
 */
export function opennessAt(pos: V2, opponents: Player[]): number {
  let best = Infinity;
  for (const o of opponents) {
    if (o.sentOff) continue;
    best = Math.min(best, dist(o.pos, pos));
  }
  return clamp01(best / 8);
}

/** How much free space a receiver has (nearest opponent distance / 8m). */
export function opennessOf(p: Player, opponents: Player[]): number {
  return opennessAt(p.pos, opponents);
}

/** Free space in front of a dribbler toward `dir` (10m lookahead cone). */
export function spaceAhead(p: Player, dir: V2, opponents: Player[]): number {
  const probe = add(p.pos, scale(norm(dir), 7));
  let crowd = 0;
  for (const o of opponents) {
    if (o.sentOff) continue;
    const d = dist(o.pos, probe);
    if (d < 8) crowd += 1 - d / 8;
  }
  return clamp01(1 - crowd / 2);
}

/** Rough time for a player to reach a point at top speed (+turn overhead). */
export function timeToPoint(p: Player, point: V2): number {
  return dist(p.pos, point) / Math.max(p.topSpeed, 0.1) + 0.15;
}

export interface InterceptSolution {
  point: V2;
  tBall: number;
  tMe: number;
  reachable: boolean;
}

/**
 * Intercept sampling grid, precomputed once. Uses the same `t += 0.1` float
 * accumulation and exp() evaluations the per-call loop used to run (30 exps
 * per call, every chasing player, every frame) — table values are
 * bit-identical to what the loop produced; only the recomputation is gone.
 */
const INTERCEPT_T: number[] = [];
const INTERCEPT_TRAVEL: number[] = [];
for (let t = 0.1; t <= 3.0; t += 0.1) {
  INTERCEPT_T.push(t);
  INTERCEPT_TRAVEL.push((1 - Math.exp(-BALL_FRICTION_K * t)) / BALL_FRICTION_K);
}

/**
 * Where should I run to meet the moving ball? The free ball follows
 * pos(t) = p0 + v0 * (1 - e^{-kt}) / k. We sample forward and take the first
 * point we can reach before the ball does; falls back to the rest point.
 */
export function interceptBall(p: Player, ball: Ball): InterceptSolution {
  const v0 = ball.vel;
  const speed0 = len(v0);
  // timeToPoint inlined with the topSpeed getter hoisted out of the sampling
  // loop (stamina can't change mid-call, so every sample read the same value);
  // sample points stay scalar until one is actually returned. Same arithmetic
  // in the same order — results are bit-identical, the garbage is gone.
  const ts = Math.max(p.topSpeed, 0.1);
  // Airborne ball (Phase 28): nothing on the ground meets it mid-flight —
  // run to where it comes DOWN (friction-free flight, so the landing point
  // is exact) and be there when it drops.
  if (ball.z > 0.02 || ball.vz > 0.02) {
    const { t: tLand, x: px, y: py } = ballLanding(ball);
    const dx = p.pos.x - px;
    const dy = p.pos.y - py;
    const tMe = Math.sqrt(dx * dx + dy * dy) / ts + 0.15;
    return { point: { x: px, y: py }, tBall: tLand, tMe, reachable: tMe <= tLand + 0.6 };
  }
  if (speed0 < 0.5) {
    const dx = p.pos.x - ball.pos.x;
    const dy = p.pos.y - ball.pos.y;
    return { point: ball.pos, tBall: 0, tMe: Math.sqrt(dx * dx + dy * dy) / ts + 0.15, reachable: true };
  }
  const spinning = ball.spin !== 0;
  for (let i = 0; i < INTERCEPT_T.length; i++) {
    const t = INTERCEPT_T[i];
    const travel = INTERCEPT_TRAVEL[i];
    let px = ball.pos.x + v0.x * travel;
    let py = ball.pos.y + v0.y * travel;
    // Magnus (Phase 37): a curling ground ball — the displacement rotates
    // by half the turn so far (the arc's chord). Zero-spin balls keep the
    // exact straight table path.
    if (spinning) {
      const half = ball.spin * t * 0.5;
      const c = Math.cos(half);
      const s = Math.sin(half);
      const rx = ball.pos.x + (px - ball.pos.x) * c - (py - ball.pos.y) * s;
      py = ball.pos.y + (px - ball.pos.x) * s + (py - ball.pos.y) * c;
      px = rx;
    }
    const dx = p.pos.x - px;
    const dy = p.pos.y - py;
    const tMe = Math.sqrt(dx * dx + dy * dy) / ts + 0.15;
    if (tMe <= t) return { point: { x: px, y: py }, tBall: t, tMe, reachable: true };
  }
  const rest = add(ball.pos, scale(v0, 1 / BALL_FRICTION_K));
  const dx = p.pos.x - rest.x;
  const dy = p.pos.y - rest.y;
  return { point: rest, tBall: 3, tMe: Math.sqrt(dx * dx + dy * dy) / ts + 0.15, reachable: false };
}

/** Can `p` cut out a pass traveling from the ball along its velocity? */
export function canInterceptPass(p: Player, ball: Ball): { ok: boolean; point: V2 } {
  const dir = norm(ball.vel);
  if (dir.x === 0 && dir.y === 0) return { ok: false, point: ball.pos };
  const end = add(ball.pos, scale(dir, 22));
  const cp = closestPointOnSegment(ball.pos, end, p.pos);
  const along = dist(ball.pos, cp);
  // Average ball speed over the segment, decayed by friction (crude but stable).
  const avgSpeed = Math.max(len(ball.vel) * 0.7, 4);
  const tBall = along / avgSpeed;
  const tMe = timeToPoint(p, cp);
  return { ok: tMe < tBall * 0.95 && dist(p.pos, cp) < 10, point: cp };
}
