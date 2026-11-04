import {
  createObserverGaze,
  type ObserverGaze,
  type PerceptionSnapshot,
} from './perceptionSnapshot';

/**
 * S3-G1 memory-guided attention (dormant; no production caller).
 * Authority: docs/world-model/OBSERVER-LOCAL-ATTENTION-POLICY.md
 *
 * A pure single-target reflex: aim the observer's own gaze at the last-known
 * remembered position of one designated actor. Inputs are the observer's own
 * PerceptionSnapshot and previous gaze only — the function cannot see truth,
 * private intent, coach doctrine or familiarity by construction. When the
 * actor fact is absent or the aim is degenerate, the previous gaze persists
 * unchanged.
 */
export function chooseAttentionGaze(
  snapshot: PerceptionSnapshot,
  actorGid: number,
  previousGaze: ObserverGaze | null,
): ObserverGaze | null {
  const self = snapshot.players.find((entry) => entry.gid === snapshot.observerGid);
  const fact = snapshot.players.find((entry) => entry.gid === actorGid);
  if (!self || !fact || fact.gid === self.gid) return previousGaze;
  const aim = { x: fact.pos.x - self.pos.x, y: fact.pos.y - self.pos.y };
  if (Math.hypot(aim.x, aim.y) <= 1e-6) return previousGaze;
  return createObserverGaze(snapshot.observerGid, aim, snapshot.tick) ?? previousGaze;
}
