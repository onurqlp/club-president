import {
  estimateReach, type KnownReachProfile, type ReachState,
} from './reachability';
import { predictGroundPass, predictObservedPosition, type GroundPassPrediction } from './prediction';
import type { ObservedPlayer, PerceptionSnapshot } from './perceptionSnapshot';
import { CONTROL_RADIUS, DT, HALF_L } from '../sim/constants';
import { TURN_RATE } from '../sim/Player';
import { clamp01 } from '../utils/math';
import type { V2 } from '../utils/vec';

export type { KnownReachProfile } from './reachability';

/** S5 vector: deliberately no aggregate score or tactical label. */
export interface PassAffordance {
  readonly passerGid: number;
  readonly targetGid: number;
  readonly targetPoint: Readonly<V2>;
  readonly ballArrival: number;
  readonly receiverArrival: number;
  readonly opponentArrival: number;
  /** opponentArrival − receiverArrival; positive favours the receiver. */
  readonly arrivalMargin: number;
  /** Calibratable estimate, not an execution success modifier. */
  readonly controlProbability: number;
  readonly receivePressure: number;
  readonly bodyReadiness: number;
  readonly progressionMetres: number;
  readonly lineBreakCount: number;
  /** target local-x − perceived offside line; positive means beyond it. */
  readonly offsideMargin: number;
  readonly offsideRisk: number;
  readonly exitOptionCount: number;
  readonly targetObservationAgeTicks: number;
  readonly observedOpponentCount: number;
}

export interface PassAffordanceInput {
  readonly snapshot: PerceptionSnapshot;
  readonly passerGid: number;
  readonly targetGid: number;
  readonly attackDir: 1 | -1;
  readonly reachProfiles: ReadonlyMap<number, KnownReachProfile>;
  readonly powerMultiplier?: number;
}

export interface PassAffordanceResult {
  readonly flight: GroundPassPrediction;
  readonly affordance: PassAffordance;
}

const reachState = (observed: ObservedPlayer, profile: KnownReachProfile): ReachState => ({
  pos: observed.pos,
  vel: observed.vel,
  bodyDir: observed.bodyDir,
  topSpeed: profile.topSpeed,
  accel: profile.accel,
  attrs: { dribbling: profile.dribbling ?? 0.5 },
});

const localX = (x: number, attackDir: 1 | -1): number => x * attackDir;

const pressureAtArrival = (
  point: Readonly<V2>, opponents: readonly ObservedPlayer[], arrivalTime: number,
): number => {
  let nearest = Infinity;
  for (const opponent of opponents) {
    const projected = predictObservedPosition(opponent, arrivalTime);
    nearest = Math.min(nearest, Math.hypot(projected.x - point.x, projected.y - point.y));
  }
  return clamp01(1 - nearest / 8);
};

/**
 * Evaluate one observed teammate as a pass affordance.
 *
 * Missing target/profile facts return null instead of silently consulting
 * Match truth. Every output is a separate causal dimension; S7 will later
 * learn/weight them, and this function never selects an action.
 */
export function evaluatePassAffordance(input: PassAffordanceInput): PassAffordanceResult | null {
  const { snapshot, passerGid, targetGid, attackDir, reachProfiles } = input;
  const passer = snapshot.players.find((p) => p.gid === passerGid);
  const target = snapshot.players.find((p) => p.gid === targetGid);
  const targetProfile = reachProfiles.get(targetGid);
  if (!passer || !target || !targetProfile || target.side !== passer.side) return null;

  const opponents = snapshot.players.filter((p) => p.side !== passer.side);
  if (opponents.length === 0) return null; // unknown is not evidence of open space
  const flight = predictGroundPass(passer.pos, target, input.powerMultiplier ?? 1);
  const receiverReach = estimateReach(reachState(target, targetProfile), flight.targetPoint, {
    reachRadius: CONTROL_RADIUS,
  });
  let opponentArrival = Infinity;
  for (const opponent of opponents) {
    const profile = reachProfiles.get(opponent.gid);
    if (!profile) continue;
    opponentArrival = Math.min(
      opponentArrival,
      estimateReach(reachState(opponent, profile), flight.targetPoint, {
        reachRadius: CONTROL_RADIUS,
      }).eta,
    );
  }
  if (!Number.isFinite(opponentArrival)) return null;

  const receiverArrival = receiverReach.eta;
  const arrivalMargin = opponentArrival - receiverArrival;
  const lateBy = Number.isFinite(flight.arrivalTime)
    ? Math.max(0, receiverArrival - flight.arrivalTime)
    : 3;
  // Seeded against the frozen arrival curve only as a monotonic prior; the
  // calibration probe owns the eventual coefficients before any live use.
  const baseControl = 1 / (1 + Math.exp(-(1 + arrivalMargin * 3)));
  const controlProbability = clamp01(baseControl * Math.exp(-lateBy * 1.5));
  const receivePressure = pressureAtArrival(flight.targetPoint, opponents, flight.arrivalTime);
  // A receiver already standing at the target has no movement heading, but
  // can still have their back to the incoming ball. Price that receiving turn
  // separately from locomotion toward the target point.
  const incomingX = passer.pos.x - flight.targetPoint.x;
  const incomingY = passer.pos.y - flight.targetPoint.y;
  const incomingDistance = Math.hypot(incomingX, incomingY);
  const incomingFacingDot = incomingDistance < 1e-9
    ? 1
    : Math.max(-1, Math.min(1,
      (target.bodyDir.x * incomingX + target.bodyDir.y * incomingY) / incomingDistance,
    ));
  const receiveTurnTime = Math.acos(incomingFacingDot) / TURN_RATE;
  const readyWindow = Number.isFinite(flight.arrivalTime)
    ? Math.max(flight.arrivalTime, 0.1)
    : 0.1;
  const bodyReadiness = clamp01(1 - receiveTurnTime / readyWindow);

  const fromLocal = localX(passer.pos.x, attackDir);
  const targetLocal = localX(flight.targetPoint.x, attackDir);
  let lineBreakCount = 0;
  for (const opponent of opponents) {
    const x = localX(opponent.pos.x, attackDir);
    if (x > fromLocal + 0.5 && x < targetLocal - 0.5) lineBreakCount++;
  }

  const opponentXs = opponents
    .map((p) => localX(p.pos.x, attackDir))
    .sort((a, b) => b - a);
  const offsideLine = Math.max(opponentXs[1] ?? -HALF_L, fromLocal, 0);
  const offsideMargin = localX(target.pos.x, attackDir) - offsideLine;
  const offsideRisk = clamp01((offsideMargin + 0.2) / 1.2);

  let exitOptionCount = 0;
  for (const teammate of snapshot.players) {
    if (teammate.side !== passer.side || teammate.gid === passerGid || teammate.gid === targetGid) continue;
    const projected = predictObservedPosition(teammate, flight.arrivalTime + 1);
    const optionDistance = Math.hypot(
      projected.x - flight.targetPoint.x,
      projected.y - flight.targetPoint.y,
    );
    if (optionDistance > 24) continue;
    let nearestOpponent = Infinity;
    for (const opponent of opponents) {
      const projectedOpponent = predictObservedPosition(opponent, flight.arrivalTime + 1);
      nearestOpponent = Math.min(nearestOpponent, Math.hypot(
        projectedOpponent.x - projected.x,
        projectedOpponent.y - projected.y,
      ));
    }
    if (nearestOpponent >= 4) exitOptionCount++;
  }

  return {
    flight,
    affordance: {
      passerGid,
      targetGid,
      targetPoint: flight.targetPoint,
      ballArrival: flight.arrivalTime,
      receiverArrival,
      opponentArrival,
      arrivalMargin,
      controlProbability,
      receivePressure,
      bodyReadiness,
      progressionMetres: targetLocal - fromLocal,
      lineBreakCount,
      offsideMargin,
      offsideRisk,
      exitOptionCount,
      targetObservationAgeTicks: target.ageTicks,
      observedOpponentCount: opponents.length,
    },
  };
}

/** Convert snapshot age to seconds for probe/report consumers. */
export const observationAgeSeconds = (ageTicks: number): number => Math.max(0, ageTicks) * DT;
