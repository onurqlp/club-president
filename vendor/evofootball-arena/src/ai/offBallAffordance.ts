import { predictObservedPosition } from './prediction';
import {
  estimateReach, type KnownReachProfile, type ReachState,
} from './reachability';
import type { ObservedPlayer, PerceptionSnapshot } from './perceptionSnapshot';
import { HALF_L, HALF_W } from '../sim/constants';
import { clamp01 } from '../utils/math';
import { closestPointOnSegment, type V2 } from '../utils/vec';

export const OFFBALL_SAMPLE_HORIZONS = [0.75, 1.5] as const;
export const OFFBALL_DIRECTION_COUNT = 8;
const PITCH_INSET = 2;

export interface OffBallCandidatePoint {
  /** Stable geometric identity only: `hold` or horizon/direction indices. */
  readonly id: string;
  readonly point: Readonly<V2>;
  readonly sampleHorizon: number;
  readonly directionIndex: number | null;
  /** Displacement in the team's attack frame, not a tactic classification. */
  readonly forwardDelta: number;
  readonly lateralDelta: number;
}

/** S5 vector: deliberately no aggregate score or named football pattern. */
export interface OffBallAffordance {
  readonly candidate: OffBallCandidatePoint;
  readonly playerGid: number;
  readonly carrierGid: number;
  readonly selfArrival: number;
  readonly selfTurnTime: number;
  readonly opponentArrival: number;
  /** opponentArrival - selfArrival; positive favours the off-ball player. */
  readonly opponentArrivalMargin: number;
  readonly nearestOpponentDistanceAtArrival: number;
  readonly nearestTeammateDistanceAtArrival: number;
  readonly carrierDistanceAtArrival: number;
  readonly carrierLaneClearance: number;
  readonly fieldMargin: number;
  /** candidate local-x - perceived offside line; positive is beyond it. */
  readonly offsideMargin: number;
  readonly offsideRisk: number;
  readonly selfObservationAgeTicks: number;
  readonly carrierObservationAgeTicks: number;
  readonly observedOpponentCount: number;
  readonly observedTeammateCount: number;
}

export interface OffBallAffordanceInput {
  readonly snapshot: PerceptionSnapshot;
  readonly playerGid: number;
  readonly carrierGid: number;
  readonly attackDir: 1 | -1;
  readonly reachProfiles: ReadonlyMap<number, KnownReachProfile>;
}

interface EvaluationContext {
  readonly player: ObservedPlayer;
  readonly carrier: ObservedPlayer;
  readonly playerProfile: KnownReachProfile;
  readonly opponents: readonly ObservedPlayer[];
  readonly teammates: readonly ObservedPlayer[];
  readonly offsideLine: number;
}

const localX = (x: number, attackDir: 1 | -1): number => x * attackDir;

const reachState = (observed: ObservedPlayer, profile: KnownReachProfile): ReachState => ({
  pos: observed.pos,
  vel: observed.vel,
  bodyDir: observed.bodyDir,
  topSpeed: profile.topSpeed,
  accel: profile.accel,
  attrs: { dribbling: profile.dribbling ?? 0.5 },
});

const insideCandidatePitch = (point: Readonly<V2>): boolean =>
  Math.abs(point.x) <= HALF_L - PITCH_INSET && Math.abs(point.y) <= HALF_W - PITCH_INSET;

const insidePhysicalPitch = (point: Readonly<V2>): boolean =>
  Math.abs(point.x) <= HALF_L && Math.abs(point.y) <= HALF_W;

/**
 * Generate symmetric, role-neutral spatial samples from observed physical state.
 * `attackDir` rotates the sampling frame; it does not remove backward or lateral
 * candidates and does not assign football names to directions.
 */
export function generateOffBallCandidates(
  player: ObservedPlayer,
  profile: KnownReachProfile,
  attackDir: 1 | -1,
): readonly OffBallCandidatePoint[] {
  const result: OffBallCandidatePoint[] = [{
    id: 'hold',
    point: { x: player.pos.x, y: player.pos.y },
    sampleHorizon: 0,
    directionIndex: null,
    forwardDelta: 0,
    lateralDelta: 0,
  }];

  for (let horizonIndex = 0; horizonIndex < OFFBALL_SAMPLE_HORIZONS.length; horizonIndex++) {
    const sampleHorizon = OFFBALL_SAMPLE_HORIZONS[horizonIndex];
    const radius = Math.max(0, profile.topSpeed) * sampleHorizon;
    for (let directionIndex = 0; directionIndex < OFFBALL_DIRECTION_COUNT; directionIndex++) {
      const angle = directionIndex * Math.PI * 2 / OFFBALL_DIRECTION_COUNT;
      const forwardDelta = Math.cos(angle) * radius;
      const lateralDelta = Math.sin(angle) * radius;
      const point = {
        x: player.pos.x + attackDir * forwardDelta,
        y: player.pos.y + lateralDelta,
      };
      if (!insideCandidatePitch(point)) continue;
      result.push({
        id: `${horizonIndex}:${directionIndex}`,
        point,
        sampleHorizon,
        directionIndex,
        forwardDelta,
        lateralDelta,
      });
    }
  }
  return result;
}

const minimumProjectedDistance = (
  players: readonly ObservedPlayer[],
  point: Readonly<V2>,
  seconds: number,
): number => {
  let nearest = Infinity;
  for (const player of players) {
    const projected = predictObservedPosition(player, seconds);
    nearest = Math.min(nearest, Math.hypot(projected.x - point.x, projected.y - point.y));
  }
  return nearest;
};

const laneClearance = (
  from: Readonly<V2>,
  to: Readonly<V2>,
  opponents: readonly ObservedPlayer[],
  seconds: number,
): number => {
  let nearest = Infinity;
  for (const opponent of opponents) {
    const projected = predictObservedPosition(opponent, seconds);
    const closest = closestPointOnSegment(from, to, projected);
    nearest = Math.min(nearest, Math.hypot(projected.x - closest.x, projected.y - closest.y));
  }
  return nearest;
};

const prepareEvaluation = (input: OffBallAffordanceInput): EvaluationContext | null => {
  const { snapshot, playerGid, carrierGid, attackDir, reachProfiles } = input;
  const player = snapshot.players.find((entry) => entry.gid === playerGid);
  const carrier = snapshot.players.find((entry) => entry.gid === carrierGid);
  const playerProfile = reachProfiles.get(playerGid);
  if (!player || !carrier || !playerProfile || player.gid === carrier.gid || player.side !== carrier.side) {
    return null;
  }

  const opponents = snapshot.players.filter((entry) => entry.side !== player.side);
  const teammates = snapshot.players.filter((entry) => entry.side === player.side && entry.gid !== player.gid);
  if (opponents.length === 0 || teammates.length === 0) return null;
  if (opponents.some((entry) => !reachProfiles.has(entry.gid))) return null;

  const opponentXs = opponents
    .map((entry) => localX(entry.pos.x, attackDir))
    .sort((a, b) => b - a);
  return {
    player,
    carrier,
    playerProfile,
    opponents,
    teammates,
    offsideLine: Math.max(opponentXs[1] ?? -HALF_L, localX(carrier.pos.x, attackDir), 0),
  };
};

const evaluateCandidate = (
  input: OffBallAffordanceInput,
  context: EvaluationContext,
  candidate: OffBallCandidatePoint,
): OffBallAffordance => {
  const { playerGid, carrierGid, attackDir, reachProfiles } = input;
  const { player, carrier, playerProfile, opponents, teammates, offsideLine } = context;
  const selfReach = estimateReach(reachState(player, playerProfile), candidate.point);
  const arrivalTime = selfReach.eta;
  let opponentArrival = Infinity;
  for (const opponent of opponents) {
    opponentArrival = Math.min(opponentArrival, estimateReach(
      reachState(opponent, reachProfiles.get(opponent.gid)!),
      candidate.point,
    ).eta);
  }
  const projectedCarrier = predictObservedPosition(carrier, arrivalTime);
  const nearestOpponentDistanceAtArrival = minimumProjectedDistance(
    opponents, candidate.point, arrivalTime,
  );
  const nearestTeammateDistanceAtArrival = minimumProjectedDistance(
    teammates, candidate.point, arrivalTime,
  );
  const offsideMargin = localX(candidate.point.x, attackDir) - offsideLine;
  return {
    candidate,
    playerGid,
    carrierGid,
    selfArrival: selfReach.eta,
    selfTurnTime: selfReach.turnTime,
    opponentArrival,
    opponentArrivalMargin: opponentArrival - selfReach.eta,
    nearestOpponentDistanceAtArrival,
    nearestTeammateDistanceAtArrival,
    carrierDistanceAtArrival: Math.hypot(
      projectedCarrier.x - candidate.point.x,
      projectedCarrier.y - candidate.point.y,
    ),
    carrierLaneClearance: laneClearance(projectedCarrier, candidate.point, opponents, arrivalTime),
    fieldMargin: Math.min(HALF_L - Math.abs(candidate.point.x), HALF_W - Math.abs(candidate.point.y)),
    offsideMargin,
    offsideRisk: clamp01((offsideMargin + 0.2) / 1.2),
    selfObservationAgeTicks: player.ageTicks,
    carrierObservationAgeTicks: carrier.ageTicks,
    observedOpponentCount: opponents.length,
    observedTeammateCount: teammates.length,
  };
};

/** Evaluate one fixed world point so physical/profile counterfactuals keep geometry constant. */
export function evaluateOffBallCandidate(
  input: OffBallAffordanceInput,
  candidate: OffBallCandidatePoint,
): OffBallAffordance | null {
  const context = prepareEvaluation(input);
  // The 2m inset belongs to candidate generation, not to the physical domain
  // of an already-committed fixed point. A legal point can move into that
  // boundary band after generation and must remain observable there.
  if (!context || !insidePhysicalPitch(candidate.point)) return null;
  return evaluateCandidate(input, context, candidate);
}

/**
 * Evaluate every generic point from one observer's snapshot.
 * Missing defence/profile facts return null rather than consulting Match truth
 * or treating an unobserved defence as open space.
 */
export function evaluateOffBallAffordances(
  input: OffBallAffordanceInput,
): readonly OffBallAffordance[] | null {
  const context = prepareEvaluation(input);
  if (!context) return null;
  return generateOffBallCandidates(context.player, context.playerProfile, input.attackDir)
    .map((candidate) => evaluateCandidate(input, context, candidate));
}
