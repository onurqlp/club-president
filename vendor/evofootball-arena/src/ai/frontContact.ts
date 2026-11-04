import { CONTROL_RADIUS } from '../sim/constants';
import { closestPointOnSegment, dist, type V2 } from '../utils/vec';
import type { PerceptionSnapshot } from './perceptionSnapshot';
import { predictGroundPass } from './prediction';
import type { KnownReachProfile } from './reachability';

/**
 * ⭐⭐⭐ OP T0b — 「身前那个人 · 挑线」 THE FRONT CONTACT FACT (docs/world-model/OP-T0B-FRONT-CHOOSER-SEAM.md;
 * contract OP-FRONT-MAN-CONTRACT.md §2 M-OP.5; ruling #435 item 3(a)).
 *
 * TRUE iff some OBSERVED, live opponent's closest point on the segment from the passer's
 * PERCEIVED position to the predicted ground flight's `targetPoint` (the same
 * `predictGroundPass` the corridor read uses) lies STRICTLY ahead of the passer within 1.5 m
 * (`0 < along < 1.5` — M-OP.2's partition) AND his distance to that line is below
 * `CONTROL_RADIUS` — exactly the men for whom the front lane form reads less than fully open.
 *
 * Perceived positions only — the passer's own snapshot, never truth. "Live" is read the way
 * the corridor reads it: a body without a reach profile is not raced (`Match.reachProfiles`
 * holds every body NOT sent off, and the snapshot itself drops a sent-off man at the next scan).
 *
 * NO NEW NUMBER: 1.5 (the shipped guard radius), `CONTROL_RADIUS` (the engine's), and 0 (the
 * segment clamp's own output for a man level with or behind the passer).
 *
 * PURE: no rng, no Match, no writes.
 */
export function frontContactOf(
  snapshot: PerceptionSnapshot,
  passerGid: number,
  targetGid: number,
  reachProfiles: ReadonlyMap<number, KnownReachProfile>,
  powerMultiplier: number,
): boolean {
  const passer = snapshot.players.find((entry) => entry.gid === passerGid);
  const target = snapshot.players.find((entry) => entry.gid === targetGid);
  if (!passer || !target) return false;
  const from = passer.pos as V2;
  const to = predictGroundPass(passer.pos, target, powerMultiplier).targetPoint;
  for (const entry of snapshot.players) {
    if (entry.side === passer.side) continue;
    if (!reachProfiles.has(entry.gid)) continue;
    const cp = closestPointOnSegment(from, to, entry.pos as V2);
    const along = dist(cp, from);
    if (!(along > 0 && along < 1.5)) continue;
    if (dist(cp, entry.pos as V2) < CONTROL_RADIUS) return true;
  }
  return false;
}
