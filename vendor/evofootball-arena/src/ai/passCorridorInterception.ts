import { predictGroundPass } from './prediction';
import {
  estimateReach,
  type KnownReachProfile,
  type ReachState,
} from './reachability';
import type { PerceptionSnapshot } from './perceptionSnapshot';
import { BALL_FRICTION_K, CONTROL_RADIUS, DT } from '../sim/constants';
import { clamp01 } from '../utils/math';
import type { V2 } from '../utils/vec';

const EPS = 1e-9;

/**
 * Observer-grounded physical facts for one defender racing one intended pass.
 * This is deliberately not a probability, score, action or selection right.
 */
export interface PassCorridorInterceptionFacts {
  readonly defenderGid: number;
  readonly passerGid: number;
  readonly targetGid: number;
  readonly flightReachable: true;
  readonly sampleCount: number;
  readonly strongestMargin: number;
  readonly strongestPoint: Readonly<V2>;
  readonly strongestBallTime: number;
  readonly strongestDefenderEta: number;
  readonly strongestPathFraction: number;
  readonly earliestFeasiblePoint: Readonly<V2> | null;
  readonly earliestFeasibleBallTime: number | null;
  readonly targetObservationAgeTicks: number;
  readonly defenderObservationAgeTicks: number;
}

export interface PassCorridorInterceptionInput {
  readonly snapshot: PerceptionSnapshot;
  readonly passerGid: number;
  readonly targetGid: number;
  readonly defenderGid: number;
  readonly reachProfiles: ReadonlyMap<number, KnownReachProfile>;
  readonly powerMultiplier?: number;
}

const reachState = (
  player: PerceptionSnapshot['players'][number],
  profile: KnownReachProfile,
): ReachState => ({
  pos: player.pos,
  vel: player.vel,
  bodyDir: player.bodyDir,
  topSpeed: profile.topSpeed,
  accel: profile.accel,
  attrs: { dribbling: profile.dribbling ?? 0.5 },
});

/**
 * Sample the intended ordinary ground pass at the engine's fixed tick order and
 * compare each ball time with the observed defender's existing reach estimate.
 * Missing perception or unreachable flight returns null instead of consulting
 * Match truth.
 */
export function evaluatePassCorridorInterception(
  input: PassCorridorInterceptionInput,
): PassCorridorInterceptionFacts | null {
  const {
    snapshot, passerGid, targetGid, defenderGid, reachProfiles,
  } = input;
  if (
    passerGid === targetGid
    || passerGid === defenderGid
    || targetGid === defenderGid
  ) return null;

  const passer = snapshot.players.find((entry) => entry.gid === passerGid);
  const target = snapshot.players.find((entry) => entry.gid === targetGid);
  const defender = snapshot.players.find((entry) => entry.gid === defenderGid);
  const profile = reachProfiles.get(defenderGid);
  if (
    !passer || !target || !defender || !profile
    || passer.side !== target.side
    || defender.side === passer.side
  ) return null;

  const flight = predictGroundPass(passer.pos, target, input.powerMultiplier ?? 1);
  if (
    !flight.reachable
    || !Number.isFinite(flight.arrivalTime)
    || flight.arrivalTime <= 0
    || flight.distance <= EPS
  ) return null;

  const ticks = Math.max(1, Math.round(flight.arrivalTime / DT));
  const directionX = (flight.targetPoint.x - passer.pos.x) / flight.distance;
  const directionY = (flight.targetPoint.y - passer.pos.y) / flight.distance;
  const decay = Math.exp(-BALL_FRICTION_K * DT);
  const defenderState = reachState(defender, profile);
  let ballX = passer.pos.x;
  let ballY = passer.pos.y;
  let velocityX = directionX * flight.launchSpeed;
  let velocityY = directionY * flight.launchSpeed;
  let strongestMargin = -Infinity;
  let strongestPoint: V2 = { x: ballX, y: ballY };
  let strongestBallTime = 0;
  let strongestDefenderEta = Infinity;
  let strongestPathFraction = 0;
  let earliestFeasiblePoint: V2 | null = null;
  let earliestFeasibleBallTime: number | null = null;

  for (let tick = 1; tick <= ticks; tick++) {
    ballX += velocityX * DT;
    ballY += velocityY * DT;
    velocityX *= decay;
    velocityY *= decay;
    const point = { x: ballX, y: ballY };
    const ballTime = tick * DT;
    const defenderEta = estimateReach(defenderState, point, {
      reachRadius: CONTROL_RADIUS,
    }).eta;
    const margin = ballTime - defenderEta;
    const travelled = Math.hypot(ballX - passer.pos.x, ballY - passer.pos.y);
    const pathFraction = clamp01(travelled / flight.distance);
    if (margin > strongestMargin + EPS) {
      strongestMargin = margin;
      strongestPoint = point;
      strongestBallTime = ballTime;
      strongestDefenderEta = defenderEta;
      strongestPathFraction = pathFraction;
    }
    if (earliestFeasiblePoint === null && margin >= 0) {
      earliestFeasiblePoint = point;
      earliestFeasibleBallTime = ballTime;
    }
  }

  if (![
    strongestMargin,
    strongestPoint.x,
    strongestPoint.y,
    strongestBallTime,
    strongestDefenderEta,
    strongestPathFraction,
  ].every(Number.isFinite)) return null;

  return {
    defenderGid,
    passerGid,
    targetGid,
    flightReachable: true,
    sampleCount: ticks,
    strongestMargin,
    strongestPoint,
    strongestBallTime,
    strongestDefenderEta,
    strongestPathFraction,
    earliestFeasiblePoint,
    earliestFeasibleBallTime,
    targetObservationAgeTicks: target.ageTicks,
    defenderObservationAgeTicks: defender.ageTicks,
  };
}
