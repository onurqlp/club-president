import {
  evaluatePassCorridorInterception,
  type PassCorridorInterceptionFacts,
} from './passCorridorInterception';
import type { KnownReachProfile } from './reachability';
import type { PerceptionSnapshot } from './perceptionSnapshot';

export const KICK_TRANSITION_CORRIDOR_FEATURE_VERSION =
  'kick-transition-corridor-features-v1' as const;

export const KICK_TRANSITION_CORRIDOR_FEATURE_DIMENSIONS = [
  'corridorStrongestMargin',
  'corridorStrongestBallTime',
  'corridorStrongestDefenderEta',
  'corridorStrongestPathFraction',
  'corridorFeasibleDefenderCount',
] as const;

export type KickTransitionCorridorFeatureDimension =
  (typeof KICK_TRANSITION_CORRIDOR_FEATURE_DIMENSIONS)[number];

export type KickTransitionCorridorFeaturesV1 = Readonly<
  Record<KickTransitionCorridorFeatureDimension, number>
>;

export interface ProjectedKickTransitionCorridorFeaturesV1 {
  readonly version: typeof KICK_TRANSITION_CORRIDOR_FEATURE_VERSION;
  readonly features: KickTransitionCorridorFeaturesV1;
  readonly strongestDefenderGid: number;
  readonly supportedDefenderCount: number;
}

export interface KickTransitionCorridorFeatureInput {
  readonly snapshot: PerceptionSnapshot;
  readonly passerGid: number;
  readonly targetGid: number;
  readonly defenderGids: readonly number[];
  readonly reachProfiles: ReadonlyMap<number, KnownReachProfile>;
  readonly powerMultiplier?: number;
}

/**
 * Pure observer-grounded pathwise summary for the transition-estimator probe.
 * Defender identities are stable roster facts supplied by the caller; all
 * kinematics come only from the observer snapshot.
 */
export function projectKickTransitionCorridorFeaturesV1(
  input: KickTransitionCorridorFeatureInput,
): ProjectedKickTransitionCorridorFeaturesV1 | null {
  const facts: PassCorridorInterceptionFacts[] = [];
  for (const defenderGid of [...input.defenderGids].sort((a, b) => a - b)) {
    const value = evaluatePassCorridorInterception({
      snapshot: input.snapshot,
      passerGid: input.passerGid,
      targetGid: input.targetGid,
      defenderGid,
      reachProfiles: input.reachProfiles,
      powerMultiplier: input.powerMultiplier,
    });
    if (value !== null) facts.push(value);
  }
  if (facts.length === 0) return null;
  facts.sort((left, right) =>
    right.strongestMargin - left.strongestMargin
    || left.defenderGid - right.defenderGid);
  const strongest = facts[0];
  const features: KickTransitionCorridorFeaturesV1 = {
    corridorStrongestMargin: strongest.strongestMargin,
    corridorStrongestBallTime: strongest.strongestBallTime,
    corridorStrongestDefenderEta: strongest.strongestDefenderEta,
    corridorStrongestPathFraction: strongest.strongestPathFraction,
    corridorFeasibleDefenderCount: facts.filter((value) => value.strongestMargin >= 0).length,
  };
  if (!KICK_TRANSITION_CORRIDOR_FEATURE_DIMENSIONS.every((dimension) =>
    Number.isFinite(features[dimension]))) return null;
  return {
    version: KICK_TRANSITION_CORRIDOR_FEATURE_VERSION,
    features,
    strongestDefenderGid: strongest.defenderGid,
    supportedDefenderCount: facts.length,
  };
}
