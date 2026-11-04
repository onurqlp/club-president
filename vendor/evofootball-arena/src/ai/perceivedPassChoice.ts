/**
 * EDS E3 — the perceived pass CHOICE, as a live consumer.
 * Authority: docs/world-model/EDS-E3-COEVOLUTION-AUDIT.md §2.1
 *
 * Everything the slice measured before this file ran dormant: E2b-1R priced real
 * decision moments inside a probe and forced the winner through
 * `forcedPassTarget`. Nothing had ever CHOSEN a pass inside a live match. This
 * module is that chooser, lifted out of the probe unchanged in substance so the
 * live path and the validated path are the same arithmetic:
 *
 *   READ         target and lane both in the passer's current percept
 *                → E2b-0's measured exchange rate (threat quintile → probability)
 *   SEEN-UNREAD  the man is perceived, the lane is not readable
 *                → E2a-2's option-space band prior at the PERCEIVED distance
 *   UNSEEN       no percept of the man at all
 *                → the option-space marginal; priced always, never executable
 *                  (ruling #8 (l): a man you cannot aim at cannot be kicked to)
 *
 * One measured probability axis, no hand-set weight anywhere: every number comes
 * out of `passPrior.ts`, which is committed census DATA.
 *
 * Two deliberate faithfulness notes, both pinned by the E3 probe's X4 gate:
 *
 * 1. The READ price here reads `THREAT_CALIBRATION[q].realizedSuccess` — the
 *    banked composite — where E2b-1R's probe multiplied its two re-derived
 *    factors (`reached × cleanGivenReached`). E2b-1R's X5 asserted those agree
 *    to <1e-12, and X4 asserts the substitution changes no choice.
 * 2. The candidate WINDOW (6–30 m, E0's censused window — the only range any of
 *    these priors was measured over) is measured on true positions, exactly as
 *    the probe enumerated it. The window decides which options exist; the
 *    PRICE and the executable rule are perceived. Registered as a v1 boundary
 *    beside ruling #11.3's aiming registration.
 */
import {
  ATTEMPT_VALUE_MARGINAL, attemptValueAt, OPTION_SPACE_PRIOR_MARGINAL,
  optionSpacePriorAt, THREAT_CALIBRATION, valueZoneIndex,
} from './passPrior';
import { evaluatePassOption } from './passOptionValue';
import { frontContactOf } from './frontContact';
import type { PerceptionSnapshot } from './perceptionSnapshot';
import type { KnownReachProfile } from './reachability';

/** E0's candidate window, and the range every prior in `passPrior.ts` covers. */
export const PASS_CHOICE_MIN_METRES = 6;
export const PASS_CHOICE_MAX_METRES = 30;

export type PassInfoClass = 'READ' | 'SEEN-UNREAD' | 'UNSEEN';

export interface PricedPassOption {
  readonly targetGid: number;
  readonly infoClass: PassInfoClass;
  /**
   * E5g (ruling #23.3): the two inputs the value axis prices this option BY,
   * carried on the option so a diagnostic can say WHICH input moved instead of
   * re-deriving them from outside and hoping the derivation matches.
   *
   * `cell` is the destination zone of the PERCEIVED position; `band` is the
   * passer's own corridor read, or −1 where he has none and the frozen ladder
   * takes over. Both are reported for an unseen man too, as −1: he has no known
   * destination, which is exactly why the marginal prices him.
   *
   * Pure observation. Nothing reads these to make a choice.
   */
  readonly cell: number;
  readonly band: number;
  /**
   * The option's measured price.
   *
   * Without the value axis: the probability the intended man ends up in clean
   * control — the E3R price, bit for bit.
   *
   * With it (E5d Phase 1, ruling #18.4): ONE measured quantity, EV̂ = P(the
   * passing team shoots within 4.0 s | this pass is ATTEMPTED, destination cell
   * × threat band). The composition is REMOVED, not re-weighted — E5c proved
   * `P̂(clean) × V̂(·|clean)` inverts the true ordering on balls whose value
   * flows through messy paths, and attempt-conditioning prices those paths
   * instead of assuming them away.
   */
  readonly price: number;
  /**
   * The reception probability. Under the value axis this is NO LONGER IN THE
   * PRICE — it survives as a reported diagnostic, the record of what was
   * removed.
   */
  readonly reception: number;
  /** EV̂ when the axis is armed; 1 when it is off, where `price = reception`. */
  readonly value: number;
  readonly executable: boolean;
  /** PERCEIVED distance; NaN for UNSEEN — he does not know, and it must not read as 0. */
  readonly distance: number;
}

export interface PerceivedPassChoice {
  readonly targetGid: number;
  readonly price: number;
  /** The winning option's two halves; `value` is 1 when the axis is off. */
  readonly reception: number;
  readonly value: number;
  readonly infoClass: PassInfoClass;
  readonly distance: number;
  readonly options: readonly PricedPassOption[];
  /** Look-pressure, read axis: a blind option out-prices every executable one. */
  readonly blindOutpricesRead: boolean;
  /** Look-pressure, band axis: it also beats the best executable BAND price. */
  readonly blindOutpricesBand: boolean;
}

export interface PerceivedPassChoiceInput {
  readonly snapshot: PerceptionSnapshot;
  readonly passerGid: number;
  /** In window order, as the roster iterates — ties resolve by lower gid anyway. */
  readonly candidateGids: readonly number[];
  readonly attackDir: 1 | -1;
  readonly reachProfiles: ReadonlyMap<number, KnownReachProfile>;
  /** E5 (ruling #15.3): compose measured value into the price. Default off. */
  readonly valueAxis?: boolean;
  /**
   * ⭐⭐ LN T0 (M-LN.3(c2); ruling #393 item 5(iii)): the OWN-LANE FACTOR, per EXECUTABLE
   * option. `undefined` — the only production value — leaves the priced option list, the
   * argmax and every returned field byte-identical: the mapping below does not run at all.
   * Supplied (only by the armed `lnOwnLanePrice` seat in `PlayerBrain.decideCarrier`), it
   * returns `1 − w · (1 − ownLaneOpenness(passer's perceived pos, target's perceived pos,
   * own perceived bodies))` and each executable option's `price` is multiplied by it BEFORE
   * the reduce — the argmax compares `price`, so the read must land there. ⚠ A score-unit
   * weight multiplying a MEASURED PROBABILITY is the seam's DECLARED CURRENCY MIX
   * (LN-OWN-LANE-CONTRACT.md §4). The returned `options` — and therefore `passChoiceTrace`'s
   * stored `options[].price` and the winner's `price` — record the PRICED value.
   */
  readonly ownLaneFactor?: (targetGid: number) => number;
  /**
   * ⭐⭐⭐ OP T0b (M-OP.5; ruling #435 item 3): THE FRONT-CONTACT SEAT. Absent or false — every
   * production value but the armed door's — leaves every priced option byte-identical. TRUE
   * (only from the one chooser call site, behind the dormant `opFrontChooser` door) is handed
   * to `pricePassOption`, which prices a READ option with front contact in the LAST band.
   */
  readonly frontContact?: boolean;
}

const distanceBetween = (
  left: Readonly<{ x: number; y: number }>, right: Readonly<{ x: number; y: number }>,
): number => Math.hypot(left.x - right.x, left.y - right.y);

/**
 * E2b-0's curve as a price: which quintile of predicted corridor threat this
 * option falls in, and what share of THOSE options historically ended with the
 * intended man in clean control. The last quintile catches everything above it.
 */
export function threatQuintilePrice(threatSeconds: number): number {
  for (const row of THREAT_CALIBRATION) if (threatSeconds <= row.keyTo) return row.realizedSuccess;
  return THREAT_CALIBRATION[THREAT_CALIBRATION.length - 1].realizedSuccess;
}

/**
 * E5d: which threat quintile the corridor read falls in — the same partition
 * `threatQuintilePrice` uses, returned as an index so the attempt table can be
 * keyed by it. Kept beside its twin so the two can never drift.
 */
export function threatBandIndex(threatSeconds: number): number {
  for (let index = 0; index < THREAT_CALIBRATION.length; index++) {
    if (threatSeconds <= THREAT_CALIBRATION[index].keyTo) return index;
  }
  return THREAT_CALIBRATION.length - 1;
}

/** The window is a truth-measured scope (see the header note), never a price. */
export function passChoiceCandidateGids(
  passer: Readonly<{ gid: number; pos: Readonly<{ x: number; y: number }> }>,
  teammates: readonly Readonly<{
    gid: number; pos: Readonly<{ x: number; y: number }>; role: string; sentOff: boolean;
  }>[],
): number[] {
  const gids: number[] = [];
  for (const mate of teammates) {
    if (mate.gid === passer.gid || mate.sentOff || mate.role === 'GK') continue;
    const d = distanceBetween(mate.pos, passer.pos);
    if (d < PASS_CHOICE_MIN_METRES || d > PASS_CHOICE_MAX_METRES) continue;
    gids.push(mate.gid);
  }
  return gids;
}

/**
 * Price ONE candidate on the single measured axis. The information class decides
 * WHICH census answers, and nothing here is weighted by hand.
 */
export function pricePassOption(input: {
  readonly snapshot: PerceptionSnapshot;
  readonly passerGid: number;
  readonly targetGid: number;
  readonly attackDir: 1 | -1;
  readonly reachProfiles: ReadonlyMap<number, KnownReachProfile>;
  /** E5: compose the measured value half. Off ⇒ the E3R price, bit for bit. */
  readonly valueAxis?: boolean;
  /** OP T0b (M-OP.5): price a READ option with front contact in the LAST band. Absent ⇒ shipped. */
  readonly frontContact?: boolean;
}): PricedPassOption {
  const { snapshot, passerGid, targetGid, attackDir, reachProfiles } = input;
  const valueAxis = input.valueAxis ?? false;
  const seenTarget = snapshot.players.find((entry) => entry.gid === targetGid);
  const seenPasser = snapshot.players.find((entry) => entry.gid === passerGid);
  if (!seenTarget || !seenPasser) {
    const row = OPTION_SPACE_PRIOR_MARGINAL;
    const reception = row.reachedRate * row.cleanGivenReached;
    // A man he cannot see is a man whose ZONE he cannot know either, so the
    // attempt axis takes its marginal exactly as the reception prior does.
    const value = valueAxis ? ATTEMPT_VALUE_MARGINAL.shotRate : 1;
    return {
      targetGid,
      infoClass: 'UNSEEN',
      cell: -1,
      band: -1,
      price: valueAxis ? value : reception,
      reception,
      value,
      executable: false,
      distance: Number.NaN,
    };
  }
  const distance = distanceBetween(seenPasser.pos, seenTarget.pos);
  // The destination cell reads the PERCEIVED position: the table was measured on
  // true positions and is read with what this body knows, the same arrangement
  // the distance band has had since E2a-2.
  const cell = valueZoneIndex(seenTarget.pos.x * attackDir, seenTarget.pos.y);
  const read = evaluatePassOption({
    snapshot, passerGid, targetGid, powerMultiplier: 1, attackDir, reachProfiles,
  });
  if (read === null) {
    const row = optionSpacePriorAt(distance);
    const reception = row.reachedRate * row.cleanGivenReached;
    // No corridor read means no band; the frozen ladder takes it to the cell
    // rung rather than inventing a band for it.
    const value = valueAxis ? attemptValueAt(cell, -1) : 1;
    return {
      targetGid,
      infoClass: 'SEEN-UNREAD',
      cell,
      band: -1,
      price: valueAxis ? value : reception,
      reception,
      value,
      executable: true,
      distance,
    };
  }
  // OP T0b §SEAT (M-OP.5, ruling #435 item 3(b)) — THE CHOOSER SEES THE MAN IN FRONT. A man the
  // ball must pass through in its first metres earns a time margin of about +0.011 s (his ETA is
  // only his turn), so the read prices his lane open. Armed, an option with front contact is
  // priced as the calibration's WORST band: the threat used for reception and band is +Infinity,
  // so both partitions return their own LAST row. The read object is NOT touched; door shut ⇒
  // `frontSeat` is false without a call and every line below is the shipped one.
  const frontSeat = input.frontContact === true
    && frontContactOf(snapshot, passerGid, targetGid, reachProfiles, 1);
  if (frontSeat) {
    const worstThreat = Number.POSITIVE_INFINITY;
    const worstReception = threatQuintilePrice(worstThreat);
    const worstBand = threatBandIndex(worstThreat);
    const worstValue = valueAxis ? attemptValueAt(cell, worstBand) : 1;
    return {
      targetGid,
      infoClass: 'READ',
      cell,
      band: worstBand,
      price: valueAxis ? worstValue : worstReception,
      reception: worstReception,
      value: worstValue,
      executable: true,
      distance,
    };
  }
  const reception = threatQuintilePrice(read.interceptionThreatSeconds);
  const band = threatBandIndex(read.interceptionThreatSeconds);
  const value = valueAxis ? attemptValueAt(cell, band) : 1;
  return {
    targetGid,
    infoClass: 'READ',
    cell,
    band,
    price: valueAxis ? value : reception,
    reception,
    value,
    executable: true,
    distance,
  };
}

/**
 * The chooser. Prices every candidate, picks the best EXECUTABLE one (ties to
 * the lower gid, as the probe's reduce did), and reports whether a blind option
 * out-priced the field — the look-pressure statistic a future gaze consumer
 * will answer. Returns null when no candidate is executable: the passer sees
 * nobody he could aim at, and this module refuses to invent an aim point.
 */
export function choosePerceivedPassTarget(
  input: PerceivedPassChoiceInput,
): PerceivedPassChoice | null {
  const { snapshot, passerGid, candidateGids, attackDir, reachProfiles } = input;
  const valueAxis = input.valueAxis ?? false;
  const options = candidateGids.map((targetGid) => pricePassOption({
    snapshot, passerGid, targetGid, attackDir, reachProfiles, valueAxis,
    frontContact: input.frontContact,
  }));
  // LN T0 §SEAM (M-LN.3(c2)) — the ONE statement this stage adds to the chooser. Hook
  // absent ⇒ `priced` IS `options`, the very same array object, so every line below is the
  // shipped one on the shipped doubles. An UNEXECUTABLE option is left alone: a man he
  // cannot aim at has no lane to price, and his price never enters the argmax.
  const priced = input.ownLaneFactor === undefined ? options
    : options.map((option) => (option.executable
      ? { ...option, price: option.price * input.ownLaneFactor!(option.targetGid) }
      : option));
  const executable = priced.filter((option) => option.executable);
  if (executable.length === 0) return null;
  const best = executable.reduce((winner, option) => (
    option.price > winner.price
      || (option.price === winner.price && option.targetGid < winner.targetGid)
      ? option : winner));
  const blind = priced.filter((option) => !option.executable);
  let blindOutpricesRead = false;
  let blindOutpricesBand = false;
  if (blind.length > 0) {
    blindOutpricesRead = blind[0].price > best.price;
    // The band axis is read in the same units the price is, or the two sides of
    // the comparison mean different things the moment the axis is armed. Under
    // E5d the price IS the value, so the band comparison is the value too.
    const bestBand = Math.max(...executable.map((option) => (valueAxis ? option.value
      : (Number.isNaN(option.distance)
        ? OPTION_SPACE_PRIOR_MARGINAL.receptionSuccessRate
        : optionSpacePriorAt(option.distance).receptionSuccessRate))));
    blindOutpricesBand = blind[0].price > bestBand;
  }
  return {
    targetGid: best.targetGid,
    price: best.price,
    reception: best.reception,
    value: best.value,
    infoClass: best.infoClass,
    distance: best.distance,
    options: priced,
    blindOutpricesRead,
    blindOutpricesBand,
  };
}

/**
 * E3's no-strict-dominance CANARY instrument (E0's canary, made live).
 *
 * The live game has no power chooser — `performPass`'s `powerChoice` has no
 * production caller, C1-C was deferred into this slice and E2b-* priced power
 * 1.0 only — so "the share of passes PLAYED at the highest power" has no live
 * quantity behind it. What E0 and E1b's canaries actually measured is the
 * EVALUATOR's preference, and that is what this reports: at a real decision
 * moment, which power would the bundle's own pricing pick for the target it
 * chose?
 *
 * The joining rule is fixed here, before any result, and reports its parts:
 *   price(power) = quintilePrice(threat(power)) × (1 − touchFail(power)) / (1 − touchFail(1.0))
 * At power 1.0 this is exactly the choice axis (no double counting at the
 * reference point); away from it, the measured corridor axis is scaled by the
 * relative first-touch survival the E1a-certified formula predicts. Every
 * component is reported per power so any other joining rule can be applied to
 * the same numbers afterwards.
 */
export interface PowerPreference {
  readonly powers: readonly number[];
  readonly prices: readonly number[];
  readonly threatSeconds: readonly number[];
  readonly touchFailPriors: readonly number[];
  readonly preferredIndex: number;
}

export function preferredPassPower(input: {
  readonly snapshot: PerceptionSnapshot;
  readonly passerGid: number;
  readonly targetGid: number;
  readonly attackDir: 1 | -1;
  readonly reachProfiles: ReadonlyMap<number, KnownReachProfile>;
  readonly powers: readonly number[];
  readonly heavyTouchCost: boolean;
}): PowerPreference | null {
  const { snapshot, passerGid, targetGid, attackDir, reachProfiles, powers } = input;
  const values = powers.map((powerMultiplier) => evaluatePassOption({
    snapshot,
    passerGid,
    targetGid,
    powerMultiplier,
    attackDir,
    reachProfiles,
    heavyTouchCost: input.heavyTouchCost,
  }));
  if (values.some((value) => value === null)) return null;
  const reference = powers.indexOf(1);
  if (reference < 0) return null;
  const referenceSurvival = 1 - values[reference]!.touchFailPrior;
  if (!(referenceSurvival > 0)) return null;
  const prices = values.map((value) => threatQuintilePrice(value!.interceptionThreatSeconds)
    * ((1 - value!.touchFailPrior) / referenceSurvival));
  let preferredIndex = 0;
  for (let index = 1; index < prices.length; index++) {
    if (prices[index] > prices[preferredIndex]) preferredIndex = index;
  }
  return {
    powers,
    prices,
    threatSeconds: values.map((value) => value!.interceptionThreatSeconds),
    touchFailPriors: values.map((value) => value!.touchFailPrior),
    preferredIndex,
  };
}
