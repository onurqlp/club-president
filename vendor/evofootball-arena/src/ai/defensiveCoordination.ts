import type { OffBallCandidatePoint } from './offBallAffordance';
import type { ObservedPlayer, PerceptionSnapshot } from './perceptionSnapshot';
import { estimateReach, type KnownReachProfile, type ReachState } from './reachability';
import { closestPointOnSegment, type V2 } from '../utils/vec';

const EPS = 1e-9;

export interface DefensiveMovementCommitment {
  readonly playerGid: number;
  readonly observedCarrierGid: number;
  readonly targetPoint: Readonly<V2>;
  readonly arrivalTime: number;
  readonly expectedBodyDir: Readonly<V2>;
  readonly committedTick: number;
  readonly validUntilTick: number;
}

export type RelativelyExposedOutlet = 'a' | 'b' | null;

/**
 * Separate observer-grounded coordination facts. There is deliberately no
 * aggregate coverage score, task name, response winner or action permission.
 */
export interface DefensiveCoverCoordinationFacts {
  readonly playerGid: number;
  readonly committedPlayerGid: number;
  readonly observedCarrierGid: number;
  readonly candidateId: string;
  readonly commitmentAgeTicks: number;
  readonly commitmentRemainingTicks: number;
  readonly observerAgeTicks: number;
  readonly committedPlayerAgeTicks: number;
  readonly outletAAgeTicks: number;
  readonly outletBAgeTicks: number;
  readonly selfArrivalA: number;
  readonly selfArrivalB: number;
  readonly committedArrivalA: number;
  readonly committedArrivalB: number;
  readonly selfCorridorDistanceA: number;
  readonly selfCorridorDistanceB: number;
  readonly committedCorridorDistanceA: number;
  readonly committedCorridorDistanceB: number;
  readonly targetDistance: number;
  readonly bearingSeparation: number | null;
  readonly arrivalTimeSeparation: number;
  readonly relativelyExposedOutlet: RelativelyExposedOutlet;
}

export interface DefensiveMovementCommitmentInput {
  readonly player: ObservedPlayer;
  readonly observedCarrierGid: number;
  readonly candidate: OffBallCandidatePoint;
  readonly arrivalTime: number;
  readonly committedTick: number;
  readonly validUntilTick: number;
}

export interface DefensiveCoverCoordinationInput {
  readonly snapshot: PerceptionSnapshot;
  readonly playerGid: number;
  readonly outletAGid: number;
  readonly outletBGid: number;
  readonly candidate: OffBallCandidatePoint;
  readonly commitment: DefensiveMovementCommitment;
  readonly reachProfiles: ReadonlyMap<number, KnownReachProfile>;
  readonly currentTick: number;
}

const finitePoint = (point: Readonly<V2>): boolean =>
  Number.isFinite(point.x) && Number.isFinite(point.y);

const unitOr = (x: number, y: number, fallback: Readonly<V2>): V2 => {
  const magnitude = Math.hypot(x, y);
  if (magnitude <= EPS) return { x: fallback.x, y: fallback.y };
  return { x: x / magnitude, y: y / magnitude };
};

const validCommitment = (commitment: DefensiveMovementCommitment): boolean =>
  Number.isInteger(commitment.playerGid)
  && Number.isInteger(commitment.observedCarrierGid)
  && finitePoint(commitment.targetPoint)
  && Number.isFinite(commitment.arrivalTime)
  && commitment.arrivalTime >= 0
  && finitePoint(commitment.expectedBodyDir)
  && Math.hypot(commitment.expectedBodyDir.x, commitment.expectedBodyDir.y) > EPS
  && Number.isInteger(commitment.committedTick)
  && Number.isInteger(commitment.validUntilTick)
  && commitment.validUntilTick >= commitment.committedTick;

const reachState = (player: ObservedPlayer, profile: KnownReachProfile): ReachState => ({
  pos: player.pos,
  vel: player.vel,
  bodyDir: player.bodyDir,
  topSpeed: profile.topSpeed,
  accel: profile.accel,
  attrs: { dribbling: profile.dribbling ?? 0.5 },
});

const committedReachState = (
  commitment: DefensiveMovementCommitment,
  profile: KnownReachProfile,
): ReachState => ({
  pos: commitment.targetPoint,
  vel: { x: 0, y: 0 },
  bodyDir: commitment.expectedBodyDir,
  topSpeed: profile.topSpeed,
  accel: profile.accel,
  attrs: { dribbling: profile.dribbling ?? 0.5 },
});

const pointSegmentDistance = (
  point: Readonly<V2>,
  start: Readonly<V2>,
  end: Readonly<V2>,
): number => {
  const closest = closestPointOnSegment(start, end, point);
  return Math.hypot(point.x - closest.x, point.y - closest.y);
};

const bearingFrom = (origin: Readonly<V2>, point: Readonly<V2>): number | null => {
  const x = point.x - origin.x;
  const y = point.y - origin.y;
  if (Math.hypot(x, y) <= EPS) return null;
  return Math.atan2(y, x);
};

const angleSeparation = (left: number, right: number): number => {
  const raw = Math.abs(left - right) % (Math.PI * 2);
  return Math.min(raw, Math.PI * 2 - raw);
};

/** Freeze one already-chosen generic movement as shareable intent. */
export function createDefensiveMovementCommitment(
  input: DefensiveMovementCommitmentInput,
): DefensiveMovementCommitment | null {
  const { player, observedCarrierGid, candidate, arrivalTime, committedTick, validUntilTick } = input;
  const expectedBodyDir = unitOr(
    candidate.point.x - player.pos.x,
    candidate.point.y - player.pos.y,
    player.bodyDir,
  );
  const commitment: DefensiveMovementCommitment = {
    playerGid: player.gid,
    observedCarrierGid,
    targetPoint: { x: candidate.point.x, y: candidate.point.y },
    arrivalTime,
    expectedBodyDir,
    committedTick,
    validUntilTick,
  };
  return validCommitment(commitment) ? commitment : null;
}

/**
 * Evaluate one D2 candidate against one observed D1 movement commitment.
 * Missing or stale identities return null instead of consulting Match truth.
 */
export function evaluateDefensiveCoverCoordination(
  input: DefensiveCoverCoordinationInput,
): DefensiveCoverCoordinationFacts | null {
  const {
    snapshot, playerGid, outletAGid, outletBGid, candidate,
    commitment, reachProfiles, currentTick,
  } = input;
  if (
    !Number.isInteger(currentTick)
    || !validCommitment(commitment)
    || currentTick < commitment.committedTick
    || currentTick > commitment.validUntilTick
    || playerGid === commitment.playerGid
    || outletAGid === outletBGid
    || !finitePoint(candidate.point)
  ) return null;

  const player = snapshot.players.find((entry) => entry.gid === playerGid);
  const committedPlayer = snapshot.players.find((entry) => entry.gid === commitment.playerGid);
  const carrier = snapshot.players.find((entry) => entry.gid === commitment.observedCarrierGid);
  const outletA = snapshot.players.find((entry) => entry.gid === outletAGid);
  const outletB = snapshot.players.find((entry) => entry.gid === outletBGid);
  const playerProfile = reachProfiles.get(playerGid);
  const committedProfile = reachProfiles.get(commitment.playerGid);
  if (
    !player || !committedPlayer || !carrier || !outletA || !outletB
    || !playerProfile || !committedProfile
    || player.side !== committedPlayer.side
    || outletA.side === player.side
    || outletB.side === player.side
    || carrier.side !== outletA.side
  ) return null;

  const selfState = reachState(player, playerProfile);
  const committedState = committedReachState(commitment, committedProfile);
  const selfArrivalA = estimateReach(selfState, outletA.pos).eta;
  const selfArrivalB = estimateReach(selfState, outletB.pos).eta;
  const committedArrivalA = commitment.arrivalTime + estimateReach(committedState, outletA.pos).eta;
  const committedArrivalB = commitment.arrivalTime + estimateReach(committedState, outletB.pos).eta;
  const exposedDelta = committedArrivalA - committedArrivalB;
  const selfBearing = bearingFrom(carrier.pos, candidate.point);
  const committedBearing = bearingFrom(carrier.pos, commitment.targetPoint);

  return {
    playerGid,
    committedPlayerGid: commitment.playerGid,
    observedCarrierGid: commitment.observedCarrierGid,
    candidateId: candidate.id,
    commitmentAgeTicks: currentTick - commitment.committedTick,
    commitmentRemainingTicks: commitment.validUntilTick - currentTick,
    observerAgeTicks: player.ageTicks,
    committedPlayerAgeTicks: committedPlayer.ageTicks,
    outletAAgeTicks: outletA.ageTicks,
    outletBAgeTicks: outletB.ageTicks,
    selfArrivalA,
    selfArrivalB,
    committedArrivalA,
    committedArrivalB,
    selfCorridorDistanceA: pointSegmentDistance(candidate.point, carrier.pos, outletA.pos),
    selfCorridorDistanceB: pointSegmentDistance(candidate.point, carrier.pos, outletB.pos),
    committedCorridorDistanceA: pointSegmentDistance(
      commitment.targetPoint, carrier.pos, outletA.pos,
    ),
    committedCorridorDistanceB: pointSegmentDistance(
      commitment.targetPoint, carrier.pos, outletB.pos,
    ),
    targetDistance: Math.hypot(
      candidate.point.x - commitment.targetPoint.x,
      candidate.point.y - commitment.targetPoint.y,
    ),
    bearingSeparation: selfBearing === null || committedBearing === null
      ? null
      : angleSeparation(selfBearing, committedBearing),
    arrivalTimeSeparation: Math.abs(
      estimateReach(selfState, candidate.point).eta - commitment.arrivalTime,
    ),
    relativelyExposedOutlet: Math.abs(exposedDelta) <= EPS
      ? null
      : exposedDelta > 0 ? 'a' : 'b',
  };
}
