import type { OffBallAffordance } from './offBallAffordance';
import { closestPointOnSegment, type V2 } from '../utils/vec';

const EPS = 1e-9;

export interface OffBallOfferCommitment {
  readonly playerGid: number;
  readonly carrierGid: number;
  readonly targetPoint: Readonly<V2>;
  readonly arrivalTime: number;
  readonly committedTick: number;
  readonly validUntilTick: number;
}

export interface OffBallOfferCoordinationFacts {
  readonly playerGid: number;
  readonly carrierGid: number;
  readonly candidateId: string;
  readonly activeCommitmentCount: number;
  readonly nearestTargetDistance: number | null;
  readonly nearestTargetPlayerGid: number | null;
  readonly nearestBearingSeparation: number | null;
  readonly nearestBearingPlayerGid: number | null;
  readonly nearestArrivalTimeSeparation: number | null;
  readonly nearestArrivalPlayerGid: number | null;
  readonly nearestCorridorSeparation: number | null;
  readonly nearestCorridorPlayerGid: number | null;
}

export interface OffBallOfferCoordinationInput {
  readonly candidate: OffBallAffordance;
  readonly carrierPoint: Readonly<V2>;
  readonly commitments: readonly OffBallOfferCommitment[];
  readonly currentTick: number;
}

export interface OffBallOfferPortfolioPair {
  readonly leftPlayerGid: number;
  readonly rightPlayerGid: number;
  readonly targetDistance: number;
  readonly bearingSeparation: number | null;
  readonly arrivalTimeSeparation: number;
  readonly corridorSeparation: number;
}

export interface OffBallOfferPortfolioRange {
  readonly min: number;
  readonly max: number;
  readonly minPair: readonly [number, number];
  readonly maxPair: readonly [number, number];
}

export interface OffBallOfferPortfolio {
  readonly carrierGid: number;
  readonly commitments: readonly OffBallOfferCommitment[];
  readonly pairs: readonly OffBallOfferPortfolioPair[];
  readonly targetDistance: OffBallOfferPortfolioRange | null;
  readonly bearingSeparation: OffBallOfferPortfolioRange | null;
  readonly arrivalTimeSeparation: OffBallOfferPortfolioRange | null;
  readonly corridorSeparation: OffBallOfferPortfolioRange | null;
}

export interface OffBallOfferPortfolioInput {
  readonly carrierGid: number;
  readonly carrierPoint: Readonly<V2>;
  readonly commitments: readonly OffBallOfferCommitment[];
  readonly currentTick: number;
}

const finitePoint = (point: Readonly<V2>): boolean =>
  Number.isFinite(point.x) && Number.isFinite(point.y);

const validCommitment = (commitment: OffBallOfferCommitment): boolean =>
  Number.isInteger(commitment.playerGid)
  && Number.isInteger(commitment.carrierGid)
  && finitePoint(commitment.targetPoint)
  && Number.isFinite(commitment.arrivalTime)
  && commitment.arrivalTime >= 0
  && Number.isInteger(commitment.committedTick)
  && Number.isInteger(commitment.validUntilTick)
  && commitment.validUntilTick >= commitment.committedTick;

const bearingFrom = (origin: Readonly<V2>, point: Readonly<V2>): number | null => {
  const x = point.x - origin.x;
  const y = point.y - origin.y;
  if (Math.hypot(x, y) < EPS) return null;
  return Math.atan2(y, x);
};

const angleSeparation = (left: number, right: number): number => {
  const raw = Math.abs(left - right) % (Math.PI * 2);
  return Math.min(raw, Math.PI * 2 - raw);
};

const pointSegmentDistance = (
  point: Readonly<V2>, start: Readonly<V2>, end: Readonly<V2>,
): number => {
  const closest = closestPointOnSegment(start, end, point);
  return Math.hypot(point.x - closest.x, point.y - closest.y);
};

const corridorSeparation = (
  carrier: Readonly<V2>, left: Readonly<V2>, right: Readonly<V2>,
): number => Math.min(
  pointSegmentDistance(left, carrier, right),
  pointSegmentDistance(right, carrier, left),
);

/**
 * Freeze one already-evaluated generic offer as shareable intent. This helper
 * records no tactical name and does not choose an expiry policy for its caller.
 */
export function createOffBallOfferCommitment(
  candidate: OffBallAffordance,
  committedTick: number,
  validUntilTick: number,
): OffBallOfferCommitment | null {
  const commitment: OffBallOfferCommitment = {
    playerGid: candidate.playerGid,
    carrierGid: candidate.carrierGid,
    targetPoint: { x: candidate.candidate.point.x, y: candidate.candidate.point.y },
    arrivalTime: candidate.selfArrival,
    committedTick,
    validUntilTick,
  };
  return validCommitment(commitment) ? commitment : null;
}

/**
 * Compare one candidate with teammates' explicit same-carrier commitments.
 * Every output remains a separate fact; no duplicate threshold or score exists.
 */
export function evaluateOffBallOfferCoordination(
  input: OffBallOfferCoordinationInput,
): OffBallOfferCoordinationFacts | null {
  const { candidate, carrierPoint, commitments, currentTick } = input;
  if (!finitePoint(carrierPoint) || !Number.isInteger(currentTick)) return null;

  const relevant: OffBallOfferCommitment[] = [];
  for (const commitment of commitments) {
    if (
      commitment.carrierGid !== candidate.carrierGid
      || commitment.playerGid === candidate.playerGid
      || commitment.validUntilTick < currentTick
    ) continue;
    if (!validCommitment(commitment)) return null;
    relevant.push(commitment);
  }

  const result: OffBallOfferCoordinationFacts = {
    playerGid: candidate.playerGid,
    carrierGid: candidate.carrierGid,
    candidateId: candidate.candidate.id,
    activeCommitmentCount: relevant.length,
    nearestTargetDistance: null,
    nearestTargetPlayerGid: null,
    nearestBearingSeparation: null,
    nearestBearingPlayerGid: null,
    nearestArrivalTimeSeparation: null,
    nearestArrivalPlayerGid: null,
    nearestCorridorSeparation: null,
    nearestCorridorPlayerGid: null,
  };
  if (relevant.length === 0) return result;

  const candidateBearing = bearingFrom(carrierPoint, candidate.candidate.point);
  let nearestTargetDistance = Infinity;
  let nearestTargetPlayerGid: number | null = null;
  let nearestBearingSeparation = Infinity;
  let nearestBearingPlayerGid: number | null = null;
  let nearestArrivalTimeSeparation = Infinity;
  let nearestArrivalPlayerGid: number | null = null;
  let nearestCorridorSeparation = Infinity;
  let nearestCorridorPlayerGid: number | null = null;

  for (const commitment of relevant) {
    const targetDistance = Math.hypot(
      commitment.targetPoint.x - candidate.candidate.point.x,
      commitment.targetPoint.y - candidate.candidate.point.y,
    );
    if (targetDistance < nearestTargetDistance) {
      nearestTargetDistance = targetDistance;
      nearestTargetPlayerGid = commitment.playerGid;
    }

    const otherBearing = bearingFrom(carrierPoint, commitment.targetPoint);
    if (candidateBearing !== null && otherBearing !== null) {
      const separation = angleSeparation(candidateBearing, otherBearing);
      if (separation < nearestBearingSeparation) {
        nearestBearingSeparation = separation;
        nearestBearingPlayerGid = commitment.playerGid;
      }
    }

    const arrivalSeparation = Math.abs(commitment.arrivalTime - candidate.selfArrival);
    if (arrivalSeparation < nearestArrivalTimeSeparation) {
      nearestArrivalTimeSeparation = arrivalSeparation;
      nearestArrivalPlayerGid = commitment.playerGid;
    }

    const laneSeparation = corridorSeparation(
      carrierPoint, candidate.candidate.point, commitment.targetPoint,
    );
    if (laneSeparation < nearestCorridorSeparation) {
      nearestCorridorSeparation = laneSeparation;
      nearestCorridorPlayerGid = commitment.playerGid;
    }
  }

  return {
    ...result,
    nearestTargetDistance,
    nearestTargetPlayerGid,
    nearestBearingSeparation: Number.isFinite(nearestBearingSeparation)
      ? nearestBearingSeparation
      : null,
    nearestBearingPlayerGid,
    nearestArrivalTimeSeparation,
    nearestArrivalPlayerGid,
    nearestCorridorSeparation,
    nearestCorridorPlayerGid,
  };
}

const rangeOf = (
  pairs: readonly OffBallOfferPortfolioPair[],
  valueOf: (pair: OffBallOfferPortfolioPair) => number | null,
): OffBallOfferPortfolioRange | null => {
  let min = Infinity;
  let max = -Infinity;
  let minPair: readonly [number, number] | null = null;
  let maxPair: readonly [number, number] | null = null;
  for (const pair of pairs) {
    const value = valueOf(pair);
    if (value === null) continue;
    const gids = [pair.leftPlayerGid, pair.rightPlayerGid] as const;
    if (value < min) {
      min = value;
      minPair = gids;
    }
    if (value > max) {
      max = value;
      maxPair = gids;
    }
  }
  return minPair && maxPair ? { min, max, minPair, maxPair } : null;
};

/**
 * Freeze all active same-carrier commitments into one deterministic portfolio.
 * Pairwise facts remain separate and named-pattern-free; this never allocates.
 */
export function evaluateOffBallOfferPortfolio(
  input: OffBallOfferPortfolioInput,
): OffBallOfferPortfolio | null {
  const { carrierGid, carrierPoint, commitments, currentTick } = input;
  if (
    !Number.isInteger(carrierGid)
    || !finitePoint(carrierPoint)
    || !Number.isInteger(currentTick)
  ) return null;

  const active: OffBallOfferCommitment[] = [];
  const players = new Set<number>();
  for (const commitment of commitments) {
    if (
      Number.isInteger(commitment.validUntilTick)
      && commitment.validUntilTick < currentTick
    ) continue;
    if (
      !validCommitment(commitment)
      || commitment.carrierGid !== carrierGid
      || players.has(commitment.playerGid)
    ) return null;
    players.add(commitment.playerGid);
    active.push({
      ...commitment,
      targetPoint: { x: commitment.targetPoint.x, y: commitment.targetPoint.y },
    });
  }
  active.sort((a, b) => a.playerGid - b.playerGid);

  const pairs: OffBallOfferPortfolioPair[] = [];
  for (let leftIndex = 0; leftIndex < active.length; leftIndex++) {
    const left = active[leftIndex];
    for (let rightIndex = leftIndex + 1; rightIndex < active.length; rightIndex++) {
      const right = active[rightIndex];
      const leftBearing = bearingFrom(carrierPoint, left.targetPoint);
      const rightBearing = bearingFrom(carrierPoint, right.targetPoint);
      pairs.push({
        leftPlayerGid: left.playerGid,
        rightPlayerGid: right.playerGid,
        targetDistance: Math.hypot(
          left.targetPoint.x - right.targetPoint.x,
          left.targetPoint.y - right.targetPoint.y,
        ),
        bearingSeparation: leftBearing === null || rightBearing === null
          ? null
          : angleSeparation(leftBearing, rightBearing),
        arrivalTimeSeparation: Math.abs(left.arrivalTime - right.arrivalTime),
        corridorSeparation: corridorSeparation(
          carrierPoint, left.targetPoint, right.targetPoint,
        ),
      });
    }
  }

  return {
    carrierGid,
    commitments: active,
    pairs,
    targetDistance: rangeOf(pairs, (pair) => pair.targetDistance),
    bearingSeparation: rangeOf(pairs, (pair) => pair.bearingSeparation),
    arrivalTimeSeparation: rangeOf(pairs, (pair) => pair.arrivalTimeSeparation),
    corridorSeparation: rangeOf(pairs, (pair) => pair.corridorSeparation),
  };
}
