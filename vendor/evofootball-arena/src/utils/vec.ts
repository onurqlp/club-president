/** Minimal immutable 2D vector helpers. Positions are in meters, pitch-space. */

export interface V2 {
  x: number;
  y: number;
}

export const v2 = (x = 0, y = 0): V2 => ({ x, y });
export const clone = (a: V2): V2 => ({ x: a.x, y: a.y });

export const add = (a: V2, b: V2): V2 => ({ x: a.x + b.x, y: a.y + b.y });
export const sub = (a: V2, b: V2): V2 => ({ x: a.x - b.x, y: a.y - b.y });
export const scale = (a: V2, s: number): V2 => ({ x: a.x * s, y: a.y * s });

export const lenSq = (a: V2): number => a.x * a.x + a.y * a.y;
export const len = (a: V2): number => Math.sqrt(lenSq(a));
// Allocation-free: dist is the hottest call in the sim (pair scans run it
// ~650k times per match). Same operations in the same IEEE order as the old
// lenSq(sub(a, b)) — results are bit-identical, only the garbage is gone.
export const distSq = (a: V2, b: V2): number => {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy;
};
export const dist = (a: V2, b: V2): number => Math.sqrt(distSq(a, b));
export const dot = (a: V2, b: V2): number => a.x * b.x + a.y * b.y;

/** Zero-safe normalize: returns (0,0) for near-zero vectors. */
export const norm = (a: V2): V2 => {
  const l = len(a);
  return l < 1e-8 ? v2(0, 0) : v2(a.x / l, a.y / l);
};

export const clampLen = (a: V2, max: number): V2 => {
  const l = len(a);
  return l > max && l > 1e-8 ? scale(a, max / l) : clone(a);
};

export const fromAngle = (rad: number, l = 1): V2 => ({ x: Math.cos(rad) * l, y: Math.sin(rad) * l });

export const rotate = (a: V2, rad: number): V2 => {
  const c = Math.cos(rad);
  const s = Math.sin(rad);
  return { x: a.x * c - a.y * s, y: a.x * s + a.y * c };
};

/** Move `cur` toward `target` changing it by at most `maxDelta` (vector length). */
export const approachV = (cur: V2, target: V2, maxDelta: number): V2 => {
  const d = sub(target, cur);
  const l = len(d);
  if (l <= maxDelta || l < 1e-8) return clone(target);
  return add(cur, scale(d, maxDelta / l));
};

/** Closest point on segment [a, b] to point p. Zero-length segments return a. */
// Allocation-free interior (hot via laneOpenness: once per opponent, per
// teammate scored, per carrier decision). Same operations in the same IEEE
// order as the old sub/lenSq/dot/add/scale chain — results are bit-identical.
export const closestPointOnSegment = (a: V2, b: V2, p: V2): V2 => {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const l2 = abx * abx + aby * aby;
  if (l2 < 1e-8) return clone(a);
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * abx + (p.y - a.y) * aby) / l2));
  return { x: a.x + abx * t, y: a.y + aby * t };
};
