import { BOX_DEPTH, BOX_WIDTH, HALF_L, HALF_W } from '../sim/constants';
import type { V2 } from '../utils/vec';
import { relativePointTarget } from './actionExecutor';
import {
  evaluateOffBallCandidate,
  type OffBallAffordance,
  type OffBallCandidatePoint,
} from './offBallAffordance';
import {
  evaluateOffBallOfferCoordination,
  type OffBallOfferCommitment,
  type OffBallOfferCoordinationFacts,
} from './offBallCoordination';
import type { ObservedPlayer, PerceptionSnapshot } from './perceptionSnapshot';
import { predictObservedPosition } from './prediction';
import { estimateReach, type KnownReachProfile } from './reachability';

const MAX_PREDICTION_HORIZON = 1.5;
const EPS = 1e-9;

export interface RelativeReferenceIntent {
  readonly referenceGid: number;
  readonly targetPoint: Readonly<V2>;
  readonly arrivalTime: number;
}

export interface RelativePointAffordanceInput {
  readonly relationId: string;
  readonly snapshot: PerceptionSnapshot;
  readonly playerGid: number;
  readonly carrierGid: number;
  readonly attackDir: 1 | -1;
  readonly reachProfiles: ReadonlyMap<number, KnownReachProfile>;
  readonly referenceIntent: RelativeReferenceIntent;
  readonly relativeOffset: Readonly<V2>;
  readonly commitments: readonly OffBallOfferCommitment[];
  readonly currentTick: number;
  readonly barredFromOpposingBox: boolean;
}

/**
 * Dormant relative-movement facts. Booleans remain separate by design: this
 * representation does not choose or authorise a commitment.
 */
export interface RelativePointAffordance {
  readonly relationId: string;
  readonly playerGid: number;
  readonly carrierGid: number;
  readonly referenceGid: number;
  readonly referenceStartPoint: Readonly<V2>;
  readonly referenceIntentPoint: Readonly<V2>;
  readonly referenceDisplacement: number;
  readonly intentHorizon: number;
  readonly relativeOffset: Readonly<V2>;
  readonly targetPoint: Readonly<V2>;
  readonly selfArrival: number;
  readonly arrivalSlack: number;
  readonly currentOffsideLine: number;
  readonly projectedOffsideLine: number;
  readonly currentOffsideMargin: number;
  readonly projectedOffsideMargin: number;
  readonly fieldMargin: number;
  readonly reachableByIntent: boolean;
  readonly insidePhysicalPitch: boolean;
  readonly projectedOnside: boolean;
  readonly barredBoxIntrusion: boolean;
  readonly barredAreaAllowed: boolean;
  readonly pointAffordance: OffBallAffordance | null;
  readonly coordination: OffBallOfferCoordinationFacts | null;
}

const finitePoint = (point: Readonly<V2>): boolean =>
  Number.isFinite(point.x) && Number.isFinite(point.y);

const localX = (x: number, attackDir: 1 | -1): number => x * attackDir;

const offsideLineFrom = (
  opponents: readonly Readonly<V2>[],
  carrierPoint: Readonly<V2>,
  attackDir: 1 | -1,
): number => {
  const opponentXs = opponents
    .map((point) => localX(point.x, attackDir))
    .sort((left, right) => right - left);
  return Math.max(
    opponentXs[1] ?? -HALF_L,
    localX(carrierPoint.x, attackDir),
    0,
  );
};

const reachState = (player: ObservedPlayer, profile: KnownReachProfile) => ({
  pos: player.pos,
  vel: player.vel,
  bodyDir: player.bodyDir,
  topSpeed: profile.topSpeed,
  accel: profile.accel,
  attrs: { dribbling: profile.dribbling ?? 0.5 },
});

const candidateFor = (
  relationId: string,
  targetPoint: Readonly<V2>,
  player: ObservedPlayer,
  attackDir: 1 | -1,
  horizon: number,
): OffBallCandidatePoint => ({
  id: `relative:${relationId}`,
  point: { x: targetPoint.x, y: targetPoint.y },
  sampleHorizon: horizon,
  directionIndex: null,
  forwardDelta: attackDir * (targetPoint.x - player.pos.x),
  lateralDelta: targetPoint.y - player.pos.y,
});

/**
 * Evaluate one predicted relation to a moving teammate. The reference endpoint
 * is supplied by S4/S9; this helper only composes geometry, reach, law/field
 * constraints and existing O0/O3 facts. It has no score or football label.
 */
export function evaluateRelativePointAffordance(
  input: RelativePointAffordanceInput,
): RelativePointAffordance | null {
  const {
    snapshot, playerGid, carrierGid, attackDir, reachProfiles,
    referenceIntent, relativeOffset, commitments, currentTick,
  } = input;
  const horizon = referenceIntent.arrivalTime;
  if (
    typeof input.relationId !== 'string'
    || input.relationId.length === 0
    || !Number.isInteger(playerGid)
    || !Number.isInteger(carrierGid)
    || !Number.isInteger(referenceIntent.referenceGid)
    || !Number.isInteger(currentTick)
    || !finitePoint(referenceIntent.targetPoint)
    || !finitePoint(relativeOffset)
    || !Number.isFinite(horizon)
    || horizon <= 0
    || horizon > MAX_PREDICTION_HORIZON + EPS
  ) return null;

  const player = snapshot.players.find((entry) => entry.gid === playerGid);
  const carrier = snapshot.players.find((entry) => entry.gid === carrierGid);
  const reference = snapshot.players.find((entry) => entry.gid === referenceIntent.referenceGid);
  const playerProfile = reachProfiles.get(playerGid);
  if (
    !player || !carrier || !reference || !playerProfile
    || snapshot.ball?.ownerGid !== carrierGid
    || player.side !== carrier.side
    || player.side !== reference.side
    || player.gid === carrier.gid
    || player.gid === reference.gid
  ) return null;

  const opponents = snapshot.players.filter((entry) => entry.side !== player.side);
  if (opponents.length === 0 || opponents.some((entry) => !reachProfiles.has(entry.gid))) {
    return null;
  }

  const targetPoint = relativePointTarget(
    referenceIntent.targetPoint, attackDir, relativeOffset,
  );
  if (!targetPoint) return null;

  const projectedCarrier = carrier.gid === reference.gid
    ? { x: referenceIntent.targetPoint.x, y: referenceIntent.targetPoint.y }
    : predictObservedPosition(carrier, horizon);
  const currentOffsideLine = offsideLineFrom(
    opponents.map((entry) => entry.pos), carrier.pos, attackDir,
  );
  const projectedOffsideLine = offsideLineFrom(
    opponents.map((entry) => predictObservedPosition(entry, horizon)),
    projectedCarrier,
    attackDir,
  );
  const currentOffsideMargin = localX(targetPoint.x, attackDir) - currentOffsideLine;
  const projectedOffsideMargin = localX(targetPoint.x, attackDir) - projectedOffsideLine;
  const fieldMargin = Math.min(
    HALF_L - Math.abs(targetPoint.x),
    HALF_W - Math.abs(targetPoint.y),
  );
  const insidePhysicalPitch = fieldMargin >= 0;
  const targetLocalX = localX(targetPoint.x, attackDir);
  const barredBoxIntrusion = input.barredFromOpposingBox
    && targetLocalX > HALF_L - (BOX_DEPTH + 0.8)
    && Math.abs(targetPoint.y) < BOX_WIDTH / 2 + 0.5;
  const selfReach = estimateReach(reachState(player, playerProfile), targetPoint);
  const candidate = candidateFor(
    input.relationId, targetPoint, player, attackDir, horizon,
  );
  const pointAffordance = insidePhysicalPitch
    ? evaluateOffBallCandidate({
      snapshot,
      playerGid,
      carrierGid,
      attackDir,
      reachProfiles,
    }, candidate)
    : null;
  if (insidePhysicalPitch && pointAffordance === null) return null;
  const coordination = pointAffordance === null
    ? null
    : evaluateOffBallOfferCoordination({
      candidate: pointAffordance,
      carrierPoint: carrier.pos,
      commitments,
      currentTick,
    });
  if (pointAffordance !== null && coordination === null) return null;

  return {
    relationId: input.relationId,
    playerGid,
    carrierGid,
    referenceGid: reference.gid,
    referenceStartPoint: { x: reference.pos.x, y: reference.pos.y },
    referenceIntentPoint: {
      x: referenceIntent.targetPoint.x,
      y: referenceIntent.targetPoint.y,
    },
    referenceDisplacement: Math.hypot(
      referenceIntent.targetPoint.x - reference.pos.x,
      referenceIntent.targetPoint.y - reference.pos.y,
    ),
    intentHorizon: horizon,
    relativeOffset: { x: relativeOffset.x, y: relativeOffset.y },
    targetPoint: { x: targetPoint.x, y: targetPoint.y },
    selfArrival: selfReach.eta,
    arrivalSlack: horizon - selfReach.eta,
    currentOffsideLine,
    projectedOffsideLine,
    currentOffsideMargin,
    projectedOffsideMargin,
    fieldMargin,
    reachableByIntent: selfReach.eta <= horizon,
    insidePhysicalPitch,
    projectedOnside: projectedOffsideMargin <= 0,
    barredBoxIntrusion,
    barredAreaAllowed: !barredBoxIntrusion,
    pointAffordance,
    coordination,
  };
}
