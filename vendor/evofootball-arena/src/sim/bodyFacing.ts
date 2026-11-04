/**
 * ⭐⭐ BF T0 — THE FACING-COST LAW (docs/world-model/BF-T0-FACING-COST-SEAM.md;
 * contract BF-BODY-FACING-CONTRACT.md §2 M-BF.1; COMMANDER RULING #374 item 4,
 * amended by #375). 「背着跑、侧着跑，跑不出全速」
 *
 * A real body runs fastest where it faces. In this engine it does not: BF-C0 §R3's
 * two-body fixture drove two identical bodies at one target for 120 ticks with one
 * facing 90° off its velocity and they covered the SAME distance (`distanceRatio`
 * exactly 1). This module is the arithmetic of the price — and NOTHING else: it is
 * PURE (its whole import list is empty), it holds no state, it draws no rng, and it
 * knows nothing about `Match`, `Player` or the ai layer.
 *
 * THE LAW OF RECORD (ruling #374 item 4(i) — the shape is the engine's OWN cosine
 * misalignment family, `kickMisalignment = (1 − cos θ)/2` in `src/sim/mechanics.ts`,
 * FLAT near 0° and SATURATING at 90°):
 *
 *     f(φ) = 1 − D · (1 − cos(min(φ, π/2)))
 *
 * expressed here on the COSINE (there is no `acos` in the loop — the caller passes
 * `cos φ`, and `min(φ, π/2)` is `max(cos φ, 0)`):
 *
 *     facingFactor(cosPhi, depth) = 1 − depth · (1 − max(cosPhi, 0))
 *
 * ⭐ THE ONE RATIFIED CONSTANT: `BF_OFF_HEADING_FRACTION = 0.70` — ruling #374 item
 * 4(ii), "k = 1 − D = 0.70 on BOTH sides (lateral = back), the one figure the
 * literature supports on both directions at one remove (backward 0.70–0.74; lateral
 * ≈ 2/3), the ordering left unimposed because the evidence does not impose it".
 * `BF_DEPTH` is DERIVED from it (1 − k = 0.30), never typed twice — ruling #375 item
 * 2: `agility` is not a shipped attribute (`ATTR_KEYS` has nine keys), M-BF.2 is a
 * HELD DOOR, and BF-T0 therefore builds the law with ONE FLAT depth.
 *
 * ⛔ NOTHING HERE SHIPS: the caller reaches this module only when a body's
 * `facingDepth` is above zero, which happens only when a `Match` was constructed with
 * `bfFacingCost: true` — no world, preset, env or bundle arms it.
 */

/**
 * ⭐ THE ANCHOR CONSTANT, k (ruling #374 item 4(ii)): the fraction of its forward
 * speed a body keeps when it is 90° or more off its heading — lateral AND backward,
 * the same figure, because the literature does not impose an ordering between them
 * (BF-C0 §R4: backward ≈ 0.70–0.74 verified at one remove; lateral ≈ two thirds, no
 * clean maximal ratio found). ⛔ Not a taste constant, not a measurement of this
 * engine: a ratified reading of the reality anchor.
 */
export const BF_OFF_HEADING_FRACTION = 0.7;

/**
 * ⭐ THE DEPTH, D — DERIVED from the anchor, never typed twice (ruling #375 item 2:
 * ONE FLAT depth, the band `agility` would have supplied stood in for by BF-T1's
 * reported k = 0.60 / 0.80 rungs). `f(≥ 90°) = 1 − D = BF_OFF_HEADING_FRACTION`.
 * ⚠ UNIT-NAME TRUTH (canon, home: ruling #294 item 3 — "a field carries the unit its
 * name claims"): this is a DEPTH (how much is taken away), not a fraction kept.
 */
export const BF_DEPTH = 1 - BF_OFF_HEADING_FRACTION;

/**
 * THE LAW ON SCALARS. `cosPhi` = cos of the angle between the body's heading and the
 * direction it INTENDS to move; `depth` = the body's own `facingDepth`.
 *
 * * `cosPhi = 1` (dead ahead) ⇒ EXACTLY 1 — a straight run pays nothing, and the
 *   shape is flat near 0° (f(7.5°) = 1 − 0.30·0.008566 ≈ 0.99743), so BF-C0 §CORR 3's
 *   toll on nearly-aligned running vanishes by construction.
 * * `cosPhi ≤ 0` (90° or more off) ⇒ EXACTLY `1 − depth` — flat across the whole
 *   lateral-to-backward sector, which is what "the ordering is not established" means
 *   in arithmetic.
 * * monotone non-increasing in φ on [0, π].
 *
 * Out-of-range cosines are CLAMPED to [−1, 1], never extrapolated.
 */
export function facingFactor(cosPhi: number, depth: number): number {
  const c = cosPhi > 1 ? 1 : cosPhi < -1 ? -1 : cosPhi;
  return 1 - depth * (1 - (c > 0 ? c : 0));
}

/**
 * cos φ between a body's heading and its intended direction, both expected UNIT.
 * A degenerate input (either vector of length ~0) names no angle and therefore no
 * penalty: it returns 1 (the identity) — the same discipline as `physicsStep`'s own 1e-6
 * guard on a degenerate face target, and as RC-C0 §P.A's degenerate-bearing exclusion.
 */
export function facingCosine(headX: number, headY: number, dirX: number, dirY: number): number {
  const hl = headX * headX + headY * headY;
  const dl = dirX * dirX + dirY * dirY;
  if (hl < 1e-12 || dl < 1e-12) return 1;
  const c = headX * dirX + headY * dirY;
  return c > 1 ? 1 : c < -1 ? -1 : c;
}
