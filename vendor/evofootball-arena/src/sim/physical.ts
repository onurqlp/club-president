import type { V2 } from '../utils/vec';
import {
  BALL_ACCESS_BACK_EXTENSION_FACTOR,
  BALL_ACCESS_SIDE_EXTENSION_FACTOR,
} from './constants';
import type { Side } from './types';

/**
 * Physical state of the independent ball object. This is deliberately
 * separate from PossessionPhase: a free ball may be rolling or airborne,
 * while dead-ball/restart is a match-law state rather than a physical mode.
 */
export type BallPhysicalMode = 'controlled' | 'freeGround' | 'freeAirborne';

/**
 * B0 ball-control truth. This is deliberately finer than `BallPhysicalMode`:
 * an outfielder chasing their own knock is still in a control process even
 * though the ball is physically free. The classifier is observational only;
 * it never grants ownership or changes how a player acts.
 */
export type BallControlPhase =
  | { readonly kind: 'deadBall' }
  | { readonly kind: 'keeperHeld'; readonly controllerGid: number }
  | { readonly kind: 'secured'; readonly controllerGid: number }
  | { readonly kind: 'knocked'; readonly controllerGid: number; readonly expiresAt: number }
  | { readonly kind: 'free' };

/** Minimal existing facts required to derive `BallControlPhase`. */
export interface BallControlFacts {
  readonly live: boolean;
  readonly ownerGid: number | null;
  readonly ownerIsKeeper: boolean;
  readonly keeperHolding: boolean;
  readonly knockedByGid: number | null;
  readonly knockExpiresAt: number | null;
}

/**
 * Why a future controlled-ball process changed. Type-only in B0 so probes
 * and replay can share one vocabulary before any behavioural implementation.
 */
export type BallControlEvent =
  | { readonly tick: number; readonly kind: 'secured'; readonly gid: number }
  | { readonly tick: number; readonly kind: 'knocked'; readonly gid: number }
  | { readonly tick: number; readonly kind: 'disrupted'; readonly gid: number; readonly byGid: number }
  | { readonly tick: number; readonly kind: 'lost'; readonly gid: number; readonly cause: 'overrun' | 'tackle' | 'opponentContact' | 'out' }
  | { readonly tick: number; readonly kind: 'released'; readonly gid: number; readonly cause: 'pass' | 'shot' | 'clearance' };

/** How one continuous controlled-ball process began. */
export type ControlSequenceOrigin =
  | 'reception'
  | 'interception'
  | 'looseControl'
  | 'selfRegather';

/** A physical interruption of control; none of these awards a new owner. */
export type ControlBreakCause =
  | 'overrun'
  | 'tackle'
  | 'opponentContact'
  | 'out'
  | 'deadBall';

/** A deliberate end to control rather than a loss of it. */
export type ControlReleaseCause =
  | 'pass'
  | 'shot'
  | 'clearance'
  | 'openKnock'
  | 'out'
  | 'deadBall';

interface ControlSequenceBase {
  readonly id: number;
  readonly controllerGid: number;
  readonly origin: ControlSequenceOrigin;
  readonly startedTick: number;
  readonly lastOwnTouchTick: number;
  readonly touchIndex: number;
}

export type ActiveControlSequence = ControlSequenceBase & { readonly status: 'active' };
export type BrokenControlSequence = ControlSequenceBase & {
  readonly status: 'broken';
  readonly endedTick: number;
  readonly breakCause: ControlBreakCause;
};
export type ReleasedControlSequence = ControlSequenceBase & {
  readonly status: 'released';
  readonly endedTick: number;
  readonly releaseCause: ControlReleaseCause;
};

/**
 * B1c control-process representation. An own planned touch advances one
 * active sequence; it does not imply a possession transition or M3 contest.
 * B1c-0 adds the data contract only: live Match state stays null.
 */
export type ControlSequence =
  | ActiveControlSequence
  | BrokenControlSequence
  | ReleasedControlSequence;

/** Record one planned own touch without starting a new sequence. */
export function recordOwnControlTouch(
  sequence: ActiveControlSequence,
  tick: number,
): ActiveControlSequence {
  return {
    ...sequence,
    lastOwnTouchTick: tick,
    touchIndex: sequence.touchIndex + 1,
  };
}

/**
 * Macro possession position derived from existing truth. It is not a second
 * integrated ball trajectory and has no physics or rendering authority.
 */
export interface PossessionLocus {
  readonly pos: Readonly<V2>;
  readonly source: 'ball' | 'controller';
  readonly sequenceId: number | null;
  readonly controllerGid: number | null;
}

export interface PossessionLocusFacts {
  readonly ballPos: Readonly<V2>;
  readonly controlSequence: ControlSequence | null;
  /** Position of controlSequence.controllerGid, or null if unavailable. */
  readonly controllerPos: Readonly<V2> | null;
}

/**
 * B1c-0 semantic projection. Only an ACTIVE, resolvable sequence selects the
 * controller position; terminal/missing state falls straight back to the real
 * ball. The returned position is a read-only reference, never a copied or
 * independently advanced trajectory.
 */
export function derivePossessionLocus(facts: PossessionLocusFacts): PossessionLocus {
  const sequence = facts.controlSequence;
  if (sequence !== null && sequence.status === 'active' && facts.controllerPos !== null) {
    return {
      pos: facts.controllerPos,
      source: 'controller',
      sequenceId: sequence.id,
      controllerGid: sequence.controllerGid,
    };
  }
  return {
    pos: facts.ballPos,
    source: 'ball',
    sequenceId: null,
    controllerGid: null,
  };
}

/** Derive control truth from existing state without creating duplicate state. */
export function classifyBallControl(facts: BallControlFacts): BallControlPhase {
  if (!facts.live) return { kind: 'deadBall' };
  if (facts.ownerGid !== null) {
    if (facts.ownerIsKeeper && facts.keeperHolding) {
      return { kind: 'keeperHeld', controllerGid: facts.ownerGid };
    }
    return { kind: 'secured', controllerGid: facts.ownerGid };
  }
  if (facts.knockedByGid !== null && facts.knockExpiresAt !== null) {
    return {
      kind: 'knocked',
      controllerGid: facts.knockedByGid,
      expiresAt: facts.knockExpiresAt,
    };
  }
  return { kind: 'free' };
}

/** Minimal body facts used by the M0 geometry layer. */
export interface OrientedBody {
  readonly pos: Readonly<V2>;
  /** Unit facing vector; independent of velocity direction. */
  readonly bodyDir: Readonly<V2>;
  /** Radius of the stable kinematic core disc. */
  readonly coreRadius: number;
}

/** Minimal ball facts needed by access queries. */
export interface PhysicalBall {
  readonly pos: Readonly<V2>;
  readonly radius: number;
}

export interface DiscContactGeometry {
  /** Unit normal from A to B. Coincident centres use deterministic +x. */
  readonly normal: V2;
  readonly centerDistance: number;
  /** Signed edge-to-edge distance: negative means penetration. */
  readonly surfaceGap: number;
  readonly penetration: number;
  readonly touching: boolean;
}

export type BodySector = 'front' | 'side' | 'back';

export interface BallAccessGeometry {
  /** Unit direction from the body's centre toward the ball. */
  readonly direction: V2;
  readonly centerDistance: number;
  /** Signed distance between the core and ball surfaces. */
  readonly surfaceGap: number;
  /** Ball displacement in the body's local frame. */
  readonly forward: number;
  readonly lateral: number;
  readonly sector: BodySector;
  /** Point on the core boundary facing the ball. */
  readonly coreContactPoint: V2;
  /** Eligibility under the caller's centre-to-centre reach envelope. */
  readonly withinCenterReach: boolean;
}

export interface AccessLineGeometry {
  /** Closest point on actor→ball, expressed as t in [0,1]. */
  readonly closestT: number;
  readonly closestPoint: V2;
  readonly blockerDistance: number;
  readonly clearance: number;
  readonly blocked: boolean;
}

/** A body that may occupy an actor's direct route to the ball. */
export interface BallAccessBody extends OrientedBody {
  readonly gid: number;
  readonly side: Side;
}

/**
 * One M2 world-fact: can this oriented body touch this ball directly from the
 * current snapshot, or must it first turn / go around an opponent core?
 */
export interface DirectBallAccess {
  readonly geometry: BallAccessGeometry;
  /** Centre reach after applying the front/side/back interaction shell. */
  readonly sectorCenterReach: number;
  readonly withinPlayingDistance: boolean;
  readonly blockedByGid: number | null;
  readonly blockerGeometry: AccessLineGeometry | null;
  readonly mustTurn: boolean;
  readonly mustGoAround: boolean;
  readonly canDirectlyContact: boolean;
}

/**
 * Pure disc-contact query. It reports geometry only; it never resolves
 * penetration, changes velocity, or awards possession.
 */
export function discContactGeometry(
  aPos: Readonly<V2>,
  aRadius: number,
  bPos: Readonly<V2>,
  bRadius: number,
): DiscContactGeometry {
  const dx = bPos.x - aPos.x;
  const dy = bPos.y - aPos.y;
  const d = Math.sqrt(dx * dx + dy * dy);
  const normal = d > 1e-8 ? { x: dx / d, y: dy / d } : { x: 1, y: 0 };
  const surfaceGap = d - (aRadius + bRadius);
  return {
    normal,
    centerDistance: d,
    surfaceGap,
    penetration: Math.max(0, -surfaceGap),
    touching: surfaceGap <= 0,
  };
}

/**
 * Ball position in a body's oriented frame plus the current reach envelope.
 * Front/back are 90° cones; the two remaining quadrants are the side band.
 */
export function ballAccessGeometry(
  body: OrientedBody,
  ball: PhysicalBall,
  maxCenterReach: number,
): BallAccessGeometry {
  const dx = ball.pos.x - body.pos.x;
  const dy = ball.pos.y - body.pos.y;
  const d = Math.sqrt(dx * dx + dy * dy);
  const direction = d > 1e-8 ? { x: dx / d, y: dy / d } : { x: 1, y: 0 };

  const hl = Math.sqrt(body.bodyDir.x * body.bodyDir.x + body.bodyDir.y * body.bodyDir.y);
  const hx = hl > 1e-8 ? body.bodyDir.x / hl : 1;
  const hy = hl > 1e-8 ? body.bodyDir.y / hl : 0;
  const forward = dx * hx + dy * hy;
  const lateral = dx * -hy + dy * hx;
  const facingCos = direction.x * hx + direction.y * hy;
  const sector: BodySector = facingCos >= Math.SQRT1_2
    ? 'front'
    : facingCos <= -Math.SQRT1_2
      ? 'back'
      : 'side';

  return {
    direction,
    centerDistance: d,
    surfaceGap: d - body.coreRadius - ball.radius,
    forward,
    lateral,
    sector,
    coreContactPoint: {
      x: body.pos.x + direction.x * body.coreRadius,
      y: body.pos.y + direction.y * body.coreRadius,
    },
    withinCenterReach: d <= maxCenterReach,
  };
}

/**
 * Does another core occupy the direct actor→ball access corridor? The
 * corridor includes the ball radius, so grazing the ball's path counts.
 * This is a world-fact query only; M0 has no caller in Match or the AI.
 */
export function accessLineGeometry(
  actorPos: Readonly<V2>,
  ball: PhysicalBall,
  blockerPos: Readonly<V2>,
  blockerCoreRadius: number,
): AccessLineGeometry {
  const abx = ball.pos.x - actorPos.x;
  const aby = ball.pos.y - actorPos.y;
  const l2 = abx * abx + aby * aby;
  const rawT = l2 > 1e-8
    ? ((blockerPos.x - actorPos.x) * abx + (blockerPos.y - actorPos.y) * aby) / l2
    : 0;
  const closestT = Math.max(0, Math.min(1, rawT));
  const closestPoint = {
    x: actorPos.x + abx * closestT,
    y: actorPos.y + aby * closestT,
  };
  const dx = blockerPos.x - closestPoint.x;
  const dy = blockerPos.y - closestPoint.y;
  const blockerDistance = Math.sqrt(dx * dx + dy * dy);
  const clearance = blockerCoreRadius + ball.radius;
  return {
    closestT,
    closestPoint,
    blockerDistance,
    clearance,
    // The actor endpoint is excluded; a body occupying the ball endpoint blocks.
    blocked: rawT > 0 && rawT <= 1 && blockerDistance <= clearance,
  };
}

/**
 * Compose oriented reach and opponent screening into one deterministic query.
 * Teammates do not deny access; every opponent core does, even if that player
 * is in a cooldown and cannot claim the ball themself. The first blocker is
 * the one nearest the actor along the access line, with input order breaking
 * exact ties. This function reports geometry only and never awards control.
 */
export function directBallAccess(
  actor: BallAccessBody,
  ball: PhysicalBall,
  bodies: readonly BallAccessBody[],
  maxCenterReach: number,
): DirectBallAccess {
  const geometry = ballAccessGeometry(actor, ball, maxCenterReach);
  const extension = Math.max(0, maxCenterReach - actor.coreRadius - ball.radius);
  const extensionFactor = geometry.sector === 'front'
    ? 1
    : geometry.sector === 'side'
      ? BALL_ACCESS_SIDE_EXTENSION_FACTOR
      : BALL_ACCESS_BACK_EXTENSION_FACTOR;
  const sectorCenterReach = actor.coreRadius + ball.radius + extension * extensionFactor;
  const withinPlayingDistance = geometry.centerDistance <= sectorCenterReach;

  let blockedByGid: number | null = null;
  let blockerGeometry: AccessLineGeometry | null = null;
  for (const candidate of bodies) {
    if (candidate.gid === actor.gid || candidate.side === actor.side) continue;
    const line = accessLineGeometry(actor.pos, ball, candidate.pos, candidate.coreRadius);
    if (!line.blocked) continue;
    if (blockerGeometry === null || line.closestT < blockerGeometry.closestT) {
      blockedByGid = candidate.gid;
      blockerGeometry = line;
    }
  }

  const mustTurn = geometry.withinCenterReach && !withinPlayingDistance;
  const mustGoAround = blockedByGid !== null;
  return {
    geometry,
    sectorCenterReach,
    withinPlayingDistance,
    blockedByGid,
    blockerGeometry,
    mustTurn,
    mustGoAround,
    canDirectlyContact: withinPlayingDistance && !mustGoAround,
  };
}

export type ContestOrigin =
  | 'looseBall'
  | 'passArrival'
  | 'firstTouch'
  | 'tackle'
  | 'deflection'
  | 'aerial'
  | 'keeperSpill';

export type ContestContactKind = 'controlAttempt' | 'poke' | 'deflection' | 'header' | 'body';

export interface ContestContact {
  readonly tick: number;
  readonly gid: number;
  readonly side: Side;
  readonly kind: ContestContactKind;
  readonly ballModeAfter: BallPhysicalMode;
}

export type ContestResolution =
  | { readonly kind: 'controlled'; readonly tick: number; readonly gid: number; readonly side: Side }
  | { readonly kind: 'deadBall'; readonly tick: number }
  | { readonly kind: 'out'; readonly tick: number }
  | { readonly kind: 'stillLoose'; readonly tick: number };

/**
 * Append-only contest ledger shape for M3 probes/replay/dedup/keyed noise.
 * It records what happened; it never pre-selects or hands the ball to a
 * winner. `contenderGids` is intentionally unbounded — third players count.
 */
export interface ContestEpisode {
  readonly id: number;
  readonly startedTick: number;
  readonly origin: ContestOrigin;
  readonly initialBallMode: BallPhysicalMode;
  /** Sticky possession context when the episode opened; -1 means unassigned. */
  readonly possessionSideAtStart: Side | -1;
  readonly contenderGids: readonly number[];
  readonly contacts: readonly ContestContact[];
  readonly resolution?: ContestResolution;
}

/** First contact is derived from the ordered ledger, never duplicated state. */
export function firstContestContact(episode: ContestEpisode): ContestContact | undefined {
  return episode.contacts[0];
}
