import { BALL_FRICTION_K } from '../sim/constants';
import { clamp, clamp01 } from '../utils/math';
import type { V2 } from '../utils/vec';
import { evaluatePassAffordance, type PassAffordance } from './passAffordance';
import { evaluatePassCorridorInterception } from './passCorridorInterception';
import type { PerceptionSnapshot } from './perceptionSnapshot';
import { predictGroundPass, type GroundPassPrediction } from './prediction';
import type { KnownReachProfile } from './reachability';

/**
 * EDS E0 — dormant pass-option valuation.
 * Authority: docs/world-model/EDS-E0-OPTION-VALUATION.md
 *
 * The one quantity the live evaluator has never contained is TIME. This module
 * prices a pass option — one target at one intended power — in flight time,
 * corridor interception slack and receiver touch difficulty, from the passer's
 * OWN PerceptionSnapshot alone. It is pure and has no production caller: it
 * cannot read Match, truth, RNG, another player's memory, private intent, coach
 * doctrine or familiarity, and it never mutates its inputs.
 *
 * It deliberately does NOT produce a scalar score. S7a refused one on purpose so
 * evolution can price the tradeoff, and S4a found `controlProbability` far too
 * under-dispersed (95.2% of truth samples in its top quartile) to act as one.
 * What comes out is an oriented option set plus a dominance filter.
 */

/** Neutral technique/positioning for the RECEIVER: see §3 of the contract —
 * knowing a particular teammate's first touch is familiarity, which A4 owns. */
export const GENERIC_RECEIVER_TECHNIQUE = 0.5;
export const GENERIC_RECEIVER_POSITIONING = 0.5;

export interface PassOptionValue {
  readonly targetGid: number;
  readonly powerMultiplier: number;
  /** Seconds until the ball reaches the (observed, lead-adjusted) target point. */
  readonly flightSeconds: number;
  /** Ball speed on arrival, from the engine's own friction model. */
  readonly arrivalSpeed: number;
  /** Closing speed the receiver must absorb: ball minus observed receiver motion. */
  readonly receptionRelativeSpeed: number;
  /** opponentArrival − receiverArrival at the target point; higher favours us. */
  readonly arrivalMarginSeconds: number;
  /**
   * The best-placed observed defender's slack along the corridor, in seconds
   * (`ballTime − defenderEta` at its strongest sample). NEGATIVE is safe;
   * positive means someone can be there before the ball. Lower is better.
   */
  readonly interceptionThreatSeconds: number;
  readonly threatDefenderGid: number | null;
  /** Mirrored touchFailChance prior for a GENERIC receiver (never this one). */
  readonly touchFailPrior: number;
  readonly receivePressure: number;
  readonly bodyReadiness: number;
  readonly progressionMetres: number;
  readonly lineBreakCount: number;
  readonly offsideSafe: boolean;
}

export interface PassOptionInput {
  readonly snapshot: PerceptionSnapshot;
  readonly passerGid: number;
  readonly targetGid: number;
  readonly powerMultiplier: number;
  readonly attackDir: 1 | -1;
  readonly reachProfiles: ReadonlyMap<number, KnownReachProfile>;
  /** EDS E1b: price the touch prior with the flagged heavy curve. */
  readonly heavyTouchCost?: boolean;
}

/**
 * Mirror of `mechanics.touchFailChance` (mechanics.ts:95-107), in the same
 * pattern `prediction.ts` mirrors `performPass`: a pure `ai/` module may not
 * import the sim's mechanics, so the curve is restated here and pinned to the
 * real function by a contract test. If the real curve moves — as EDS E1 will
 * move it — this mirror and that test move with it, together.
 */
export function mirroredTouchFailChance(
  speed: number, pressure: number, misalign: number,
  technique = GENERIC_RECEIVER_TECHNIQUE, positioning = GENERIC_RECEIVER_POSITIONING,
  heavyTouchCost = false,
): number {
  const aware = 1 - (positioning - 0.5) * 0.6;
  // EDS E1b: mirrors `TOUCH_SPEED_COST`. Restated rather than imported for the
  // same reason the rest of the curve is — the contract test pins them equal.
  const span = heavyTouchCost ? 16 : 8;
  const weight = heavyTouchCost ? 0.24 : 0.07;
  const raw = 0.01 + clamp01((speed - 6) / span) * weight
    + (pressure * 0.1 + misalign * 0.05) * aware;
  return clamp(raw * (1.3 - technique * 0.85), 0, 0.4);
}

/** Ball speed after `seconds` of the engine's exponential ground friction. */
export function groundBallSpeedAt(launchSpeed: number, seconds: number): number {
  if (!Number.isFinite(seconds) || seconds < 0) return 0;
  return launchSpeed * Math.exp(-BALL_FRICTION_K * seconds);
}

const finite = (...values: number[]): boolean => values.every(Number.isFinite);

/** Where the flight is pointing when it gets there (straight ground pass). */
const flightDirection = (from: Readonly<V2>, flight: GroundPassPrediction): V2 | null => {
  const dx = flight.targetPoint.x - from.x;
  const dy = flight.targetPoint.y - from.y;
  const length = Math.hypot(dx, dy);
  if (length < 1e-8) return null;
  return { x: dx / length, y: dy / length };
};

/**
 * Value ONE option (target × intended power) from observed facts. Returns null
 * when the snapshot cannot support the question — a missing body, an unreachable
 * flight, a degenerate geometry — never a guess.
 */
export function evaluatePassOption(input: PassOptionInput): PassOptionValue | null {
  const {
    snapshot, passerGid, targetGid, powerMultiplier, attackDir, reachProfiles,
  } = input;
  const passer = snapshot.players.find((entry) => entry.gid === passerGid);
  const target = snapshot.players.find((entry) => entry.gid === targetGid);
  if (!passer || !target || passerGid === targetGid) return null;

  const affordanceResult = evaluatePassAffordance({
    snapshot, passerGid, targetGid, attackDir, reachProfiles, powerMultiplier,
  });
  if (!affordanceResult) return null;
  const affordance: PassAffordance = affordanceResult.affordance;
  const flight = affordanceResult.flight;
  if (!flight.reachable) return null;

  const direction = flightDirection(passer.pos, flight);
  if (!direction) return null;
  const arrivalSpeed = groundBallSpeedAt(flight.launchSpeed, flight.arrivalTime);
  // What the receiver has to absorb: the ball's arrival velocity minus their own
  // observed motion. Running onto a pass genuinely discounts it.
  const relativeX = direction.x * arrivalSpeed - target.vel.x;
  const relativeY = direction.y * arrivalSpeed - target.vel.y;
  const receptionRelativeSpeed = Math.hypot(relativeX, relativeY);
  // Blind-side term, same convention as attemptFirstTouch: a ball arriving at
  // the observed body facing is 0, from behind the body 1.
  const bodyLength = Math.hypot(target.bodyDir.x, target.bodyDir.y);
  const misalign = bodyLength < 1e-8
    ? 0.5
    : clamp01((1 + (
      (relativeX / Math.max(receptionRelativeSpeed, 1e-8)) * (target.bodyDir.x / bodyLength)
      + (relativeY / Math.max(receptionRelativeSpeed, 1e-8)) * (target.bodyDir.y / bodyLength)
    )) / 2);
  const touchFailPrior = mirroredTouchFailChance(
    receptionRelativeSpeed, affordance.receivePressure, misalign,
    GENERIC_RECEIVER_TECHNIQUE, GENERIC_RECEIVER_POSITIONING, input.heavyTouchCost ?? false,
  );

  // The corridor read, per OBSERVED opponent: keep the worst (largest) slack.
  let interceptionThreatSeconds = Number.NEGATIVE_INFINITY;
  let threatDefenderGid: number | null = null;
  for (const entry of snapshot.players) {
    if (entry.side === passer.side) continue;
    const corridor = evaluatePassCorridorInterception({
      snapshot, passerGid, targetGid, defenderGid: entry.gid, reachProfiles, powerMultiplier,
    });
    if (!corridor) continue;
    if (corridor.strongestMargin > interceptionThreatSeconds) {
      interceptionThreatSeconds = corridor.strongestMargin;
      threatDefenderGid = entry.gid;
    }
  }
  if (threatDefenderGid === null) interceptionThreatSeconds = Number.NEGATIVE_INFINITY;

  if (!finite(
    flight.arrivalTime, arrivalSpeed, receptionRelativeSpeed, touchFailPrior,
    affordance.arrivalMargin, affordance.receivePressure, affordance.bodyReadiness,
    affordance.progressionMetres,
  )) return null;

  return {
    targetGid,
    powerMultiplier,
    flightSeconds: flight.arrivalTime,
    arrivalSpeed,
    receptionRelativeSpeed,
    arrivalMarginSeconds: affordance.arrivalMargin,
    interceptionThreatSeconds,
    threatDefenderGid,
    touchFailPrior,
    receivePressure: affordance.receivePressure,
    bodyReadiness: affordance.bodyReadiness,
    progressionMetres: affordance.progressionMetres,
    lineBreakCount: affordance.lineBreakCount,
    offsideSafe: affordance.offsideMargin <= 0,
  };
}

/** The oriented dimensions of an option, and which way is better. */
export const PASS_OPTION_DIMENSIONS = [
  'arrivalMarginSeconds', // higher better
  'interceptionThreatSeconds', // LOWER better
  'touchFailPrior', // lower better
  'progressionMetres', // higher better
  'lineBreakCount', // higher better
] as const satisfies readonly (keyof PassOptionValue)[];

const HIGHER_IS_BETTER: Readonly<Record<(typeof PASS_OPTION_DIMENSIONS)[number], boolean>> = {
  arrivalMarginSeconds: true,
  interceptionThreatSeconds: false,
  touchFailPrior: false,
  progressionMetres: true,
  lineBreakCount: true,
};

/** True when `left` is no worse in every dimension and better in at least one. */
export function passOptionDominates(left: PassOptionValue, right: PassOptionValue): boolean {
  let strictlyBetter = false;
  for (const dimension of PASS_OPTION_DIMENSIONS) {
    const a = left[dimension] as number;
    const b = right[dimension] as number;
    const better = HIGHER_IS_BETTER[dimension] ? a > b : a < b;
    const worse = HIGHER_IS_BETTER[dimension] ? a < b : a > b;
    if (worse) return false;
    if (better) strictlyBetter = true;
  }
  return strictlyBetter;
}

/**
 * Drop options another option beats on every dimension. What survives is a real
 * tradeoff set — safe-and-slow against fast-and-hot — for a chooser (later, and
 * ultimately evolution) to price. No aggregation happens here.
 */
export function passOptionFrontier(
  options: readonly PassOptionValue[],
): readonly PassOptionValue[] {
  return options.filter((candidate) =>
    !options.some((other) => other !== candidate && passOptionDominates(other, candidate)));
}
