import type { PerceptionSnapshot } from './perceptionSnapshot';
import type { V2 } from '../utils/vec';

export type PrivateIntentPhase =
  | 'proposed'
  | 'committed'
  | 'executing'
  | 'fulfilled'
  | 'revoked'
  | 'invalidated';

export interface PrivateIntentTransaction {
  readonly actorGid: number;
  readonly referenceGid: number;
  readonly referenceEpoch: number;
  readonly targetPoint: Readonly<V2>;
  readonly intendedArrivalTime: number;
  readonly openedTick: number;
  readonly phase: PrivateIntentPhase;
  readonly phaseTick: number;
}

export interface PrivateIntentInput {
  readonly actorGid: number;
  readonly referenceGid: number;
  readonly referenceEpoch: number;
  readonly targetPoint: Readonly<V2>;
  readonly intendedArrivalTime: number;
  readonly openedTick: number;
}

export interface ObservedIntentEvidence {
  readonly observerGid: number;
  readonly actorGid: number;
  readonly observedTick: number;
  readonly observationAgeTicks: number;
  readonly observedPos: Readonly<V2>;
  readonly observedVel: Readonly<V2>;
  readonly observedBodyDir: Readonly<V2>;
  readonly displacementSincePrevious: Readonly<V2> | null;
  readonly velocityChangeSincePrevious: Readonly<V2> | null;
  readonly bodyTurnSincePrevious: number | null;
}

export interface IntentCandidateHypothesis {
  readonly id: string;
  readonly point: Readonly<V2>;
}

export interface ObservedIntentHypothesisEvidence {
  readonly observerGid: number;
  readonly actorGid: number;
  readonly candidateId: string;
  readonly velocityBearingAlignment: number | null;
  readonly displacementBearingAlignment: number | null;
  readonly bodyBearingAlignment: number | null;
  readonly observedClosingSpeed: number | null;
  readonly evidenceAgeTicks: number;
}

const finiteVector = (value: Readonly<V2>): boolean =>
  Number.isFinite(value.x) && Number.isFinite(value.y);

const validId = (value: number): boolean => Number.isInteger(value) && value >= 0;
const validTick = (value: number): boolean => Number.isInteger(value) && value >= 0;
const copyVector = (value: Readonly<V2>): V2 => ({ x: value.x, y: value.y });

export function createPrivateIntentTransaction(
  input: PrivateIntentInput,
): PrivateIntentTransaction | null {
  if (
    !validId(input.actorGid)
    || !validId(input.referenceGid)
    || input.actorGid === input.referenceGid
    || !validTick(input.referenceEpoch)
    || !validTick(input.openedTick)
    || !finiteVector(input.targetPoint)
    || !Number.isFinite(input.intendedArrivalTime)
    || input.intendedArrivalTime < 0
  ) return null;

  return {
    actorGid: input.actorGid,
    referenceGid: input.referenceGid,
    referenceEpoch: input.referenceEpoch,
    targetPoint: copyVector(input.targetPoint),
    intendedArrivalTime: input.intendedArrivalTime,
    openedTick: input.openedTick,
    phase: 'proposed',
    phaseTick: input.openedTick,
  };
}

const legalTransitions: Readonly<Record<PrivateIntentPhase, readonly PrivateIntentPhase[]>> = {
  proposed: ['committed', 'revoked', 'invalidated'],
  committed: ['executing', 'revoked', 'invalidated'],
  executing: ['fulfilled', 'revoked', 'invalidated'],
  fulfilled: [],
  revoked: [],
  invalidated: [],
};

export function transitionPrivateIntent(
  transaction: PrivateIntentTransaction,
  nextPhase: PrivateIntentPhase,
  phaseTick: number,
): PrivateIntentTransaction | null {
  if (!validPrivateIntentTransaction(transaction) || !validTick(phaseTick)) return null;
  if (phaseTick < transaction.phaseTick) return null;
  if (!legalTransitions[transaction.phase].includes(nextPhase)) return null;
  return {
    ...transaction,
    targetPoint: copyVector(transaction.targetPoint),
    phase: nextPhase,
    phaseTick,
  };
}

export function replacePrivateIntent(
  transaction: PrivateIntentTransaction,
  targetPoint: Readonly<V2>,
  intendedArrivalTime: number,
  openedTick: number,
): PrivateIntentTransaction | null {
  if (
    !validPrivateIntentTransaction(transaction)
    || !finiteVector(targetPoint)
    || !Number.isFinite(intendedArrivalTime)
    || intendedArrivalTime < 0
    || !validTick(openedTick)
    || openedTick < transaction.phaseTick
  ) return null;
  return createPrivateIntentTransaction({
    actorGid: transaction.actorGid,
    referenceGid: transaction.referenceGid,
    referenceEpoch: transaction.referenceEpoch,
    targetPoint,
    intendedArrivalTime,
    openedTick,
  });
}

export function invalidatePrivateIntentForReference(
  transaction: PrivateIntentTransaction,
  observedReferenceGid: number,
  observedReferenceEpoch: number,
  tick: number,
): PrivateIntentTransaction | null {
  if (!validId(observedReferenceGid) || !validTick(observedReferenceEpoch)) return null;
  if (
    transaction.referenceGid === observedReferenceGid
    && transaction.referenceEpoch === observedReferenceEpoch
  ) return {
    ...transaction,
    targetPoint: copyVector(transaction.targetPoint),
  };
  if (transaction.phase === 'fulfilled' || transaction.phase === 'revoked') return null;
  return transitionPrivateIntent(transaction, 'invalidated', tick);
}

export function validPrivateIntentTransaction(
  transaction: PrivateIntentTransaction,
): boolean {
  return validId(transaction.actorGid)
    && validId(transaction.referenceGid)
    && transaction.actorGid !== transaction.referenceGid
    && validTick(transaction.referenceEpoch)
    && finiteVector(transaction.targetPoint)
    && Number.isFinite(transaction.intendedArrivalTime)
    && transaction.intendedArrivalTime >= 0
    && validTick(transaction.openedTick)
    && validTick(transaction.phaseTick)
    && transaction.phaseTick >= transaction.openedTick
    && Object.hasOwn(legalTransitions, transaction.phase);
}

const angleBetween = (from: Readonly<V2>, to: Readonly<V2>): number | null => {
  const fromLength = Math.hypot(from.x, from.y);
  const toLength = Math.hypot(to.x, to.y);
  if (fromLength < 1e-8 || toLength < 1e-8) return null;
  const cross = from.x * to.y - from.y * to.x;
  const dot = from.x * to.x + from.y * to.y;
  return Math.atan2(cross, dot);
};

export function captureObservedIntentEvidence(
  snapshot: PerceptionSnapshot,
  actorGid: number,
  previous: ObservedIntentEvidence | null = null,
): ObservedIntentEvidence | null {
  if (!validId(snapshot.observerGid) || !validId(actorGid)) return null;
  if (snapshot.observerGid === actorGid || !validTick(snapshot.tick)) return null;
  const actor = snapshot.players.find((player) => player.gid === actorGid);
  if (
    !actor
    || !finiteVector(actor.pos)
    || !finiteVector(actor.vel)
    || !finiteVector(actor.bodyDir)
    || !validTick(actor.observedTick)
    || !validTick(actor.ageTicks)
    || actor.observedTick + actor.ageTicks !== snapshot.tick
  ) return null;

  if (previous && (
    previous.observerGid !== snapshot.observerGid
    || previous.actorGid !== actorGid
    || previous.observedTick > actor.observedTick
  )) return null;

  const hasNewObservation = previous !== null && previous.observedTick < actor.observedTick;
  const displacementSincePrevious = hasNewObservation
    ? {
        x: actor.pos.x - previous.observedPos.x,
        y: actor.pos.y - previous.observedPos.y,
      }
    : null;
  const velocityChangeSincePrevious = hasNewObservation
    ? {
        x: actor.vel.x - previous.observedVel.x,
        y: actor.vel.y - previous.observedVel.y,
      }
    : null;
  const bodyTurnSincePrevious = hasNewObservation
    ? angleBetween(previous.observedBodyDir, actor.bodyDir)
    : null;

  return {
    observerGid: snapshot.observerGid,
    actorGid,
    observedTick: actor.observedTick,
    observationAgeTicks: actor.ageTicks,
    observedPos: copyVector(actor.pos),
    observedVel: copyVector(actor.vel),
    observedBodyDir: copyVector(actor.bodyDir),
    displacementSincePrevious,
    velocityChangeSincePrevious,
    bodyTurnSincePrevious,
  };
}

const bearingAlignment = (
  vector: Readonly<V2> | null,
  bearing: Readonly<V2>,
): number | null => {
  if (!vector) return null;
  const vectorLength = Math.hypot(vector.x, vector.y);
  const bearingLength = Math.hypot(bearing.x, bearing.y);
  if (vectorLength < 1e-8 || bearingLength < 1e-8) return null;
  const value = (vector.x * bearing.x + vector.y * bearing.y) / (vectorLength * bearingLength);
  return Math.max(-1, Math.min(1, value));
};

export function evaluateObservedIntentHypotheses(
  evidence: ObservedIntentEvidence,
  candidates: readonly IntentCandidateHypothesis[],
): readonly ObservedIntentHypothesisEvidence[] | null {
  if (
    !validId(evidence.observerGid)
    || !validId(evidence.actorGid)
    || evidence.observerGid === evidence.actorGid
    || !validTick(evidence.observedTick)
    || !validTick(evidence.observationAgeTicks)
    || !finiteVector(evidence.observedPos)
    || !finiteVector(evidence.observedVel)
    || !finiteVector(evidence.observedBodyDir)
    || (evidence.displacementSincePrevious !== null
      && !finiteVector(evidence.displacementSincePrevious))
    || (evidence.velocityChangeSincePrevious !== null
      && !finiteVector(evidence.velocityChangeSincePrevious))
    || (evidence.bodyTurnSincePrevious !== null
      && !Number.isFinite(evidence.bodyTurnSincePrevious))
  ) return null;

  const sorted = [...candidates].sort((a, b) => a.id.localeCompare(b.id));
  if (sorted.some((candidate, index) => (
    candidate.id.length === 0
    || !finiteVector(candidate.point)
    || (index > 0 && candidate.id === sorted[index - 1].id)
  ))) return null;

  return sorted.map((candidate) => {
    const bearing = {
      x: candidate.point.x - evidence.observedPos.x,
      y: candidate.point.y - evidence.observedPos.y,
    };
    const bearingLength = Math.hypot(bearing.x, bearing.y);
    return {
      observerGid: evidence.observerGid,
      actorGid: evidence.actorGid,
      candidateId: candidate.id,
      velocityBearingAlignment: bearingAlignment(evidence.observedVel, bearing),
      displacementBearingAlignment: bearingAlignment(evidence.displacementSincePrevious, bearing),
      bodyBearingAlignment: bearingAlignment(evidence.observedBodyDir, bearing),
      observedClosingSpeed: bearingLength < 1e-8
        ? null
        : (evidence.observedVel.x * bearing.x + evidence.observedVel.y * bearing.y) / bearingLength,
      evidenceAgeTicks: evidence.observationAgeTicks,
    };
  });
}
