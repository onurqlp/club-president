import type { V2 } from '../utils/vec';
import { TURN_RATE } from '../sim/Player';

/** Physical facts known by a perception/affordance consumer. */
export interface KnownReachProfile {
  readonly topSpeed: number;
  readonly accel: number;
  readonly dribbling?: number;
}

/** The kinematic facts S1 exposes to pitch-control and arrival prediction. */
export interface ReachState {
  readonly pos: Readonly<V2>;
  readonly vel: Readonly<V2>;
  readonly bodyDir: Readonly<V2>;
  /** Already includes the live stamina multiplier for a Player. */
  readonly topSpeed: number;
  readonly accel: number;
  readonly attrs?: { readonly dribbling: number };
}

export interface ReachOptions {
  /** Stop when the body is this close to the point. */
  readonly reachRadius?: number;
  /** Match the executor's controlled-carry speed envelope. */
  readonly carrying?: boolean;
  /** Require the body to have turned toward the arrival point. */
  readonly requireFacing?: boolean;
  /** Explicit perception/reaction delay; S3 will supply this later. */
  readonly reactionDelay?: number;
}

export interface ReachEstimate {
  /** Arrival with the requested body readiness and reaction delay. */
  readonly eta: number;
  /** Centre movement only; heading turns concurrently. */
  readonly movementEta: number;
  readonly turnTime: number;
  readonly distance: number;
  readonly speedLimit: number;
}

/**
 * Cheap deterministic arrival estimate for the CURRENT kinematic model.
 *
 * Physics approaches one desired-velocity vector at a fixed acceleration.
 * Projecting that vector acceleration onto the target line gives an analytic
 * accelerate-then-cruise ETA. Heading rotates independently, so body readiness
 * is max(movement, turn), not an invented stop-and-turn tax.
 */
export function estimateReach(
  state: ReachState,
  point: Readonly<V2>,
  options: ReachOptions = {},
): ReachEstimate {
  const dx = point.x - state.pos.x;
  const dy = point.y - state.pos.y;
  const centerDistance = Math.hypot(dx, dy);
  const reachRadius = Math.max(0, options.reachRadius ?? 0);
  const distance = Math.max(0, centerDistance - reachRadius);
  const reactionDelay = Math.max(0, options.reactionDelay ?? 0);

  if (centerDistance < 1e-9 || distance === 0) {
    let turnTime = 0;
    if (centerDistance >= 1e-9) {
      const ux = dx / centerDistance;
      const uy = dy / centerDistance;
      const facingDot = Math.max(-1, Math.min(1, state.bodyDir.x * ux + state.bodyDir.y * uy));
      turnTime = Math.acos(facingDot) / TURN_RATE;
    }
    return {
      eta: reactionDelay + (options.requireFacing === false ? 0 : turnTime),
      movementEta: 0,
      turnTime,
      distance,
      speedLimit: Math.max(state.topSpeed, 0.1),
    };
  }

  const ux = dx / centerDistance;
  const uy = dy / centerDistance;
  const carryFactor = options.carrying
    ? 0.84 + Math.max(0, Math.min(1, state.attrs?.dribbling ?? 0.5)) * 0.1
    : 1;
  const speedLimit = Math.max(state.topSpeed * carryFactor, 0.1);
  const accel = Math.max(state.accel, 0.1);
  const desiredX = ux * speedLimit;
  const desiredY = uy * speedLimit;
  const deltaVx = desiredX - state.vel.x;
  const deltaVy = desiredY - state.vel.y;
  const deltaSpeed = Math.hypot(deltaVx, deltaVy);
  const vAlong = state.vel.x * ux + state.vel.y * uy;

  let movementEta: number;
  if (deltaSpeed < 1e-9) {
    movementEta = distance / speedLimit;
  } else {
    const accelTime = deltaSpeed / accel;
    // Acceleration points toward desiredVel exactly as Player.physicsStep does.
    const accelAlong = (speedLimit - vAlong) / accelTime;
    let reachesDuringAccel = false;
    let root = Infinity;
    if (Math.abs(accelAlong) < 1e-9) {
      if (vAlong > 1e-9) root = distance / vAlong;
    } else {
      const discriminant = vAlong * vAlong + 2 * accelAlong * distance;
      if (discriminant >= 0) {
        root = (-vAlong + Math.sqrt(discriminant)) / accelAlong;
      }
    }
    if (root >= 0 && root <= accelTime) reachesDuringAccel = true;
    if (reachesDuringAccel) {
      movementEta = root;
    } else {
      const accelDistance = vAlong * accelTime + 0.5 * accelAlong * accelTime * accelTime;
      movementEta = accelTime + Math.max(0, distance - accelDistance) / speedLimit;
    }
  }

  const facingDot = Math.max(-1, Math.min(1, state.bodyDir.x * ux + state.bodyDir.y * uy));
  const turnTime = Math.acos(facingDot) / TURN_RATE;
  const readyEta = options.requireFacing === false ? movementEta : Math.max(movementEta, turnTime);
  return {
    eta: reactionDelay + readyEta,
    movementEta,
    turnTime,
    distance,
    speedLimit,
  };
}

export function timeToReach(
  state: ReachState,
  point: Readonly<V2>,
  options: ReachOptions = {},
): number {
  return estimateReach(state, point, options).eta;
}
