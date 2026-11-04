import { v2, type V2 } from '../utils/vec';
import type { Player } from '../sim/Player';

/** Steering behaviors: each returns a desired-velocity contribution. */

/** Full-speed run at a target, decelerating inside `slowRadius` so players settle on spots. */
export function arrive(p: Player, target: V2, speed: number, slowRadius = 2.5): V2 {
  // Flat form of scale(norm(sub(target, p.pos)), s) — runs for every player
  // every frame. dist() and norm's internal length share the same bits
  // ((-a)² === a² in IEEE), so one sqrt serves both; results are unchanged.
  const dx = target.x - p.pos.x;
  const dy = target.y - p.pos.y;
  const d = Math.sqrt(dx * dx + dy * dy);
  if (d < 0.05) return v2();
  const s = d < slowRadius ? speed * (d / slowRadius) : speed;
  if (d < 1e-8) return v2();
  return { x: (dx / d) * s, y: (dy / d) * s };
}

/**
 * Push away from nearby players so nobody stacks. Applied to everyone every
 * frame on top of their primary steering; hard overlap is also resolved in
 * Match physics as a positional constraint.
 */
export function separation(p: Player, all: Player[], radius = 2.2, strength = 3.0): V2 {
  // Flat form of add(out, scale(norm(sub(p.pos, o.pos)), k)) — runs for every
  // player every frame and allocated ~4 vectors per close neighbor. dist and
  // norm's internal length share the same bits ((-a)² === a² in IEEE), so one
  // sqrt serves both; accumulation order is unchanged, results are identical.
  let ox = 0;
  let oy = 0;
  for (const o of all) {
    if (o === p || o.sentOff) continue;
    const dx = p.pos.x - o.pos.x;
    const dy = p.pos.y - o.pos.y;
    const d = Math.sqrt(dx * dx + dy * dy);
    if (d < radius && d > 1e-6) {
      const k = strength * (1 - d / radius);
      ox += (dx / d) * k;
      oy += (dy / d) * k;
    }
  }
  return { x: ox, y: oy };
}

/** Small sideways push around opponents directly in the movement path. */
export function avoidOpponents(p: Player, desired: V2, opponents: Player[]): V2 {
  // Flattened like separation. Math.hypot is kept exactly — it rounds
  // differently than Math.sqrt(x²+y²), so replacing it would drift.
  const dl = Math.sqrt(desired.x * desired.x + desired.y * desired.y);
  if (dl < 1e-8) return v2();
  const dirX = desired.x / dl;
  const dirY = desired.y / dl;
  let ox = 0;
  let oy = 0;
  for (const o of opponents) {
    if (o.sentOff) continue;
    const tox = o.pos.x - p.pos.x;
    const toy = o.pos.y - p.pos.y;
    const ahead = tox * dirX + toy * dirY; // projection onto heading
    if (ahead < 0.5 || ahead > 5) continue;
    const lx = tox - dirX * ahead;
    const ly = toy - dirY * ahead;
    const ld = Math.hypot(lx, ly);
    if (ld < 1.6) {
      const side = lx * dirY - ly * dirX > 0 ? 1 : -1;
      const k = 2.0 * (1 - ld / 1.6);
      ox += -dirY * side * k;
      oy += dirX * side * k;
    }
  }
  return { x: ox, y: oy };
}
