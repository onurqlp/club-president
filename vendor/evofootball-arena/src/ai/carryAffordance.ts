import { HALF_L, HALF_W } from '../sim/constants';
import { closestPointOnSegment, type V2 } from '../utils/vec';
import type { ObservedPlayer, PerceptionSnapshot } from './perceptionSnapshot';
import { predictObservedPosition } from './prediction';
import {
  estimateReach, type KnownReachProfile, type ReachState,
} from './reachability';

export const CARRY_SAMPLE_HORIZONS = [0.5, 1] as const;
export const CARRY_DIRECTION_COUNT = 16;
const PITCH_INSET = 2;
const EPS = 1e-9;

export interface CarryCandidatePoint {
  readonly id: string;
  readonly point: Readonly<V2>;
  readonly sampleHorizon: number;
  readonly directionIndex: number | null;
  readonly forwardDelta: number;
  readonly lateralDelta: number;
}

export interface CarryAffordance {
  readonly candidate: CarryCandidatePoint;
  readonly controllerGid: number;
  readonly selfArrival: number;
  readonly selfTurnTime: number;
  readonly bodyAlignment: number;
  readonly opponentArrival: number;
  readonly opponentArrivalMargin: number;
  readonly nearestOpponentDistanceAtArrival: number;
  readonly travelCorridorClearance: number;
  readonly nearestTeammateDistanceAtArrival: number;
  readonly goalDistanceBefore: number;
  readonly goalDistanceAfter: number;
  readonly goalwardProgression: number;
  readonly goalCorridorClearance: number;
  readonly fieldMargin: number;
  readonly selfObservationAgeTicks: number;
  readonly ballObservationAgeTicks: number;
  readonly observedOpponentCount: number;
  readonly observedTeammateCount: number;
}

export interface CarryAffordanceInput {
  readonly snapshot: PerceptionSnapshot;
  readonly controllerGid: number;
  readonly attackDir: 1 | -1;
  readonly reachProfiles: ReadonlyMap<number, KnownReachProfile>;
}

interface EvaluationContext {
  readonly controller: ObservedPlayer;
  readonly controllerProfile: KnownReachProfile;
  readonly opponents: readonly ObservedPlayer[];
  readonly teammates: readonly ObservedPlayer[];
}

const finitePoint = (point: Readonly<V2>): boolean =>
  Number.isFinite(point.x) && Number.isFinite(point.y);

const insideCandidatePitch = (point: Readonly<V2>): boolean =>
  Math.abs(point.x) <= HALF_L - PITCH_INSET
  && Math.abs(point.y) <= HALF_W - PITCH_INSET;

const insidePhysicalPitch = (point: Readonly<V2>): boolean =>
  Math.abs(point.x) <= HALF_L && Math.abs(point.y) <= HALF_W;

const validProfile = (profile: KnownReachProfile | undefined): profile is KnownReachProfile =>
  profile !== undefined
  && Number.isFinite(profile.topSpeed)
  && profile.topSpeed > 0
  && Number.isFinite(profile.accel)
  && profile.accel > 0;

const reachState = (player: ObservedPlayer, profile: KnownReachProfile): ReachState => ({
  pos: player.pos,
  vel: player.vel,
  bodyDir: player.bodyDir,
  topSpeed: profile.topSpeed,
  accel: profile.accel,
  attrs: { dribbling: profile.dribbling ?? 0.5 },
});

const prepareEvaluation = (input: CarryAffordanceInput): EvaluationContext | null => {
  const { snapshot, controllerGid, reachProfiles } = input;
  if (
    !Number.isInteger(controllerGid)
    || snapshot.observerGid !== controllerGid
    || snapshot.ball === null
    || snapshot.ball.ownerGid !== controllerGid
  ) return null;
  const controller = snapshot.players.find((player) => player.gid === controllerGid);
  const controllerProfile = reachProfiles.get(controllerGid);
  if (!controller || !validProfile(controllerProfile)) return null;
  const opponents = snapshot.players.filter((player) => player.side !== controller.side);
  const teammates = snapshot.players.filter((player) =>
    player.side === controller.side && player.gid !== controller.gid);
  if (
    opponents.length === 0
    || teammates.length === 0
    || opponents.some((player) => !validProfile(reachProfiles.get(player.gid)))
  ) return null;
  return { controller, controllerProfile, opponents, teammates };
};

export function generateCarryCandidates(
  controller: ObservedPlayer,
  profile: KnownReachProfile,
  attackDir: 1 | -1,
): readonly CarryCandidatePoint[] {
  if (!finitePoint(controller.pos) || !validProfile(profile)) {
    throw new Error('invalid carry candidate authority');
  }
  const candidates: CarryCandidatePoint[] = [{
    id: 'hold',
    point: { x: controller.pos.x, y: controller.pos.y },
    sampleHorizon: 0,
    directionIndex: null,
    forwardDelta: 0,
    lateralDelta: 0,
  }];
  for (let horizonIndex = 0; horizonIndex < CARRY_SAMPLE_HORIZONS.length; horizonIndex++) {
    const sampleHorizon = CARRY_SAMPLE_HORIZONS[horizonIndex];
    const radius = profile.topSpeed * sampleHorizon;
    for (let directionIndex = 0; directionIndex < CARRY_DIRECTION_COUNT; directionIndex++) {
      const angle = directionIndex * Math.PI * 2 / CARRY_DIRECTION_COUNT;
      const forwardDelta = Math.cos(angle) * radius;
      const lateralDelta = Math.sin(angle) * radius;
      const point = {
        x: controller.pos.x + attackDir * forwardDelta,
        y: controller.pos.y + lateralDelta,
      };
      if (!insideCandidatePitch(point)) continue;
      candidates.push({
        id: `${horizonIndex}:${directionIndex}`,
        point,
        sampleHorizon,
        directionIndex,
        forwardDelta,
        lateralDelta,
      });
    }
  }
  return candidates;
}

const minimumProjectedDistance = (
  players: readonly ObservedPlayer[],
  point: Readonly<V2>,
  seconds: number,
): number => players.reduce((nearest, player) => {
  const projected = predictObservedPosition(player, seconds);
  return Math.min(nearest, Math.hypot(projected.x - point.x, projected.y - point.y));
}, Infinity);

const corridorClearance = (
  start: Readonly<V2>,
  end: Readonly<V2>,
  opponents: readonly ObservedPlayer[],
  seconds: number,
): number => opponents.reduce((nearest, opponent) => {
  const projected = predictObservedPosition(opponent, seconds);
  const closest = closestPointOnSegment(start, end, projected);
  return Math.min(nearest, Math.hypot(projected.x - closest.x, projected.y - closest.y));
}, Infinity);

const evaluateCandidate = (
  input: CarryAffordanceInput,
  context: EvaluationContext,
  candidate: CarryCandidatePoint,
): CarryAffordance => {
  const { snapshot, controllerGid, attackDir, reachProfiles } = input;
  const { controller, controllerProfile, opponents, teammates } = context;
  const selfReach = estimateReach(reachState(controller, controllerProfile), candidate.point);
  let opponentArrival = Infinity;
  for (const opponent of opponents) {
    opponentArrival = Math.min(opponentArrival, estimateReach(
      reachState(opponent, reachProfiles.get(opponent.gid)!),
      candidate.point,
    ).eta);
  }
  const displacement = {
    x: candidate.point.x - controller.pos.x,
    y: candidate.point.y - controller.pos.y,
  };
  const displacementLength = Math.hypot(displacement.x, displacement.y);
  const bodyAlignment = displacementLength <= EPS
    ? 1
    : (controller.bodyDir.x * displacement.x + controller.bodyDir.y * displacement.y)
      / displacementLength;
  const opponentGoal = { x: attackDir * HALF_L, y: 0 };
  const goalDistanceBefore = Math.hypot(
    opponentGoal.x - controller.pos.x,
    opponentGoal.y - controller.pos.y,
  );
  const goalDistanceAfter = Math.hypot(
    opponentGoal.x - candidate.point.x,
    opponentGoal.y - candidate.point.y,
  );
  return {
    candidate,
    controllerGid,
    selfArrival: selfReach.eta,
    selfTurnTime: selfReach.turnTime,
    bodyAlignment,
    opponentArrival,
    opponentArrivalMargin: opponentArrival - selfReach.eta,
    nearestOpponentDistanceAtArrival: minimumProjectedDistance(
      opponents, candidate.point, selfReach.eta,
    ),
    travelCorridorClearance: corridorClearance(
      controller.pos, candidate.point, opponents, selfReach.eta,
    ),
    nearestTeammateDistanceAtArrival: minimumProjectedDistance(
      teammates, candidate.point, selfReach.eta,
    ),
    goalDistanceBefore,
    goalDistanceAfter,
    goalwardProgression: goalDistanceBefore - goalDistanceAfter,
    goalCorridorClearance: corridorClearance(
      candidate.point, opponentGoal, opponents, selfReach.eta,
    ),
    fieldMargin: Math.min(
      HALF_L - Math.abs(candidate.point.x),
      HALF_W - Math.abs(candidate.point.y),
    ),
    selfObservationAgeTicks: controller.ageTicks,
    ballObservationAgeTicks: snapshot.ball!.ageTicks,
    observedOpponentCount: opponents.length,
    observedTeammateCount: teammates.length,
  };
};

export function evaluateCarryCandidate(
  input: CarryAffordanceInput,
  candidate: CarryCandidatePoint,
): CarryAffordance | null {
  const context = prepareEvaluation(input);
  if (!context || !finitePoint(candidate.point) || !insidePhysicalPitch(candidate.point)) {
    return null;
  }
  return evaluateCandidate(input, context, candidate);
}

export function evaluateCarryAffordances(
  input: CarryAffordanceInput,
): readonly CarryAffordance[] | null {
  const context = prepareEvaluation(input);
  if (!context) return null;
  return generateCarryCandidates(
    context.controller,
    context.controllerProfile,
    input.attackDir,
  ).map((candidate) => evaluateCandidate(input, context, candidate));
}
