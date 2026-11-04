import type { V2 } from '../utils/vec';

export interface TeamCoordinationDemand {
  readonly demandId: string;
  readonly targetPoint: Readonly<V2>;
  readonly earliestArrival: number;
  readonly latestArrival: number;
  readonly minimumParticipants: number;
  readonly maximumParticipants: number;
  readonly publishedTick: number;
  readonly validUntilTick: number;
}
export interface TeamCoordinationClaim {
  readonly demandId: string;
  readonly playerGid: number;
  readonly committedTick: number;
  readonly validUntilTick: number;
}

export interface TeamCoordinationOccupancy {
  readonly demandId: string;
  readonly targetPoint: Readonly<V2>;
  readonly earliestArrival: number;
  readonly latestArrival: number;
  readonly minimumParticipants: number;
  readonly maximumParticipants: number;
  readonly activeClaimantGids: readonly number[];
  readonly activeClaimCount: number;
  readonly missingParticipantCount: number;
  readonly excessParticipantCount: number;
}

export interface TeamCoordinationPlayerFacts {
  readonly demandId: string;
  readonly playerGid: number;
  readonly arrivalTime: number;
  /** Positive means arrival is on or after the window opens. */
  readonly earliestArrivalSlack: number;
  /** Positive means arrival is on or before the window closes. */
  readonly latestArrivalSlack: number;
  readonly insideArrivalWindow: boolean;
  readonly alreadyClaimsDemand: boolean;
  readonly otherActiveDemandIds: readonly string[];
  readonly occupancy: TeamCoordinationOccupancy;
}

export interface TeamCoordinationOccupancyInput {
  readonly demand: TeamCoordinationDemand;
  readonly claims: readonly TeamCoordinationClaim[];
  readonly currentTick: number;
}

export interface TeamCoordinationPlayerFactsInput extends TeamCoordinationOccupancyInput {
  readonly playerGid: number;
  readonly arrivalTime: number;
}

const finitePoint = (point: Readonly<V2>): boolean =>
  Number.isFinite(point.x) && Number.isFinite(point.y);

const validDemand = (demand: TeamCoordinationDemand): boolean =>
  typeof demand.demandId === 'string'
  && demand.demandId.length > 0
  && finitePoint(demand.targetPoint)
  && Number.isFinite(demand.earliestArrival)
  && demand.earliestArrival >= 0
  && Number.isFinite(demand.latestArrival)
  && demand.latestArrival >= demand.earliestArrival
  && Number.isInteger(demand.minimumParticipants)
  && demand.minimumParticipants >= 0
  && Number.isInteger(demand.maximumParticipants)
  && demand.maximumParticipants >= demand.minimumParticipants
  && Number.isInteger(demand.publishedTick)
  && Number.isInteger(demand.validUntilTick)
  && demand.validUntilTick >= demand.publishedTick;

const validClaim = (claim: TeamCoordinationClaim): boolean =>
  typeof claim.demandId === 'string'
  && claim.demandId.length > 0
  && Number.isInteger(claim.playerGid)
  && Number.isInteger(claim.committedTick)
  && Number.isInteger(claim.validUntilTick)
  && claim.validUntilTick >= claim.committedTick;

const activeAt = (
  claim: TeamCoordinationClaim,
  currentTick: number,
): boolean => claim.committedTick <= currentTick && claim.validUntilTick >= currentTick;

interface ValidatedClaims {
  readonly active: readonly TeamCoordinationClaim[];
  readonly activeKeys: ReadonlySet<string>;
}

const validateClaims = (
  claims: readonly TeamCoordinationClaim[],
  currentTick: number,
): ValidatedClaims | null => {
  const active: TeamCoordinationClaim[] = [];
  const activeKeys = new Set<string>();
  for (const claim of claims) {
    if (!validClaim(claim)) return null;
    if (!activeAt(claim, currentTick)) continue;
    const key = `${claim.demandId}\u0000${claim.playerGid}`;
    if (activeKeys.has(key)) return null;
    activeKeys.add(key);
    active.push(claim);
  }
  return { active, activeKeys };
};

const evaluateWithValidatedClaims = (
  demand: TeamCoordinationDemand,
  activeClaims: readonly TeamCoordinationClaim[],
): TeamCoordinationOccupancy => {
  const activeClaimantGids = activeClaims
    .filter((claim) => claim.demandId === demand.demandId)
    .map((claim) => claim.playerGid)
    .sort((left, right) => left - right);
  const activeClaimCount = activeClaimantGids.length;
  return {
    demandId: demand.demandId,
    targetPoint: { x: demand.targetPoint.x, y: demand.targetPoint.y },
    earliestArrival: demand.earliestArrival,
    latestArrival: demand.latestArrival,
    minimumParticipants: demand.minimumParticipants,
    maximumParticipants: demand.maximumParticipants,
    activeClaimantGids,
    activeClaimCount,
    missingParticipantCount: Math.max(0, demand.minimumParticipants - activeClaimCount),
    excessParticipantCount: Math.max(0, activeClaimCount - demand.maximumParticipants),
  };
};

/**
 * Account for explicit claims against one explicit demand. The arithmetic
 * never infers a demand, merges spatially similar targets or allocates a player.
 */
export function evaluateTeamCoordinationOccupancy(
  input: TeamCoordinationOccupancyInput,
): TeamCoordinationOccupancy | null {
  const { demand, claims, currentTick } = input;
  if (
    !validDemand(demand)
    || !Number.isInteger(currentTick)
    || currentTick < demand.publishedTick
    || currentTick > demand.validUntilTick
  ) return null;
  const validated = validateClaims(claims, currentTick);
  return validated === null
    ? null
    : evaluateWithValidatedClaims(demand, validated.active);
}

/**
 * Compose caller-owned arrival time with the same occupancy ledger. This
 * reports facts only: it neither creates a claim nor ranks candidate players.
 */
export function evaluateTeamCoordinationPlayerFacts(
  input: TeamCoordinationPlayerFactsInput,
): TeamCoordinationPlayerFacts | null {
  const { demand, claims, currentTick, playerGid, arrivalTime } = input;
  if (
    !validDemand(demand)
    || !Number.isInteger(currentTick)
    || currentTick < demand.publishedTick
    || currentTick > demand.validUntilTick
    || !Number.isInteger(playerGid)
    || !Number.isFinite(arrivalTime)
    || arrivalTime < 0
  ) return null;
  const validated = validateClaims(claims, currentTick);
  if (validated === null) return null;
  const occupancy = evaluateWithValidatedClaims(demand, validated.active);
  const otherActiveDemandIds = validated.active
    .filter((claim) => claim.playerGid === playerGid && claim.demandId !== demand.demandId)
    .map((claim) => claim.demandId)
    .sort();
  const earliestArrivalSlack = arrivalTime - demand.earliestArrival;
  const latestArrivalSlack = demand.latestArrival - arrivalTime;
  return {
    demandId: demand.demandId,
    playerGid,
    arrivalTime,
    earliestArrivalSlack,
    latestArrivalSlack,
    insideArrivalWindow: earliestArrivalSlack >= 0 && latestArrivalSlack >= 0,
    alreadyClaimsDemand: validated.activeKeys.has(`${demand.demandId}\u0000${playerGid}`),
    otherActiveDemandIds,
    occupancy,
  };
}
