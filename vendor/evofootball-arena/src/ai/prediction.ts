import { BALL_FRICTION_K, DT } from '../sim/constants';
import { clamp } from '../utils/math';
import type { V2 } from '../utils/vec';

export interface ObservedMotion {
  readonly pos: Readonly<V2>;
  readonly vel: Readonly<V2>;
}

export interface GroundPassPrediction {
  readonly targetPoint: Readonly<V2>;
  readonly distance: number;
  readonly launchSpeed: number;
  readonly arrivalTime: number;
  readonly reachable: boolean;
}

/** Constant-velocity short-horizon projection of one observed body. */
export function predictObservedPosition(
  state: ObservedMotion,
  horizon: number,
  maxHorizon = 1.5,
): V2 {
  const t = clamp(horizon, 0, maxHorizon);
  return { x: state.pos.x + state.vel.x * t, y: state.pos.y + state.vel.y * t };
}

/** First fixed-step tick at which the engine's ground ball reaches a distance. */
export function groundBallTravelTime(distance: number, launchSpeed: number): number {
  const d = Math.max(0, distance);
  const speed = Math.max(launchSpeed, 0);
  if (d === 0) return 0;
  if (speed <= 0) return Infinity;
  // Match moves by v·DT, then multiplies v by exp(-k·DT). The accumulated
  // distance is therefore a geometric series, not the continuous v/k limit.
  const friction = Math.exp(-BALL_FRICTION_K * DT);
  const maxDistance = speed * DT / (1 - friction);
  if (d >= maxDistance) return Infinity;
  const fractionalSteps = Math.log(1 - d / maxDistance) / Math.log(friction);
  return Math.ceil(fractionalSteps - 1e-12) * DT;
}

/**
 * Predict the ordinary ground-pass primitive without executing it.
 *
 * The lead and launch-speed formulas mirror mechanics.performPass before its
 * technical/pressure RNG error. This is intended flight, not guaranteed
 * completion; S2 execution quality remains a separate dimension.
 */
export function predictGroundPass(
  from: Readonly<V2>,
  target: ObservedMotion,
  powerMultiplier = 1,
): GroundPassPrediction {
  const power = Math.max(0.1, powerMultiplier);
  const dx0 = target.pos.x - from.x;
  const dy0 = target.pos.y - from.y;
  const initialDistance = Math.hypot(dx0, dy0);
  const leadTime = initialDistance / (16 * power);
  const targetPoint = {
    x: target.pos.x + target.vel.x * leadTime * 0.8,
    y: target.pos.y + target.vel.y * leadTime * 0.8,
  };
  const distance = Math.hypot(targetPoint.x - from.x, targetPoint.y - from.y);
  const launchSpeed = clamp(distance * 0.6 + 8.2, 9, 22) * power;
  const arrivalTime = groundBallTravelTime(distance, launchSpeed);
  return {
    targetPoint,
    distance,
    launchSpeed,
    arrivalTime,
    reachable: Number.isFinite(arrivalTime),
  };
}
