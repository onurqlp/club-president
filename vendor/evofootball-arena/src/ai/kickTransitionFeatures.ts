import type { PassAffordanceResult } from './passAffordance';

export const KICK_TRANSITION_FEATURE_VERSION = 'kick-transition-features-v1' as const;

export const KICK_TRANSITION_FEATURE_DIMENSIONS = [
  'flightDistance',
  'launchSpeed',
  'ballArrival',
  'receiverArrival',
  'opponentArrival',
  'arrivalMargin',
  'receivePressure',
  'bodyReadiness',
  'progressionMetres',
  'lineBreakCount',
  'offsideMargin',
  'exitOptionCount',
  'targetObservationAgeTicks',
  'observedOpponentCount',
] as const;

export type KickTransitionFeatureDimension =
  (typeof KICK_TRANSITION_FEATURE_DIMENSIONS)[number];

export type KickTransitionFeaturesV1 = Readonly<
  Record<KickTransitionFeatureDimension, number>
>;

export interface ProjectedKickTransitionFeaturesV1 {
  readonly version: typeof KICK_TRANSITION_FEATURE_VERSION;
  readonly features: KickTransitionFeaturesV1;
}

/**
 * Pure kick-time projection for the offline transition-estimator programme.
 *
 * Every fact is already present in the observer-computable S4/S5 pass
 * affordance. The provisional aggregate control prior and derived offside risk
 * are deliberately excluded. A non-finite fact makes the action unsupported;
 * no sentinel or future Match truth is substituted.
 */
export function projectKickTransitionFeaturesV1(
  result: PassAffordanceResult,
): ProjectedKickTransitionFeaturesV1 | null {
  const { flight, affordance } = result;
  const features: KickTransitionFeaturesV1 = {
    flightDistance: flight.distance,
    launchSpeed: flight.launchSpeed,
    ballArrival: affordance.ballArrival,
    receiverArrival: affordance.receiverArrival,
    opponentArrival: affordance.opponentArrival,
    arrivalMargin: affordance.arrivalMargin,
    receivePressure: affordance.receivePressure,
    bodyReadiness: affordance.bodyReadiness,
    progressionMetres: affordance.progressionMetres,
    lineBreakCount: affordance.lineBreakCount,
    offsideMargin: affordance.offsideMargin,
    exitOptionCount: affordance.exitOptionCount,
    targetObservationAgeTicks: affordance.targetObservationAgeTicks,
    observedOpponentCount: affordance.observedOpponentCount,
  };
  if (!KICK_TRANSITION_FEATURE_DIMENSIONS.every((dimension) =>
    Number.isFinite(features[dimension]))) return null;
  return { version: KICK_TRANSITION_FEATURE_VERSION, features };
}
