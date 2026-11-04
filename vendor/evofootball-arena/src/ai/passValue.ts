import type { PassAffordanceResult } from './passAffordance';

/** S7 pass lookahead dimensions, all oriented so larger is better. */
export interface PassNextStateValue {
  readonly targetGid: number;
  readonly arrivalMarginSeconds: number;
  /** Zero when on time; increasingly negative when the receiver arrives late. */
  readonly receiverTiming: number;
  readonly pressureRelief: number;
  readonly bodyReadiness: number;
  readonly progressionMetres: number;
  readonly lineBreakCount: number;
  readonly offsideSafety: number;
  readonly exitOptionCount: number;
}

export const PASS_NEXT_STATE_DIMENSIONS = [
  'arrivalMarginSeconds',
  'receiverTiming',
  'pressureRelief',
  'bodyReadiness',
  'progressionMetres',
  'lineBreakCount',
  'offsideSafety',
  'exitOptionCount',
] as const satisfies readonly (Exclude<keyof PassNextStateValue, 'targetGid'>)[];

export type PassNextStateDimension = (typeof PASS_NEXT_STATE_DIMENSIONS)[number];
export type PassValueRelation = 'leftDominates' | 'rightDominates' | 'equivalent' | 'tradeoff';
export type PassValueTolerance = Readonly<Partial<Record<PassNextStateDimension, number>>>;

/** Measurement resolution only, never a tactical preference or utility weight. */
export const DEFAULT_PASS_VALUE_TOLERANCE: Readonly<Record<PassNextStateDimension, number>> = {
  arrivalMarginSeconds: 0.05,
  receiverTiming: 0.05,
  pressureRelief: 0.03,
  bodyReadiness: 0.03,
  progressionMetres: 0.5,
  lineBreakCount: 0,
  offsideSafety: 0.03,
  exitOptionCount: 0,
};

/**
 * Convert the predicted arrival into one next-state vector.
 *
 * The under-dispersed provisional controlProbability is deliberately excluded.
 * An unreachable intended flight is not a viable next state.
 */
export function passNextStateValue(result: PassAffordanceResult): PassNextStateValue | null {
  const { flight, affordance } = result;
  if (!flight.reachable || !Number.isFinite(affordance.arrivalMargin)) return null;
  return {
    targetGid: affordance.targetGid,
    arrivalMarginSeconds: affordance.arrivalMargin,
    receiverTiming: -Math.max(0, affordance.receiverArrival - affordance.ballArrival),
    pressureRelief: 1 - affordance.receivePressure,
    bodyReadiness: affordance.bodyReadiness,
    progressionMetres: affordance.progressionMetres,
    lineBreakCount: affordance.lineBreakCount,
    offsideSafety: 1 - affordance.offsideRisk,
    exitOptionCount: affordance.exitOptionCount,
  };
}

export function comparePassNextStates(
  left: PassNextStateValue,
  right: PassNextStateValue,
  tolerance: PassValueTolerance = DEFAULT_PASS_VALUE_TOLERANCE,
): PassValueRelation {
  let leftStrict = false;
  let rightStrict = false;
  let leftNoWorse = true;
  let rightNoWorse = true;

  for (const dimension of PASS_NEXT_STATE_DIMENSIONS) {
    const epsilon = Math.max(0, tolerance[dimension] ?? 0);
    const delta = left[dimension] - right[dimension];
    if (delta < -epsilon) leftNoWorse = false;
    if (delta > epsilon) rightNoWorse = false;
    if (delta > epsilon) leftStrict = true;
    if (delta < -epsilon) rightStrict = true;
  }

  if (leftNoWorse && leftStrict) return 'leftDominates';
  if (rightNoWorse && rightStrict) return 'rightDominates';
  if (!leftStrict && !rightStrict) return 'equivalent';
  return 'tradeoff';
}

/** Stable Pareto frontier: input order and values are never mutated. */
export function passParetoFrontier(
  values: readonly PassNextStateValue[],
  tolerance: PassValueTolerance = DEFAULT_PASS_VALUE_TOLERANCE,
): PassNextStateValue[] {
  return values.filter((candidate, candidateIndex) => !values.some((other, otherIndex) =>
    candidateIndex !== otherIndex
    && comparePassNextStates(other, candidate, tolerance) === 'leftDominates'));
}
