/**
 * EDS E2a — the census-derived pass base-rate table.
 * Authority: docs/world-model/EDS-E2A-CENSUS-PRIORS.md
 *
 * This file is DATA, not a model. Every number below was measured by
 * `scripts/probes/eds-e2a-prior-census.ts` over 250 sealed matches
 * (seeds 610,000..610,249) and validated against a disjoint held-out 250
 * (seeds 620,000..620,249). The probe re-derives the census on every run and
 * asserts this table equals it (gate X6), so the two cannot drift.
 *
 * The table exists because observation DELETES options rather than blurring
 * them (E0: 55 of 120 states unpriceable, all of them target-missing). An
 * option the passer cannot see is priced here, at the population rate, instead
 * of vanishing — because vanishing is what made not-looking informationally
 * superior in S3b. It is infrastructure like a sampling budget: it may not be
 * adjusted after any A/B result, ever.
 *
 * CENSUS TABLE SHA: 326ea40e9b6c4214584c683fe9b60732fe6753924eaefbdfad5159b22d564db0
 * (sha256 over the canonical JSON of {table, marginal}; gate X6 re-derives it.)
 */

/** Half-open metre bands over E0's own 6–30 m candidate window. */
export const PASS_PRIOR_BANDS: readonly (readonly [number, number])[] = [
  [6, 10], [10, 14], [14, 18], [18, 22], [22, 26], [26, 30],
];

export interface PassPriorRow {
  /** Lower edge of the band in metres; the MARGINAL row uses -1. */
  readonly bandFrom: number;
  readonly bandTo: number;
  readonly passes: number;
  readonly interceptedRate: number;
  readonly reachedRate: number;
  readonly otherTeammateRate: number;
  readonly unresolvedRate: number;
  /** Clean first touch GIVEN the ball reached the intended target. */
  readonly cleanGivenReached: number;
  /** reached x cleanGivenReached — what an option-pricer actually wants. */
  readonly receptionSuccessRate: number;
}

/**
 * E2a-1's PASS-LOG census: the passes the live chooser decided to play. Its P3
 * caught that this is a SELECTED sample and therefore the wrong population for
 * pricing options nobody chose — see EDS-E2A-CENSUS-PRIORS.md §7. Retained
 * untouched as the chosen-subset reference, as one side of the chooser-lift
 * diagnostic, and so E2a-1's own reproduction gate keeps working. NOT the
 * prior the pricing layer reads.
 */
export const PASS_PRIOR_TABLE: readonly PassPriorRow[] = [
  {
    bandFrom: 6,
    bandTo: 10,
    passes: 4377,
    interceptedRate: 0.17980351839159242,
    reachedRate: 0.7687914096413069,
    otherTeammateRate: 0.05071967100753941,
    unresolvedRate: 0.0006854009595613434,
    cleanGivenReached: 0.9295690936106984,
    receptionSuccessRate: 0.7146447338359607,
  },
  {
    bandFrom: 10,
    bandTo: 14,
    passes: 5113,
    interceptedRate: 0.17719538431449247,
    reachedRate: 0.7535693330725601,
    otherTeammateRate: 0.06727948366907882,
    unresolvedRate: 0.0019557989438685705,
    cleanGivenReached: 0.9294056579288866,
    receptionSuccessRate: 0.7003716017993351,
  },
  {
    bandFrom: 14,
    bandTo: 18,
    passes: 4572,
    interceptedRate: 0.19903762029746283,
    reachedRate: 0.7454068241469817,
    otherTeammateRate: 0.05096237970253718,
    unresolvedRate: 0.004593175853018373,
    cleanGivenReached: 0.9322183098591549,
    receptionSuccessRate: 0.6948818897637795,
  },
  {
    bandFrom: 18,
    bandTo: 22,
    passes: 3437,
    interceptedRate: 0.22781495490253129,
    reachedRate: 0.7067209775967414,
    otherTeammateRate: 0.05557171952283969,
    unresolvedRate: 0.009892347977887692,
    cleanGivenReached: 0.9304240428159737,
    receptionSuccessRate: 0.6575501891184172,
  },
  {
    bandFrom: 22,
    bandTo: 26,
    passes: 2455,
    interceptedRate: 0.20610997963340122,
    reachedRate: 0.7384928716904277,
    otherTeammateRate: 0.038289205702647655,
    unresolvedRate: 0.017107942973523423,
    cleanGivenReached: 0.924434638720353,
    receptionSuccessRate: 0.6826883910386965,
  },
  {
    bandFrom: 26,
    bandTo: 30,
    passes: 1503,
    interceptedRate: 0.19560878243512975,
    reachedRate: 0.688622754491018,
    otherTeammateRate: 0.09381237524950099,
    unresolvedRate: 0.021956087824351298,
    cleanGivenReached: 0.9169082125603865,
    receptionSuccessRate: 0.6314038589487692,
  },
];

/** The population rate over every band — what an UNSEEN option is priced at,
 * because a passer who cannot see the man cannot know his distance either. */
export const PASS_PRIOR_MARGINAL: PassPriorRow = {
  bandFrom: -1,
  bandTo: -1,
  passes: 21457,
  interceptedRate: 0.19508785011884233,
  reachedRate: 0.7411567320687887,
  otherTeammateRate: 0.057090926038122755,
  unresolvedRate: 0.006664491774246167,
  cleanGivenReached: 0.9288184619254228,
  receptionSuccessRate: 0.6884000559258051,
};

/**
 * EDS E2a-2 — the OPTION-SPACE table (commander ruling #8). This is the prior
 * the pricing layer consumes. It differs from the pass-log table above in its
 * POPULATION, not its method: every candidate at a real decision moment,
 * measured counterfactually by forking the world and substituting the target,
 * rather than only the passes the chooser decided to play. E2a-1's table is
 * retained directly above as the chosen-subset reference and as one side of
 * the chooser-lift diagnostic.
 *
 * OPTION-SPACE TABLE SHA: df0aa3407b0a49f2c24bb0bf29dcea8aa87ed3bed3aad89af5abbb66faea1903
 */
export const OPTION_SPACE_PRIOR_TABLE: readonly PassPriorRow[] = [
  {
    bandFrom: 6,
    bandTo: 10,
    passes: 3451,
    interceptedRate: 0.34685598377281945,
    reachedRate: 0.5896841495218778,
    otherTeammateRate: 0.06317009562445668,
    unresolvedRate: 0.0002897710808461316,
    cleanGivenReached: 0.914987714987715,
    receptionSuccessRate: 0.539553752535497,
  },
  {
    bandFrom: 10,
    bandTo: 14,
    passes: 3483,
    interceptedRate: 0.32271030720643124,
    reachedRate: 0.615848406546081,
    otherTeammateRate: 0.0611541774332472,
    unresolvedRate: 0.0002871088142405972,
    cleanGivenReached: 0.9132867132867133,
    receptionSuccessRate: 0.5624461670973299,
  },
  {
    bandFrom: 14,
    bandTo: 18,
    passes: 2867,
    interceptedRate: 0.30659225671433554,
    reachedRate: 0.6187652598535054,
    otherTeammateRate: 0.07359609347750262,
    unresolvedRate: 0.0010463899546564353,
    cleanGivenReached: 0.9160090191657272,
    receptionSuccessRate: 0.5667945587722358,
  },
  {
    bandFrom: 18,
    bandTo: 22,
    passes: 2101,
    interceptedRate: 0.28081865778200854,
    reachedRate: 0.6544502617801047,
    otherTeammateRate: 0.06425511661113756,
    unresolvedRate: 0.00047596382674916705,
    cleanGivenReached: 0.9127272727272727,
    receptionSuccessRate: 0.5973346025702047,
  },
  {
    bandFrom: 22,
    bandTo: 26,
    passes: 1357,
    interceptedRate: 0.341930729550479,
    reachedRate: 0.5969049373618276,
    otherTeammateRate: 0.061164333087693444,
    unresolvedRate: 0,
    cleanGivenReached: 0.9135802469135803,
    receptionSuccessRate: 0.5453205600589537,
  },
  {
    bandFrom: 26,
    bandTo: 30,
    passes: 855,
    interceptedRate: 0.37777777777777777,
    reachedRate: 0.5415204678362573,
    otherTeammateRate: 0.07953216374269007,
    unresolvedRate: 0.0011695906432748538,
    cleanGivenReached: 0.9136069114470843,
    receptionSuccessRate: 0.49473684210526314,
  },
];

export const OPTION_SPACE_PRIOR_MARGINAL: PassPriorRow = {
  bandFrom: -1,
  bandTo: -1,
  passes: 14114,
  interceptedRate: 0.32428794105143827,
  reachedRate: 0.609465778659487,
  otherTeammateRate: 0.06575031883236503,
  unresolvedRate: 0.00049596145670965,
  cleanGivenReached: 0.9142059986049755,
  receptionSuccessRate: 0.5571772707949554,
};

/** The band a distance falls in, or null outside the censused window. */
export function passPriorBandIndex(distanceMetres: number): number | null {
  for (let index = 0; index < PASS_PRIOR_BANDS.length; index++) {
    const [from, to] = PASS_PRIOR_BANDS[index];
    if (distanceMetres >= from && distanceMetres < to) return index;
  }
  // The top edge is inclusive: a 30.0 m pass belongs to the last band.
  const last = PASS_PRIOR_BANDS[PASS_PRIOR_BANDS.length - 1];
  if (distanceMetres === last[1]) return PASS_PRIOR_BANDS.length - 1;
  return null;
}

/**
 * The prior for an option at a KNOWN distance; outside the censused window the
 * marginal is the honest answer rather than an extrapolation.
 */
export function passPriorAt(distanceMetres: number): PassPriorRow {
  const index = passPriorBandIndex(distanceMetres);
  return index === null ? PASS_PRIOR_MARGINAL : PASS_PRIOR_TABLE[index];
}

/** Option-space band lookup — the one the pricing layer uses. */
export function optionSpacePriorBandIndex(distanceMetres: number): number | null {
  return passPriorBandIndex(distanceMetres);
}

export function optionSpacePriorAt(distanceMetres: number): PassPriorRow {
  const index = optionSpacePriorBandIndex(distanceMetres);
  return index === null ? OPTION_SPACE_PRIOR_MARGINAL : OPTION_SPACE_PRIOR_TABLE[index];
}

/**
 * EDS E2b-0 — the threat calibration curve.
 * Authority: docs/world-model/EDS-E2B0-THREAT-CALIBRATION.md
 *
 * What E0's corridor read is WORTH, measured rather than assumed: realized
 * reception success by quintile of predicted interception threat, over the same
 * counterfactual forks E2a-2 censused. This is what puts a seen option's
 * physical read on the same probability axis as an unseen option's band prior,
 * so the two can be compared without a hand-set weight.
 *
 * CALIBRATION SHA: 52c1071334e6d09aeeb6ac66a6cda2b3686c0e7e05b9d6cd574be84a13fe3082
 */
export interface ThreatCalibrationRow {
  readonly quintile: number;
  readonly n: number;
  /** Predicted corridor threat in seconds; higher = more threatened. */
  readonly keyFrom: number;
  readonly keyTo: number;
  readonly realizedSuccess: number;
}

export const VALUE_ZONE_LONGITUDINAL_EDGES: readonly number[] = [-10.5, 10.5, 21];
/** The sim's own overlap gate (`Match.ts`: a release counts wide past 11 m). */
export const VALUE_ZONE_WIDE_METRES = 11;

export interface ValueZoneRow {
  /** 0..7 = longitudinal band x 2 + (wide ? 1 : 0); the MARGINAL row uses -1. */
  readonly zone: number;
  readonly receptions: number;
  /** V: P(shot by the passing team within 4.0 s | clean reception here). */
  readonly shotRate: number;
  readonly goalRate: number;
  readonly meanProgression: number;
}

/**
 * The zone a position falls in, in the passing team's attack frame. Pitch
 * thirds (football's own division) with the attacking third halved, crossed
 * with the sim's own wide gate. Never extrapolated: every position on the pitch
 * lands in exactly one cell.
 */
export function valueZoneIndex(localX: number, y: number): number {
  let band = VALUE_ZONE_LONGITUDINAL_EDGES.length;
  for (let index = 0; index < VALUE_ZONE_LONGITUDINAL_EDGES.length; index++) {
    if (localX < VALUE_ZONE_LONGITUDINAL_EDGES[index]) {
      band = index;
      break;
    }
  }
  return band * 2 + (Math.abs(y) >= VALUE_ZONE_WIDE_METRES ? 1 : 0);
}

/**
 * EDS E5a — the VALUE table (commander ruling #15.3).
 * Authority: docs/world-model/EDS-E5-VALUE-AXIS.md
 *
 * The other half of the decision, measured the same way the first half was: over
 * E2a-2's counterfactual forks, following each clean reception to a 4.0 s
 * horizon and recording whether the passing team got a shot away. The chooser
 * multiplies this by the reception probability, and E5a's V4 gate is what makes
 * that product a measurement rather than a weight — it must predict the
 * conjunction (clean reception AND shot) the world actually produced.
 *
 * Measured under legacy-brain play, exactly like the two tables above; the
 * circularity is registered in the contract §2.1, not hidden.
 *
 * VALUE TABLE SHA: 0125071f52165f4d28a7e5085e588a54776e21fcd6b89e3b48537ce415ca3bc9
 * (sha256 over the canonical JSON of {table, marginal}; gate X6 re-derives it.)
 *
 * 7,864 clean receptions over the census set; four of the eight cells clear the
 * 400-reception floor and the other four honestly read the marginal — including
 * both attacking-third-inner cells, which is the sharpest limitation of this
 * table and is reported rather than repaired (contract §7.1).
 */
export const VALUE_ZONE_TABLE: readonly ValueZoneRow[] = [
  { zone: 0, receptions: 1612, shotRate: 0.013027295285359801, goalRate: 0, meanProgression: 11.77326485206329 },
  { zone: 1, receptions: 226, shotRate: 0.022123893805309734, goalRate: 0, meanProgression: 12.866477998231302 },
  { zone: 2, receptions: 3546, shotRate: 0.07642413987591652, goalRate: 0.00535815002820079, meanProgression: 6.814456835836743 },
  { zone: 3, receptions: 1544, shotRate: 0.08808290155440414, goalRate: 0.0045336787564766836, meanProgression: 6.237657880728535 },
  { zone: 4, receptions: 500, shotRate: 0.114, goalRate: 0.03, meanProgression: 0.2319336799855316 },
  { zone: 5, receptions: 243, shotRate: 0.13580246913580246, goalRate: 0.0411522633744856, meanProgression: 0.5243461434916344 },
  { zone: 6, receptions: 129, shotRate: 0.09302325581395349, goalRate: 0.10852713178294573, meanProgression: -3.934466738696879 },
  { zone: 7, receptions: 64, shotRate: 0.421875, goalRate: 0.09375, meanProgression: -1.9393465255236906 },
];

export const VALUE_ZONE_MARGINAL: ValueZoneRow = {
  zone: -1,
  receptions: 7864,
  shotRate: 0.07146490335707019,
  goalRate: 0.009028484231943032,
  meanProgression: 7.031161399133294,
};

/**
 * EDS E5c (a) — the TOPPED-UP value table (commander ruling #16.4).
 * Authority: docs/world-model/EDS-E5C-VALUE-ATTRIBUTION.md
 *
 * E5a's table with its two starved cells replaced, and nothing else: Z6 and Z7
 * (the attacking third's inner half) sat at 129 and 64 receptions against the
 * 400 floor, so the chooser read them at the marginal — BELOW the outer-third
 * cells it had measured. This is the HU test's instrument: remove the sampling
 * defect, re-run E5b with every gate verbatim, and see whether third-man play
 * comes back.
 *
 * The marginal and cells Z0-Z5 are deliberately NOT topped up. Adding inner-box
 * receptions to the population rate would over-represent the highest-value
 * zones in the very number that prices a man the passer cannot see.
 *
 * Z6 goes 129 → 902 receptions and Z7 64 → 400, both now measurements: 11.97%
 * and 28.25% against the 7.15% marginal the chooser had been reading for them.
 * Held out on fresh seeds at 12.20% and 30.25%.
 *
 * ⚠️ These rows carry E5a's reception convention VERBATIM, including its
 * defect: an arrival that never reached `attemptFirstTouch` counts as a
 * reception (E2a-2's registered convention) but was never followed, so it
 * enters as a guaranteed non-shot. E5c measured what those unfollowed windows
 * actually did — 7.07% of Z6's and 10.43% of Z7's produced a shot — which means
 * these two cells are deflated by roughly 2.4pp and 2.8pp, and every other cell
 * in this table by an unmeasured amount. Correcting it is the commander's call
 * (EDS-E5C-VALUE-ATTRIBUTION.md §7.1); keeping the convention is what makes the
 * six untouched cells comparable with these two.
 *
 * TOPPED-UP TABLE SHA: a197b4531db2d71fbeb6b3977c395a7899421e698a43b13fdb11859a1aeded46
 */
export const VALUE_ZONE_TABLE_TOPPED: readonly ValueZoneRow[] = [
  { zone: 0, receptions: 1612, shotRate: 0.013027295285359801, goalRate: 0, meanProgression: 11.77326485206329 },
  { zone: 1, receptions: 226, shotRate: 0.022123893805309734, goalRate: 0, meanProgression: 12.866477998231302 },
  { zone: 2, receptions: 3546, shotRate: 0.07642413987591652, goalRate: 0.00535815002820079, meanProgression: 6.814456835836743 },
  { zone: 3, receptions: 1544, shotRate: 0.08808290155440414, goalRate: 0.0045336787564766836, meanProgression: 6.237657880728535 },
  { zone: 4, receptions: 500, shotRate: 0.114, goalRate: 0.03, meanProgression: 0.2319336799855316 },
  { zone: 5, receptions: 243, shotRate: 0.13580246913580246, goalRate: 0.0411522633744856, meanProgression: 0.5243461434916344 },
  { zone: 6, receptions: 902, shotRate: 0.1197339246119734, goalRate: 0.08314855875831485, meanProgression: -3.2522764896455874 },
  { zone: 7, receptions: 400, shotRate: 0.2825, goalRate: 0.065, meanProgression: -2.403731315879744 },
];

/** V for a position, with the marginal for cells the census could not measure. */
export function valueZoneAt(localX: number, y: number): ValueZoneRow {
  const row = VALUE_ZONE_TABLE_TOPPED[valueZoneIndex(localX, y)];
  return row.receptions >= VALUE_ZONE_SAMPLE_FLOOR ? row : VALUE_ZONE_MARGINAL;
}

/** E5a's V1 floor, frozen in the contract: below this a cell is not a measurement. */
export const VALUE_ZONE_SAMPLE_FLOOR = 400;

/**
 * EDS E5d Phase 1 — the ATTEMPT-VALUE table (commander ruling #18.4).
 * Authority: docs/world-model/EDS-E5D-PHASE1.md
 *
 * The composition is REMOVED, not re-weighted. Where the chooser used to
 * multiply P̂(clean reception) by V̂(shot | clean, cell), it now reads ONE
 * measured quantity:
 *
 *   EV̂ = P(the passing team shoots within 240 ticks OF THE KICK | this pass is
 *          ATTEMPTED, destination cell × threat band)
 *
 * Every fork's window is simulated and counted — clean, spilled, intercepted,
 * never-adjudicated alike — so both E5a defects are structurally impossible
 * here rather than merely absent, and the balls whose value flows through messy
 * paths are priced instead of assumed away (ruling #17.2).
 *
 * Censused on the population it is DEPLOYED on (ruling #18.3's house law, third
 * appearance): licence-triggered decision moments with the full candidate set.
 *
 * Censused at 18,000 licence-triggered moments per set (69,532 attempts),
 * held out against a FRESH 770,000+ split (69,363). Every gate passed: C2
 * calibration on the deployment population reads −0.61pp on the pattern arm and
 * +0.68pp on the control arm, the worst held-out bucket error is 1.23pp against
 * a 5.0pp tolerance, and the axis discriminates 12.56pp.
 *
 * The per-bucket floors below are C3R's (ruling #19.2): a bucket is trusted only
 * once 5.0pp means 3.4σ FOR THAT BUCKET, so the floor tracks the bucket's own
 * rate rather than being one number borrowed from another experiment. Below its
 * floor a bucket takes the cell rung, then the marginal.
 *
 * ATTEMPT TABLE SHA: e0e73505ad36feb2665e9a4229170eec52778e294ca32ead1b1f3aff6296ea6b
 */

export interface AttemptValueRow {
  /** Destination zone 0..7; the CELL and MARGINAL rows use -1 for `band`. */
  readonly cell: number;
  readonly band: number;
  readonly attempts: number;
  readonly shotRate: number;
}

/** The ladder's CELL rung — unchanged from Phase 1's frozen value. */
export const ATTEMPT_VALUE_BUCKET_FLOOR = 200;
export const ATTEMPT_VALUE_CELLS = 8;
export const ATTEMPT_VALUE_BANDS = 5;

/**
 * C3R's per-bucket evidence floors (contract §7.1), frozen from the A-set rates
 * banked in §6.1: n_min = max(200, ceil(2 p (1-p) (3.4/0.05)^2)).
 */
export const ATTEMPT_VALUE_BUCKET_FLOORS: readonly number[] = [
  211, 200, 200, 200, 200, // cell 0
  200, 200, 200, 462, 200, // cell 1
  651, 493, 435, 388, 418, // cell 2
  1074, 923, 610, 529, 450, // cell 3
  883, 1007, 971, 780, 632, // cell 4
  1376, 966, 1034, 1712, 585, // cell 5
  2220, 1958, 1734, 1233, 1032, // cell 6
  1918, 1585, 420, 200, 200, // cell 7
];

export const ATTEMPT_VALUE_TABLE: readonly AttemptValueRow[] = [
  { cell: 0, band: 0, attempts: 2507, shotRate: 0.014758675708017551 },
  { cell: 0, band: 1, attempts: 1192, shotRate: 0.01174496644295302 },
  { cell: 0, band: 2, attempts: 1057, shotRate: 0.000946073793755913 },
  { cell: 0, band: 3, attempts: 860, shotRate: 0.0069767441860465115 },
  { cell: 0, band: 4, attempts: 520, shotRate: 0.0019230769230769232 },
  { cell: 1, band: 0, attempts: 110, shotRate: 0.01818181818181818 },
  { cell: 1, band: 1, attempts: 95, shotRate: 0 },
  { cell: 1, band: 2, attempts: 93, shotRate: 0.010752688172043012 },
  { cell: 1, band: 3, attempts: 103, shotRate: 0.009708737864077669 },
  { cell: 1, band: 4, attempts: 134, shotRate: 0.007462686567164179 },
  { cell: 2, band: 0, attempts: 3637, shotRate: 0.07533681605718999 },
  { cell: 2, band: 1, attempts: 4786, shotRate: 0.058921855411617215 },
  { cell: 2, band: 2, attempts: 5846, shotRate: 0.04772494013000342 },
  { cell: 2, band: 3, attempts: 6212, shotRate: 0.048615582743077916 },
  { cell: 2, band: 4, attempts: 5540, shotRate: 0.04530685920577617 },
  { cell: 3, band: 0, attempts: 2038, shotRate: 0.12659470068694798 },
  { cell: 3, band: 1, attempts: 2263, shotRate: 0.0905877154220062 },
  { cell: 3, band: 2, attempts: 2220, shotRate: 0.07252252252252252 },
  { cell: 3, band: 3, attempts: 2381, shotRate: 0.0621587568248635 },
  { cell: 3, band: 4, attempts: 4452, shotRate: 0.04919137466307277 },
  { cell: 4, band: 0, attempts: 386, shotRate: 0.16062176165803108 },
  { cell: 4, band: 1, attempts: 671, shotRate: 0.13412816691505217 },
  { cell: 4, band: 2, attempts: 956, shotRate: 0.11715481171548117 },
  { cell: 4, band: 3, attempts: 1183, shotRate: 0.0989010989010989 },
  { cell: 4, band: 4, attempts: 1437, shotRate: 0.08002783576896312 },
  { cell: 5, band: 0, attempts: 372, shotRate: 0.1693548387096774 },
  { cell: 5, band: 1, attempts: 316, shotRate: 0.16139240506329114 },
  { cell: 5, band: 2, attempts: 301, shotRate: 0.12956810631229235 },
  { cell: 5, band: 3, attempts: 276, shotRate: 0.14855072463768115 },
  { cell: 5, band: 4, attempts: 263, shotRate: 0.08745247148288973 },
  { cell: 6, band: 0, attempts: 65, shotRate: 0.5846153846153846 },
  { cell: 6, band: 1, attempts: 145, shotRate: 0.4068965517241379 },
  { cell: 6, band: 2, attempts: 317, shotRate: 0.22397476340694006 },
  { cell: 6, band: 3, attempts: 490, shotRate: 0.17142857142857143 },
  { cell: 6, band: 4, attempts: 397, shotRate: 0.12846347607052896 },
  { cell: 7, band: 0, attempts: 383, shotRate: 0.3629242819843342 },
  { cell: 7, band: 1, attempts: 161, shotRate: 0.19254658385093168 },
  { cell: 7, band: 2, attempts: 75, shotRate: 0.17333333333333334 },
  { cell: 7, band: 3, attempts: 28, shotRate: 0.17857142857142858 },
  { cell: 7, band: 4, attempts: 11, shotRate: 0.09090909090909091 },
];

export const ATTEMPT_VALUE_CELL_TABLE: readonly AttemptValueRow[] = [
  { cell: 0, band: -1, attempts: 8988, shotRate: 0.009012016021361816 },
  { cell: 1, band: -1, attempts: 759, shotRate: 0.00922266139657444 },
  { cell: 2, band: -1, attempts: 34365, shotRate: 0.043561763422086425 },
  { cell: 3, band: -1, attempts: 16308, shotRate: 0.06377238165317635 },
  { cell: 4, band: -1, attempts: 5112, shotRate: 0.10289514866979656 },
  { cell: 5, band: -1, attempts: 1598, shotRate: 0.14267834793491865 },
  { cell: 6, band: -1, attempts: 1736, shotRate: 0.195852534562212 },
  { cell: 7, band: -1, attempts: 666, shotRate: 0.28678678678678676 },
];

export const ATTEMPT_VALUE_MARGINAL: AttemptValueRow = {
  cell: -1, band: -1, attempts: 69532, shotRate: 0.056233101305873556,
};

/**
 * The frozen fallback ladder: (cell × band) → cell → marginal. A band of -1
 * means the passer could not read the corridor at all, which sends the option
 * to the cell row rather than inventing a band for it.
 */
export function attemptValueAt(cell: number, band: number): number {
  if (band >= 0) {
    const index = cell * ATTEMPT_VALUE_BANDS + band;
    const bucket = ATTEMPT_VALUE_TABLE[index];
    if (bucket !== undefined && bucket.attempts >= ATTEMPT_VALUE_BUCKET_FLOORS[index]) {
      return bucket.shotRate;
    }
  }
  const row = ATTEMPT_VALUE_CELL_TABLE[cell];
  if (row !== undefined && row.attempts >= ATTEMPT_VALUE_BUCKET_FLOOR) return row.shotRate;
  return ATTEMPT_VALUE_MARGINAL.shotRate;
}

export const THREAT_CALIBRATION: readonly ThreatCalibrationRow[] = [
  {
    quintile: 0,
    n: 2019,
    keyFrom: -2.017366997896862,
    keyTo: 0.038622300107134966,
    realizedSuccess: 0.8286280336800397,
  },
  {
    quintile: 1,
    n: 2019,
    keyFrom: 0.03868202803909754,
    keyTo: 0.2955869871130011,
    realizedSuccess: 0.6230807330361565,
  },
  {
    quintile: 2,
    n: 2019,
    keyFrom: 0.2956539813153475,
    keyTo: 0.5363880087900351,
    realizedSuccess: 0.5096582466567607,
  },
  {
    quintile: 3,
    n: 2019,
    keyFrom: 0.5364606140899261,
    keyTo: 0.805766621095352,
    realizedSuccess: 0.4715205547300644,
  },
  {
    quintile: 4,
    n: 2019,
    keyFrom: 0.806141904559798,
    keyTo: 2.944990072437604,
    realizedSuccess: 0.4314016840019812,
  },
];
