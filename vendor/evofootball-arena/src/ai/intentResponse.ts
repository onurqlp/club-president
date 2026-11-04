import type {
  IntentCandidateHypothesis,
  ObservedIntentEvidence,
  ObservedIntentHypothesisEvidence,
} from './intentProcess';
import { PLAYER_MIN_DIST } from '../sim/constants';
import type { V2 } from '../utils/vec';

export const INTENT_DISPLACEMENT_SUPPORT = 0.25;
export const INTENT_ALIGNMENT_SUPPORT = 0.50;

export interface ObserverIntentBelief {
  readonly observerGid: number;
  readonly actorGid: number;
  readonly referenceGid: number;
  readonly referenceEpoch: number;
  readonly observedTick: number;
  readonly supportedCandidateIds: readonly string[];
}

export interface ObserverIntentBeliefInput {
  readonly evidence: ObservedIntentEvidence;
  readonly hypotheses: readonly ObservedIntentHypothesisEvidence[];
  readonly referenceGid: number;
  readonly referenceEpoch: number;
  readonly previous: ObserverIntentBelief | null;
}

export type IntentReopeningReason =
  | 'emptySupport'
  | 'currentAdmissible'
  | 'alreadyEvaluated'
  | 'observedOccupancyConflict'
  | 'noAdmissibleReplacement';

export interface IntentReopeningResult {
  readonly observerGid: number;
  readonly actorGid: number;
  readonly referenceGid: number;
  readonly referenceEpoch: number;
  readonly observedTick: number;
  readonly currentCandidateId: string;
  readonly status: 'kept' | 'reopened' | 'unsupported';
  readonly reason: IntentReopeningReason;
  readonly supportedActorCandidateIds: readonly string[];
  readonly conflictedOwnCandidateIds: readonly string[];
  readonly replacement: IntentCandidateHypothesis | null;
}

export interface IntentReopeningInput {
  readonly belief: ObserverIntentBelief;
  readonly actorCandidates: readonly IntentCandidateHypothesis[];
  readonly ownCandidates: readonly IntentCandidateHypothesis[];
  readonly currentCandidateId: string;
  readonly lastRevisionObservedTick: number | null;
}

const finitePoint = (point: Readonly<V2>): boolean =>
  Number.isFinite(point.x) && Number.isFinite(point.y);
const validId = (value: number): boolean => Number.isInteger(value) && value >= 0;
const validTick = (value: number): boolean => Number.isInteger(value) && value >= 0;

const copyBelief = (belief: ObserverIntentBelief): ObserverIntentBelief => ({
  ...belief,
  supportedCandidateIds: [...belief.supportedCandidateIds],
});

export function buildObserverIntentBelief(
  input: ObserverIntentBeliefInput,
): ObserverIntentBelief | null {
  const { evidence, hypotheses, referenceGid, referenceEpoch, previous } = input;
  if (
    !validId(evidence.observerGid)
    || !validId(evidence.actorGid)
    || evidence.observerGid === evidence.actorGid
    || !validTick(evidence.observedTick)
    || !validId(referenceGid)
    || !validTick(referenceEpoch)
  ) return null;
  if (previous && (
    previous.observerGid !== evidence.observerGid
    || previous.actorGid !== evidence.actorGid
    || previous.referenceGid !== referenceGid
    || previous.referenceEpoch !== referenceEpoch
    || previous.observedTick > evidence.observedTick
  )) return null;
  if (previous && previous.observedTick === evidence.observedTick) return copyBelief(previous);

  const ids = new Set<string>();
  for (const hypothesis of hypotheses) {
    if (
      hypothesis.observerGid !== evidence.observerGid
      || hypothesis.actorGid !== evidence.actorGid
      || hypothesis.candidateId.length === 0
      || ids.has(hypothesis.candidateId)
      || (hypothesis.displacementBearingAlignment !== null
        && !Number.isFinite(hypothesis.displacementBearingAlignment))
    ) return null;
    ids.add(hypothesis.candidateId);
  }

  const displacement = evidence.displacementSincePrevious;
  const displacementMagnitude = displacement === null
    ? 0
    : Math.hypot(displacement.x, displacement.y);
  const supportedCandidateIds = displacementMagnitude + 1e-12 < INTENT_DISPLACEMENT_SUPPORT
    ? []
    : hypotheses
      .filter((hypothesis) => (
        hypothesis.displacementBearingAlignment !== null
        && hypothesis.displacementBearingAlignment >= INTENT_ALIGNMENT_SUPPORT
      ))
      .map((hypothesis) => hypothesis.candidateId)
      .sort((left, right) => left.localeCompare(right));

  return {
    observerGid: evidence.observerGid,
    actorGid: evidence.actorGid,
    referenceGid,
    referenceEpoch,
    observedTick: evidence.observedTick,
    supportedCandidateIds,
  };
}

const validateCandidates = (
  candidates: readonly IntentCandidateHypothesis[],
): readonly IntentCandidateHypothesis[] | null => {
  const sorted = [...candidates].sort((left, right) => left.id.localeCompare(right.id));
  if (sorted.some((candidate, index) => (
    candidate.id.length === 0
    || !finitePoint(candidate.point)
    || (index > 0 && candidate.id === sorted[index - 1].id)
  ))) return null;
  return sorted.map((candidate) => ({ id: candidate.id, point: { ...candidate.point } }));
};

const conflicts = (
  own: IntentCandidateHypothesis,
  supportedActor: readonly IntentCandidateHypothesis[],
): boolean => supportedActor.some((actor) => Math.hypot(
  own.point.x - actor.point.x,
  own.point.y - actor.point.y,
) < PLAYER_MIN_DIST - 1e-9);

export function evaluateIntentReopening(
  input: IntentReopeningInput,
): IntentReopeningResult | null {
  const { belief, currentCandidateId, lastRevisionObservedTick } = input;
  if (
    !validId(belief.observerGid)
    || !validId(belief.actorGid)
    || belief.observerGid === belief.actorGid
    || !validId(belief.referenceGid)
    || !validTick(belief.referenceEpoch)
    || !validTick(belief.observedTick)
    || currentCandidateId.length === 0
    || (lastRevisionObservedTick !== null && !validTick(lastRevisionObservedTick))
  ) return null;
  const actorCandidates = validateCandidates(input.actorCandidates);
  const ownCandidates = validateCandidates(input.ownCandidates);
  if (!actorCandidates || !ownCandidates) return null;
  const currentIndex = ownCandidates.findIndex((candidate) => candidate.id === currentCandidateId);
  if (currentIndex < 0) return null;
  const actorById = new Map(actorCandidates.map((candidate) => [candidate.id, candidate]));
  const supportedActor: IntentCandidateHypothesis[] = [];
  const uniqueSupported = [...new Set(belief.supportedCandidateIds)]
    .sort((left, right) => left.localeCompare(right));
  for (const id of uniqueSupported) {
    const candidate = actorById.get(id);
    if (!candidate) return null;
    supportedActor.push(candidate);
  }
  const conflictedOwnCandidateIds = ownCandidates
    .filter((candidate) => conflicts(candidate, supportedActor))
    .map((candidate) => candidate.id);
  const base = {
    observerGid: belief.observerGid,
    actorGid: belief.actorGid,
    referenceGid: belief.referenceGid,
    referenceEpoch: belief.referenceEpoch,
    observedTick: belief.observedTick,
    currentCandidateId,
    supportedActorCandidateIds: uniqueSupported,
    conflictedOwnCandidateIds,
  };

  if (lastRevisionObservedTick !== null && belief.observedTick <= lastRevisionObservedTick) {
    return { ...base, status: 'kept', reason: 'alreadyEvaluated', replacement: null };
  }
  if (supportedActor.length === 0) {
    return { ...base, status: 'kept', reason: 'emptySupport', replacement: null };
  }
  if (!conflictedOwnCandidateIds.includes(currentCandidateId)) {
    return { ...base, status: 'kept', reason: 'currentAdmissible', replacement: null };
  }

  for (let offset = 1; offset < ownCandidates.length; offset++) {
    const candidate = ownCandidates[(currentIndex + offset) % ownCandidates.length];
    if (!conflicts(candidate, supportedActor)) {
      return {
        ...base,
        status: 'reopened',
        reason: 'observedOccupancyConflict',
        replacement: { id: candidate.id, point: { ...candidate.point } },
      };
    }
  }
  return {
    ...base,
    status: 'unsupported',
    reason: 'noAdmissibleReplacement',
    replacement: null,
  };
}
