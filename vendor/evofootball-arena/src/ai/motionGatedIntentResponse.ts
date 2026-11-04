import {
  INTENT_ALIGNMENT_SUPPORT,
  evaluateIntentReopening,
  type IntentReopeningResult,
  type ObserverIntentBelief,
} from './intentResponse';
import type { IntentCandidateHypothesis } from './intentProcess';
import {
  evaluateTemporalMotionEvidence,
  type ObservedMotionHistory,
  type ObservedMotionSample,
} from './motionEvidence';
import type { V2 } from '../utils/vec';

// D-PROC-1G frozen support thresholds. The net-displacement and braking-delta
// values are D-PROC-1MG's frozen motion-phase separation boundaries; the
// alignment reuses D-PROC-1's frozen alignment applied to the newest history
// step. Nothing here loosens D-PROC-1's single-observation 0.25m trigger — it
// is replaced wholesale by the qualified three-sample predicate below.
export const MOTION_NET_DISPLACEMENT_SUPPORT = 0.50;
export const MOTION_BRAKING_DELTA_BOUNDARY = -0.10;
export const MOTION_ALIGNMENT_SUPPORT = INTENT_ALIGNMENT_SUPPORT;

export interface MotionGatedBeliefInput {
  readonly history: ObservedMotionHistory;
  readonly actorCandidates: readonly IntentCandidateHypothesis[];
  readonly referenceGid: number;
  readonly referenceEpoch: number;
  readonly previous: ObserverIntentBelief | null;
}

export interface MotionGatedReopeningInput {
  readonly history: ObservedMotionHistory;
  readonly actorCandidates: readonly IntentCandidateHypothesis[];
  readonly ownCandidates: readonly IntentCandidateHypothesis[];
  readonly currentCandidateId: string;
  readonly lastRevisionObservedTick: number | null;
  readonly referenceGid: number;
  readonly referenceEpoch: number;
  readonly previousBelief: ObserverIntentBelief | null;
}

export interface MotionGatedReopeningResult {
  readonly belief: ObserverIntentBelief;
  readonly reopening: IntentReopeningResult;
}

const validId = (value: number): boolean => Number.isInteger(value) && value >= 0;
const validTick = (value: number): boolean => Number.isInteger(value) && value >= 0;
const finiteVector = (value: Readonly<V2>): boolean =>
  Number.isFinite(value.x) && Number.isFinite(value.y);

const validSample = (sample: ObservedMotionSample): boolean =>
  validId(sample.observerGid)
  && validId(sample.actorGid)
  && sample.observerGid !== sample.actorGid
  && validTick(sample.observedTick)
  && validTick(sample.observationAgeTicks)
  && finiteVector(sample.pos)
  && finiteVector(sample.vel)
  && finiteVector(sample.bodyDir);

const copyBelief = (belief: ObserverIntentBelief): ObserverIntentBelief => ({
  ...belief,
  supportedCandidateIds: [...belief.supportedCandidateIds],
});

// Clamped cosine alignment, identical to intentProcess.bearingAlignment.
const bearingAlignment = (vector: Readonly<V2>, bearing: Readonly<V2>): number | null => {
  const vectorLength = Math.hypot(vector.x, vector.y);
  const bearingLength = Math.hypot(bearing.x, bearing.y);
  if (vectorLength < 1e-8 || bearingLength < 1e-8) return null;
  const value = (vector.x * bearing.x + vector.y * bearing.y) / (vectorLength * bearingLength);
  return Math.max(-1, Math.min(1, value));
};

const validateActorCandidates = (
  candidates: readonly IntentCandidateHypothesis[],
): readonly IntentCandidateHypothesis[] | null => {
  const sorted = [...candidates].sort((left, right) => left.id.localeCompare(right.id));
  if (sorted.some((candidate, index) => (
    candidate.id.length === 0
    || !finiteVector(candidate.point)
    || (index > 0 && candidate.id === sorted[index - 1].id)
  ))) return null;
  return sorted.map((candidate) => ({ id: candidate.id, point: { ...candidate.point } }));
};

/**
 * D-PROC-1G motion-gated support (dormant; no production caller).
 * Authority: docs/world-model/MOTION-GATED-INTENT-REOPENING.md
 *
 * Derives the observer's set-valued belief support from a qualified
 * three-sample observed-motion history instead of D-PROC-1's single 0.25m
 * displacement observation. The container's identity/reference fields and every
 * sample are validated (invalid → null, a schema failure); a history shorter
 * than three samples is legal and yields empty support (never a response). A
 * candidate is supported only when all hold:
 *   - the history has three strictly-newer samples;
 *   - net observed displacement across the history >= 0.50m;
 *   - the minimum inter-sample speed delta > -0.10m/s (braking is not support);
 *   - alignment(candidate, newest inter-sample displacement bearing) >= 0.50.
 * The result is an unchanged ObserverIntentBelief, ready for the unchanged
 * reopening query. It reads no private target, action, truth, RNG or body.
 */
export function buildMotionGatedBelief(
  input: MotionGatedBeliefInput,
): ObserverIntentBelief | null {
  const { history, actorCandidates, referenceGid, referenceEpoch, previous } = input;
  if (
    !validId(history.observerGid)
    || !validId(history.actorGid)
    || history.observerGid === history.actorGid
    || !validId(referenceGid)
    || !validTick(referenceEpoch)
    || history.referenceGid !== referenceGid
    || history.referenceEpoch !== referenceEpoch
    || history.samples.length === 0
    || history.samples.length > 3
  ) return null;
  for (let index = 0; index < history.samples.length; index++) {
    const sample = history.samples[index];
    if (
      !validSample(sample)
      || sample.observerGid !== history.observerGid
      || sample.actorGid !== history.actorGid
      || (index > 0 && sample.observedTick <= history.samples[index - 1].observedTick)
    ) return null;
  }
  const candidates = validateActorCandidates(actorCandidates);
  if (!candidates) return null;

  const newest = history.samples[history.samples.length - 1];
  const observedTick = newest.observedTick;
  if (previous && (
    previous.observerGid !== history.observerGid
    || previous.actorGid !== history.actorGid
    || previous.referenceGid !== referenceGid
    || previous.referenceEpoch !== referenceEpoch
    || previous.observedTick > observedTick
  )) return null;
  if (previous && previous.observedTick === observedTick) return copyBelief(previous);

  let supportedCandidateIds: readonly string[] = [];
  if (history.samples.length === 3) {
    const evidence = evaluateTemporalMotionEvidence(history);
    if (!evidence) return null;
    const netDisplacement = Math.hypot(
      evidence.firstDisplacement.x + evidence.secondDisplacement.x,
      evidence.firstDisplacement.y + evidence.secondDisplacement.y,
    );
    const minimumSpeedDelta = Math.min(evidence.firstSpeedDelta, evidence.secondSpeedDelta);
    const activeContinuation = netDisplacement + 1e-12 >= MOTION_NET_DISPLACEMENT_SUPPORT
      && minimumSpeedDelta > MOTION_BRAKING_DELTA_BOUNDARY;
    if (activeContinuation) {
      const newestDisplacement = evidence.secondDisplacement;
      supportedCandidateIds = candidates
        .filter((candidate) => {
          const alignment = bearingAlignment(newestDisplacement, {
            x: candidate.point.x - newest.pos.x,
            y: candidate.point.y - newest.pos.y,
          });
          return alignment !== null && alignment >= MOTION_ALIGNMENT_SUPPORT;
        })
        .map((candidate) => candidate.id)
        .sort((left, right) => left.localeCompare(right));
    }
  }

  return {
    observerGid: history.observerGid,
    actorGid: history.actorGid,
    referenceGid,
    referenceEpoch,
    observedTick,
    supportedCandidateIds,
  };
}

/**
 * Composes the motion-gated support belief above with D-PROC-1's UNCHANGED
 * physical-occupancy admissibility + cyclic reopening query. Returns null on
 * any schema failure in either stage.
 */
export function evaluateMotionGatedReopening(
  input: MotionGatedReopeningInput,
): MotionGatedReopeningResult | null {
  const belief = buildMotionGatedBelief({
    history: input.history,
    actorCandidates: input.actorCandidates,
    referenceGid: input.referenceGid,
    referenceEpoch: input.referenceEpoch,
    previous: input.previousBelief,
  });
  if (!belief) return null;
  const reopening = evaluateIntentReopening({
    belief,
    actorCandidates: input.actorCandidates,
    ownCandidates: input.ownCandidates,
    currentCandidateId: input.currentCandidateId,
    lastRevisionObservedTick: input.lastRevisionObservedTick,
  });
  if (!reopening) return null;
  return { belief, reopening };
}
