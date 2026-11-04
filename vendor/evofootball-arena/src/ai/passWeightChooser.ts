/**
 * PW T0b — THE RUNG-GRAIN PASS-WEIGHT CHOOSER
 * (docs/world-model/PW-T0B-WEIGHT-CHOOSER.md; contract PW-PASSWEIGHT-CONTRACT.md §2 M-PW.2,
 * design FIXED by ruling #292.4).
 *
 * The live game has one pace per range: `performPass`'s `powerChoice` input has existed since
 * C1-A and every live caller passes the literal 1 (PW-C0 §A.1). This module is the chooser that
 * would use it — and NOTHING ELSE. It has exactly one caller, `PlayerBrain`'s `pwWeightChooser`
 * block, which is dormant in every production path.
 *
 * ⭐⭐ THE GRAIN IS THE POINT (#292.4). PW-T0a measured the SHIPPED joining rule
 * (`preferredPassPower`) per option and found it wants the softest legal ball ~4/5 of the time —
 * because L4 admission puts 100 % of PUBLISHED survivors in threat quintile q0, so the corridor
 * half of the price is saturated before the rule is asked. The firmer ball's value therefore
 * lives in ADMISSION, not in price: the only population where the quintile ever improves is the
 * UNION — options today's ladder does not publish at 1.00 (PW-T0a §B.2). So this chooser is
 * enumerated at RUNG GRAIN:
 *
 *   * every (mate × rung) pair is asked of the SHIPPED affordance oracle AT THAT RUNG'S POWER,
 *     and each pair stands alone — an option dead at 1.00 and alive at 1.15 ENTERS the candidate
 *     set as its own candidate, and an option that prices at only one rung is a candidate at
 *     that rung. `preferredPassPower`'s all-three-rungs refusal is NOT inherited: it is a
 *     per-option normalisation artefact (its price divides by the reference rung's touch
 *     survival, which does not exist when the option does not exist at 1.00), and it is exactly
 *     the mechanism that hides the admission population.
 *   * ONE TABLE, no new constants (M-PW.2): the rung-dependent factor is the SAME two factors the
 *     shipped rule joins — the oracle's own threat-quintile price at that rung × the BASE
 *     touch-fail survival at that rung. The heavy curve is STRUCK for the chooser (#292.3:
 *     measured to make the axis MORE floor-degenerate), so the base curve is the one asked,
 *     always. ⭐ AMENDED BY PW-T0c: those two factors are no longer the whole price — they are
 *     the RUNG's contribution to the SHIPPED price. See the T0c block below, which owns the
 *     pricing statement of record.
 *   * the argmax picks (mate, weight) JOINTLY over one flat candidate list.
 *
 * ⭐ DIVERGENCE-1 (#291.1(c), magnitude measured at #292.3): the sim strikes with
 * `orientationPowerMul` (the passer's own body alignment) and the oracle prices without it, at
 * every power. Under the PW flag ONLY the caller hands this module the passer's OWN orientation
 * multiplier per target, and it rides INTO the oracle's `powerMultiplier` — self-knowledge, the
 * INFO-DOCTRINE §0 class (a body knows which way it is turned). Production paths never reach
 * this module, so no production price gains the term.
 *
 * Pure: it reads a `PerceptionSnapshot`, the reach profiles and the caller's own orientation
 * table. No Match, no truth, no RNG, no mutation of its inputs.
 *
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * ⭐⭐ PW T0c AMENDMENT — OBJECTIVE FIDELITY AND CANDIDATE-SET PARITY (ruling #293.3 (a); the
 * PW-T0b verify MED-2, ratified; docs/world-model/PW-T0C-OBJECTIVE-FIDELITY.md).
 *
 * As first built, this module re-priced the MATE on reception × touch alone. In the v7 world the
 * shipped chooser prices mates on the ARMED VALUE AXIS (`pricePassOption → attemptValueAt`) and
 * it can pick SEEN-UNREAD mates, so PW-T1's contrast would have conflated "the weight axis" with
 * "a different, thinner mate chooser". The amendment re-bases the price on the world's own
 * objective:
 *
 *   price(mate, rung) = SHIPPED_PRICE(mate) × rungFactor(mate, rung)
 *
 *   * SHIPPED_PRICE is `pricePassOption(...).price` under the world's own flags — literally the
 *     number the live chooser's argmax compares (in v7 the armed value axis; in a bare world the
 *     reception price, bit for bit). Not a re-implementation: the shipped function is CALLED.
 *   * rungFactor is the shipped joining rule's own rung-dependent factor, normalised at the
 *     reference rung: `q(threat@rung)·(1−touchFail@rung) ÷ q(threat@1)·(1−touchFail@1)`.
 *     `preferredPassPower` normalises its touch term by the reference rung's survival precisely
 *     so that "at power 1.0 this is exactly the choice axis (no double counting at the reference
 *     point)"; because our base IS the choice axis, the WHOLE rung-dependent product must
 *     normalise to 1 there — that is the same property, carried over. Same two factors, same
 *     base curve (#292.3), NO new constants (M-PW.2).
 *   * CANDIDATE-SET PARITY: the candidate set is the shipped chooser's own — the same
 *     `passChoiceCandidateGids` window (6–30 m, GK excluded) handed in by the caller, and the
 *     same EXECUTABLE filter, so SEEN-UNREAD mates are candidates here exactly as they are
 *     there. The REFERENCE rung is therefore admitted for every shipped-executable mate (at
 *     factor 1, i.e. at the shipped price verbatim); the ORACLE's per-rung null still governs
 *     the NON-reference rungs, so per-rung admission stands where it can mean anything.
 *
 * ⭐ THE CONSEQUENCE THE EXAM NEEDS: collapse the ladder to {1} and this chooser's argmax is the
 * SHIPPED chooser's argmax, decision for decision (identical prices, identical tie-break) — so
 * with the full ladder a mate switch is attributable to a RUNG and never to a thinner objective.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
import { evaluatePassOption, type PassOptionValue } from './passOptionValue';
import { pricePassOption, threatQuintilePrice, type PassInfoClass } from './perceivedPassChoice';
import type { PerceptionSnapshot } from './perceptionSnapshot';
import type { KnownReachProfile } from './reachability';

/** One (mate × rung) pair that the oracle ADMITTED at that rung, priced at that rung. */
export interface PassWeightCandidate {
  readonly targetGid: number;
  /** Index into the ladder the caller supplied (the engine's own PASS_CANARY_POWERS). */
  readonly powerIndex: number;
  /** ⭐ THE INTENDED WEIGHT — what `performPass` is asked for; never the oracle-facing product. */
  readonly power: number;
  /** The power the ORACLE was asked with: `power × orientation` (the flag's own term). */
  readonly oraclePower: number;
  /**
   * ⭐ PW T0c (#293.3 (a)): the SHIPPED per-mate price under the world's own flags — the very
   * number `pricePassOption` hands the live chooser's argmax. The objective, inherited whole.
   */
  readonly shippedPrice: number;
  /** The shipped chooser's own information class for this mate (parity, incl. SEEN-UNREAD). */
  readonly infoClass: PassInfoClass;
  /**
   * ⭐ PW T0c: the RUNG-DEPENDENT factor, normalised at the reference rung — exactly 1 there.
   * `q(threat@rung)·(1−touchFail@rung) ÷ q(threat@ref)·(1−touchFail@ref)`, base curve.
   */
  readonly rungFactor: number;
  /** Whether the reference-rung read existed, so the factor is a genuine ratio (else it is 1). */
  readonly hasReferenceNormaliser: boolean;
  /** ⭐ THE PRICE: `shippedPrice × rungFactor`. At the reference rung it IS the shipped price. */
  readonly price: number;
  /** NaN where the oracle refused this rung (a reference-rung parity admission). */
  readonly threatSeconds: number;
  readonly touchFailPrior: number;
  readonly arrivalMarginSeconds: number;
  /**
   * ⭐ PURE OBSERVATION, NEVER A FILTER: whether this pair also clears the CENSUS ladder's own
   * race and corridor rungs at this power (BU-C0's L3 `arrivalMargin > 0` ∧ L4 "no defender has
   * a feasible interception point", the latter read as the oracle's own `threat < 0` — see
   * PW-T0a §B.2's derivation of that equivalence). Admission here is the ORACLE'S NULL CONTRACT
   * (#292.4 as written); this flag exists so the stage can COUNT the census-grain admission
   * population without the chooser ever acting on it.
   */
  readonly liveOnCensusLadder: boolean;
}

export interface PassWeightChoice {
  readonly targetGid: number;
  /** ⭐ the weight that must ride the pending pass all the way to the strike. */
  readonly power: number;
  readonly powerIndex: number;
  readonly price: number;
  readonly candidates: readonly PassWeightCandidate[];
  /** (mate × rung) pairs ASKED of the oracle — the ×3 cost receipt's numerator. */
  readonly pairsAsked: number;
  /** Mates with at least one admitted rung. */
  readonly matesAdmitted: number;
  /**
   * ⭐ THE ADMISSION RECEIPT (#292.4): pairs admitted at a NON-DEFAULT rung whose own mate is
   * NOT admitted at the reference rung 1.00 — the population PW-T0a's `ref` set could not see.
   */
  readonly pairsAdmittedOnlyOffReference: number;
  /** Mates admitted at some rung but NOT at the reference rung. */
  readonly matesAdmittedOnlyOffReference: number;
  /**
   * ⭐ THE REFUSAL-INHERITANCE RECEIPT: pairs dropped for failing to price at ANOTHER rung.
   * Structurally 0 — each pair stands alone — and published so the claim is a count, not a
   * comment.
   */
  readonly pairsDroppedForOtherRungRefusal: number;
  /**
   * ⭐ THE CENSUS-GRAIN ADMISSION OBSERVATION (never acted on): pairs that are LIVE on the census
   * ladder at a NON-DEFAULT rung whose own mate is NOT live at the reference rung — the
   * "alive at 1.15, dead at 1.00" population PW-T0a's `ref` set could not see (#292.2). Counted
   * because the oracle's own null contract turns out never to bind inside the live 6–30 m
   * window (ground-pass range at the window's near edge already exceeds it), so the null-grain
   * counters above would report the admission story as an empty one.
   */
  readonly pairsLiveOnlyOffReference: number;
  readonly matesLiveOnlyOffReference: number;
  /** Pairs live on the census ladder at all, and mates with at least one such pair. */
  readonly pairsLive: number;
  readonly matesLive: number;
  /* ── PW T0c (#293.3 (a)) — the objective-fidelity / parity counters ───────────────────── */
  /** Mates priced through the SHIPPED `pricePassOption` (one call each) — the parity numerator. */
  readonly matesPriced: number;
  /** Mates the SHIPPED chooser would not aim at either (`executable === false`): skipped here. */
  readonly matesNotExecutable: number;
  /**
   * ⭐ SEEN-UNREAD mates that entered BECAUSE of parity — the oracle refused them at the
   * reference rung, the shipped chooser prices and can pick them, so they are candidates at the
   * reference rung at the shipped price. This is the population the pre-amendment chooser DROPPED.
   */
  readonly referenceAdmissionsWithoutOracleRead: number;
  /**
   * Non-reference pairs admitted with NO reference read to normalise against: they carry the
   * shipped price at factor 1 (never dropped — no refusal is inherited — but their rung buys
   * them nothing, so the tie-break sends the mate back to the softest rung). Counted, not hidden.
   */
  readonly rungsWithoutReferenceNormaliser: number;
}

export interface PassWeightChooserInput {
  readonly snapshot: PerceptionSnapshot;
  readonly passerGid: number;
  /** In window order, as the roster iterates — the live chooser's own candidate list. */
  readonly candidateGids: readonly number[];
  readonly attackDir: 1 | -1;
  readonly reachProfiles: ReadonlyMap<number, KnownReachProfile>;
  /** The engine's own canary ladder, handed in by the caller (never restated here). */
  readonly powers: readonly number[];
  /**
   * ⭐ DIVERGENCE-1, under the flag only: the passer's OWN orientation power multiplier for each
   * target gid, computed by the caller from the sim's own `orientationPowerMul` on the PERCEIVED
   * direction. A gid the caller did not supply prices at 1 — the shipped (blind) oracle.
   */
  readonly orientationMul: ReadonlyMap<number, number>;
  /**
   * ⭐ PW T0c (#293.3 (a)): the world's OWN objective flag, handed in by the caller from
   * `match.edsValueAxis`, so the base price is the one the live chooser actually compares.
   */
  readonly valueAxis: boolean;
}

/**
 * Enumerate (mate × rung), admit per rung through the shipped oracle, price each admitted pair
 * on the one table at its own rung, and take the joint argmax. Returns null when no pair is
 * admitted at any rung — the caller then keeps the incumbent decision untouched, exactly as the
 * E3 chooser's own null does.
 *
 * Ties break exactly as the shipped chooser breaks them — better price, then LOWER GID, then
 * (within one mate) the lower rung index, i.e. the SOFTER ball (PW-T0a §CORRECTIONS 6).
 */
export function choosePassWeight(input: PassWeightChooserInput): PassWeightChoice | null {
  const {
    snapshot, passerGid, candidateGids, attackDir, reachProfiles, powers, orientationMul,
  } = input;
  const candidates: PassWeightCandidate[] = [];
  const referenceIndex = powers.indexOf(1);
  let pairsAsked = 0;
  let matesAdmitted = 0;
  let matesAdmittedOnlyOffReference = 0;
  let pairsAdmittedOnlyOffReference = 0;
  let pairsLive = 0;
  let matesLive = 0;
  let pairsLiveOnlyOffReference = 0;
  let matesLiveOnlyOffReference = 0;
  let matesPriced = 0;
  let matesNotExecutable = 0;
  let referenceAdmissionsWithoutOracleRead = 0;
  let rungsWithoutReferenceNormaliser = 0;
  /** the shipped joining rule's own rung-dependent product, base curve (M-PW.2: no new terms). */
  const rungTerm = (v: PassOptionValue): number =>
    threatQuintilePrice(v.interceptionThreatSeconds) * (1 - v.touchFailPrior);
  for (const targetGid of candidateGids) {
    // ⭐ PW T0c — THE OBJECTIVE, INHERITED WHOLE: the SHIPPED per-mate price under the world's
    // own flags, from the shipped function itself. Candidate-set parity: a mate the shipped
    // chooser could not aim at (`executable === false` — the UNSEEN class) is not a candidate
    // here either, and a SEEN-UNREAD mate, which it CAN pick, is.
    const shipped = pricePassOption({
      snapshot, passerGid, targetGid, attackDir, reachProfiles, valueAxis: input.valueAxis,
    });
    matesPriced++;
    if (!shipped.executable) { matesNotExecutable++; continue; }
    const orientation = orientationMul.get(targetGid) ?? 1;
    const reads: (PassOptionValue | null)[] = [];
    for (let powerIndex = 0; powerIndex < powers.length; powerIndex++) {
      pairsAsked++;
      reads.push(evaluatePassOption({
        snapshot,
        passerGid,
        targetGid,
        powerMultiplier: powers[powerIndex] * orientation,
        attackDir,
        reachProfiles,
      }));
    }
    const referenceRead = referenceIndex < 0 ? null : reads[referenceIndex];
    const referenceTerm = referenceRead === null ? null : rungTerm(referenceRead);
    const normaliser = referenceTerm !== null && referenceTerm > 0 ? referenceTerm : null;
    const mine: PassWeightCandidate[] = [];
    let admittedAtReference = false;
    for (let powerIndex = 0; powerIndex < powers.length; powerIndex++) {
      const power = powers[powerIndex];
      const oraclePower = power * orientation;
      const value = reads[powerIndex];
      const isReference = powerIndex === referenceIndex;
      // PER-RUNG ADMISSION: a null retires THIS pair and nothing else. No sibling rung is
      // consulted, so no pair is ever dropped for another rung's refusal.
      // ⭐ PW T0c: the REFERENCE rung is admitted on the SHIPPED chooser's own admission rule
      // (executable), never on the oracle's — that is what candidate-set parity means, and it
      // is what makes the collapsed-ladder world identical to the shipped one.
      if (value === null && !isReference) continue;
      if (isReference) admittedAtReference = true;
      if (value === null) referenceAdmissionsWithoutOracleRead++;
      let rungFactor = 1;
      if (!isReference && value !== null) {
        if (normaliser === null) rungsWithoutReferenceNormaliser++;
        else rungFactor = rungTerm(value) / normaliser;
      }
      mine.push({
        targetGid,
        powerIndex,
        power,
        oraclePower,
        shippedPrice: shipped.price,
        infoClass: shipped.infoClass,
        rungFactor,
        hasReferenceNormaliser: normaliser !== null,
        price: shipped.price * rungFactor,
        threatSeconds: value === null ? Number.NaN : value.interceptionThreatSeconds,
        touchFailPrior: value === null ? Number.NaN : value.touchFailPrior,
        arrivalMarginSeconds: value === null ? Number.NaN : value.arrivalMarginSeconds,
        liveOnCensusLadder: value !== null
          && value.arrivalMarginSeconds > 0 && value.interceptionThreatSeconds < 0,
      });
    }
    if (mine.length === 0) continue;
    matesAdmitted++;
    if (!admittedAtReference) {
      matesAdmittedOnlyOffReference++;
      pairsAdmittedOnlyOffReference += mine.length;
    }
    const live = mine.filter((c) => c.liveOnCensusLadder);
    pairsLive += live.length;
    if (live.length > 0) {
      matesLive++;
      if (!live.some((c) => c.powerIndex === referenceIndex)) {
        matesLiveOnlyOffReference++;
        pairsLiveOnlyOffReference += live.length;
      }
    }
    for (const c of mine) candidates.push(c);
  }
  if (candidates.length === 0) return null;
  // ⭐ PW T0c — THE SHIPPED ARGMAX'S OWN TIE-BREAK, restated so fidelity does not depend on the
  // caller's enumeration order: better price wins; an exact tie goes to the LOWER GID (the
  // shipped `choosePerceivedPassTarget` reduce's own rule); a tie within one mate goes to the
  // LOWER RUNG INDEX, i.e. with the ladder in floor→ceiling order, to the SOFTER ball
  // (PW-T0a §CORRECTIONS 6).
  let best = candidates[0];
  for (let i = 1; i < candidates.length; i++) {
    const c = candidates[i];
    const better = c.price > best.price
      || (c.price === best.price && c.targetGid < best.targetGid)
      || (c.price === best.price && c.targetGid === best.targetGid
        && c.powerIndex < best.powerIndex);
    if (better) best = c;
  }
  return {
    targetGid: best.targetGid,
    power: best.power,
    powerIndex: best.powerIndex,
    price: best.price,
    candidates,
    pairsAsked,
    matesAdmitted,
    pairsAdmittedOnlyOffReference,
    matesAdmittedOnlyOffReference,
    pairsDroppedForOtherRungRefusal: 0,
    pairsLiveOnlyOffReference,
    matesLiveOnlyOffReference,
    pairsLive,
    matesLive,
    matesPriced,
    matesNotExecutable,
    referenceAdmissionsWithoutOracleRead,
    rungsWithoutReferenceNormaliser,
  };
}
