import { clamp, clamp01 } from '../utils/math';
import type { Rng } from '../utils/rng';

/**
 * TacticalGenome — the evolvable "DNA" of a team. Every gene is normalized to
 * [0, 1] and is read directly by the AI layer (TeamBrain / PlayerBrain /
 * formations), so mutations produce visible behavioral change.
 */
export interface TacticalGenome {
  /** Raises pass utility for the ball carrier. */
  passBias: number;
  /** Raises shot utility (shoot-on-sight at 1, shy at 0). */
  shootBias: number;
  /** Raises dribble utility for the ball carrier. */
  dribbleBias: number;
  /** How many players press and how eagerly defenders close down. */
  pressIntensity: number;
  /** Off-ball defenders squeeze toward the ball/center when defending. */
  defensiveCompactness: number;
  /** How wide the team stretches in possession. */
  attackingWidth: number;
  /** Willingness to attempt contested forward passes / long shots. */
  riskTolerance: number;
  /** Attack immediately after winning the ball. */
  counterAttackBias: number;
  /** Jog instead of sprint for low-priority movement, saving stamina. */
  staminaConservation: number;
  /** Tighter marking distance and higher tackle success. */
  markingAggression: number;
  /** Keeper plays further off the line (sweeper at 1). */
  keeperAggression: number;
  /** Overall speed of ball circulation and decision urgency. */
  tempo: number;
  /** How high the whole block sits (0 = deep, 1 = high line). */
  formationDepth: number;
  /** How far away support runs position themselves from the carrier. */
  supportDistance: number;
  /**
   * Rotation appetite (Phase 61, N2): how quickly the coach turns to his
   * bench. Read as a fatigue threshold — 0 rides the starting six into the
   * ground, 1 sends fresh legs at the first sign of tiredness. What the
   * carousel COSTS (bench quality under the roster budget, star minutes)
   * is evolution's to price.
   */
  rotationBias: number;
  /**
   * The underdog shift (Phase 64 — opponent-CONDITIONAL tactics): how far
   * the coach bends toward the bus (deep + compact + counter + risk-off)
   * when OUTGUNNED, read from the Elo gap at kickoff. 0 = the purist who
   * plays his football against anyone; 1 = the full pragmatist. Real
   * leagues' diversity lives here: the bus is what weak teams DO against
   * strong ones, not a fixed identity — whether bending pays is
   * evolution's to discover.
   */
  underdogShift: number;
  /**
   * Match-day adjustment personality (Phase 66, N3): how hard the coach
   * responds to score + clock. Scales the MAGNITUDE of the mentality
   * layer (the chase and the shut-down) — the DIRECTION stays football
   * law, exactly the underdogShift principle. 0 = the stoic who trusts
   * his XI to play their game to the whistle; 0.5 = the Phase-35 curve
   * exactly; 1 = the tinkerer who slams the panic button early and hard.
   * Neither is a virtue: the chase concedes counters, the deep shut-down
   * surrenders initiative — whether meddling pays is evolution's call.
   */
  tinkerBias: number;
  /**
   * The BOARD's recruitment philosophy (Phase 80, N6): how much a signing's
   * personal STYLE FIT (his appetites vs the man he replaces — the club's
   * evolved bloodline for that slot) weighs against raw ability in the
   * fire-sale market. 0 = best man available, damn the system; 1 = system
   * first. Neither is a virtue: the galactico may never suit the shape,
   * the system signing may simply be worse — whether culture-fit
   * recruitment pays is evolution's call.
   */
  fitBias: number;
  /**
   * The DEFENSIVE SCHOOL's first axis (Phase 87, user design — 范戴克式
   * "give-space" modern defending vs the dive-in reflex): how much this
   * team's goal-side contain man JOCKEYS a driving carrier — holds the
   * carrier-goal line at standoff distance, refuses the full-momentum
   * duel, challenges only loose touches — instead of lunging on contact.
   * 0 = the old dive-in school (beaten by pace via the Phase-41 momentum
   * gate); 1 = pure containment (the carrier keeps the ball but never
   * gets the composed 1v1 — a body stays goal-side). Neither is a virtue:
   * containment concedes time and range shots; whether delay beats the
   * duel is evolution's call.
   */
  jockeyBias: number;
  /**
   * The DEFENSIVE SCHOOL's second axis (Phase 88, user design — 意大利链式
   * 防守): where the DF slot sits RELATIVE TO HIS LINE. 1 = the libero,
   * parked behind the beaten line — eats through-balls, meets the carrier
   * who beat the first wave, and (the natural cost) plays everyone ONSIDE,
   * killing his own team's offside trap. 0 = the stopper who steps up to
   * intercept early, gambling the space behind. 0.5 = today's flat line
   * exactly. In possession the same gene sets the rest-defense depth
   * (0.5 = the old hardcoded −12). Whether insurance beats aggression is
   * evolution's call.
   */
  coverBias: number;
  /**
   * THE OFFSIDE TRAP (Phase 109, defensive school #3 — the last of the
   * user's named schools): hold-the-line vs track-the-runner. 1 = the
   * marker REFUSES to be dragged deeper than his shape by a runner — he
   * holds the line laterally and lets the phase-71 offside law flag the
   * man the ball is played to. 0 = track the runner all the way in.
   * 0.5 = today's tracking exactly. The price is honest: a runner ONSIDE
   * at the kick is clean through the held line — and a high coverBias
   * libero sitting below the line plays everyone onside (the natural
   * school tension). Offside does not exist against a CARRIER, so this
   * governs the pass-served pipe only (launch-anatomy.ts has the shares).
   */
  trapBias: number;
  /**
   * MORALE SENSITIVITY (Phase 111, Stage 4 — the first pull item): how
   * much this team's football depends on its CONFIDENCE. Franchise morale
   * (rolling, result-driven, mean-reverting) exists for everyone; this
   * gene prices what it does — 0 = the steady professionals who play the
   * same game at 0-3 down in a slump, 1 = the confidence team whose
   * passing and finishing sharpen on a run and fray in a crisis (both
   * directions, the honest trade: snowball wins bought with fragile
   * slumps). 0.5 = a mild middle. Neither is a virtue — evolution's call.
   */
  moraleSensitivity: number;
  /**
   * THE TRANSITION INSTANT (Phase 112 — the counter-defense audit's hole):
   * what this team does in the 3 seconds AFTER LOSING THE BALL, the mirror
   * of counterAttackBias on the same possession clock. 1 = gegenpress —
   * surge an extra body at the ball and flip into Press before the counter
   * can launch (the price: men committed high are DEAD if the escape pass
   * beats them, and the sprint costs legs). 0 = drop-and-recover — refuse
   * the counter-press entirely (one token chaser), spot-holders SPRINT
   * home and deny the launch window (the price: the winner keeps the ball
   * and arrives organized). 0.5 = today's behavior exactly: the window is
   * whatever steady-state pressIntensity happens to produce.
   * transition-anatomy.ts measured the coupling this gene breaks: the
   * first-3s response was purely a side effect of steady-state pressing
   * (hiPress retreat 2.4-4.8m vs loPress 6-10m) — mid-block sides that
   * counter-press on loss, or high-press sides that drop on loss, could
   * not exist in gene space. 69-78% of breakaways are born in this window.
   */
  transitionPress: number;
  /**
   * THE HOME-PRIOR OBEDIENCE gene (A4-P2, ruling #148 — the pre-match agreement
   * layer 野球开场的"你踢后卫,我顶前面"). How hard this team obeys its own
   * agreed home distribution: each outfielder carries a coarse 2D home centred on
   * HIS formation base spot (the world's own evolved variable), and the eye is
   * softly biased toward it (stationEye.homeMapBias). 0 = no agreement — a team
   * that plays without a shared prior and pays whatever the world charges (the
   * "有的队不夹击,活该" genre); 1 = the certified strength ceiling
   * (HOME_MAP_STRENGTH_MAX = 0.5×VAL_SCALE). A4-P1e CERTIFIED a resolved
   * discipline benefit across (0, 0.5]×VAL_SCALE — 松约定有价 — with the primary
   * (0.25×) at obedience 0.5. The value in [0,1] scales LINEARLY onto strength via
   * homePriorStrength().
   *
   * ⚠ DORMANT / BORN 0 (RNG-STREAM SAFETY, #148.5 the #75 genre): this gene is
   * OPTIONAL and BORN ABSENT (≡ 0 at every consumer via `?? 0`). It is deliberately
   * NOT in GENE_KEYS — so randomGenome/mutateGenome/crossoverGenomes/geneDistance
   * draw the EXACT SAME RNG in the EXACT SAME order as HEAD, and the serialized
   * genome (and thus the production fingerprint 57b0bdab…c673) is byte-identical
   * (an absent optional key is omitted by JSON.stringify). It gains a concrete
   * value ONLY when an evolution run explicitly opts in via `evolveHomePrior`
   * (MutateOptions / crossoverGenomes); the consumption path is itself gated by the
   * dormant `eye.v4.homePrior` master flag. Every draw for this gene is thus
   * flag-gated — flag-off evolution never consumes RNG for it. (§2 M2′ / I-A3 /
   * I-A5 / I-A7.)
   */
  homePriorObedience?: number;
  /**
   * A4 SLICE 2, S2-P2 (A4-SLICE2-PERBODY-CONTRACT §2 M-S2.1, ruling #164.3) — THE
   * PER-BODY OBEDIENCE OFFSET GENE FAMILY (每个人自己的"该往哪走"): one bounded
   * offset per SQUAD SLOT, so each body has his OWN relationship to the team's
   * kickoff agreement (the user's 爱压上的后卫和爱回撤的前锋, VISION §1) instead of
   * the uniform whisper every body currently shares. Effective per-body obedience =
   * `clamp01(homePriorObedience + offset_i)` (`effectiveHomePriorObedience` below),
   * consumed through the SAME `homePriorStrength` map at the SAME `eye.v4.homePrior`
   * seam — NO new consumer mechanism (M-S2.2).
   *
   * ⚠ BORN ABSENT (contract §3 BIRTH NEUTRALITY, the §8 audit's one live-risk
   * clause): `undefined` ⇒ every offset reads 0 ⇒ effective obedience is the team
   * whisper ⇒ BIT-IDENTICAL to the slice-1 world. NO role-derived birth content
   * exists anywhere in `src/**` — no "defenders born obedient" (= 替球队定X,
   * REJECTED ex ante); differentiation is EARNED by selection or granted only
   * inside instruments. The array, when present, is indexed by SQUAD SLOT and
   * carries no role knowledge: every slot is mutated by the same law.
   *
   * ⚠ RNG-STREAM SAFETY (the #148.5 / #75 genre, mirrored verbatim from
   * `homePriorObedience`): OPTIONAL, deliberately NOT in GENE_KEYS, and gated behind
   * its OWN explicit `evolveHomePriorOffsets` opt-in (an own named boolean per #75 —
   * NOT a widening of `evolveHomePrior`, so even a flag-ON home-prior evolution run's
   * draw sequence is unmoved). Its draws happen STRICTLY AFTER the `homePriorObedience`
   * block, so enabling it never re-orders an existing draw; flag-off evolution consumes
   * ZERO RNG for it and an absent optional key is omitted by JSON.stringify (the
   * production fingerprint 57b0bdab…c673 stands).
   */
  homePriorObedienceOffset?: readonly number[];
  /**
   * PM-T0 (PHASE-MODULATION-CONTRACT §2 M-PM.1, ruling #195.2) — THE DEFENSIVE
   * LANE-CONVERGENCE gene (位置是活的:守→向球侧压缩/弱侧收窄). How hard THIS team's
   * out-of-possession station field asks each body to converge on the BALL'S LANE:
   * in the defensive phase the emergent station's lateral value gets, AFTER the
   * existing width and common-translation terms (replacing neither),
   * `y += (ball.pos.y − y) · k_PM` with `k_PM = defLaneConvergence ·
   * PM_LANE_CONVERGENCE_MAX` (see `pmLaneConvergenceK`). 0 = today's world exactly
   * (keep width, translate the block); 1 = the frozen ceiling below.
   *
   * An affine contraction with `k_PM < 1` preserves lateral ORDER — it shrinks
   * gaps, it cannot cross bodies over. There is NO role gating and NO per-body
   * offset in this slice (offsets = a later slice, the A4-S2 precedent), and the
   * term reads `ball.pos.y` only — an input the adjacent station line already
   * consumes (M-PM.4 perception honesty, no new channel).
   *
   * ⚠ DORMANT / BORN ABSENT (RNG-STREAM SAFETY, the #148.5 / #75 genre, mirrored
   * verbatim from `homePriorObedience`): OPTIONAL and BORN ABSENT (≡ 0 at its one
   * consumer via `?? 0`), deliberately NOT in GENE_KEYS — so randomGenome /
   * mutateGenome / crossoverGenomes / geneDistance draw the EXACT SAME RNG in the
   * EXACT SAME order as HEAD, and the serialized genome (hence the production
   * fingerprint 57b0bdab…c673) is byte-identical (an absent optional key is
   * omitted by JSON.stringify). It gains a value ONLY when an evolution run opts
   * in via its OWN explicit `evolveDefLaneConvergence` boolean (#75: never a
   * widening of `evolveHomePrior`/`evolveHomePriorOffsets`, so those runs' draw
   * sequences are unmoved), and its draws happen STRICTLY AFTER both home-prior
   * blocks, so enabling it never re-orders an existing draw. The CONSUMPTION path
   * is separately gated by the dormant `pmLaneConvergence` match flag — every
   * draw AND every read is thus flag-gated.
   */
  defLaneConvergence?: number;
  /**
   * MT-T0 (MARK-TIGHTNESS-CONTRACT §2 M-MT.1–3, ruling #201.4) — THE MARK-SAG gene
   * (盯防松紧: 真实后卫算的是时间账, 输出是松紧不是开关). How hard THIS team prices
   * the ACCESS-TIME ACCOUNT into the mark STANCE distance: out of possession, in
   * live open play, a marker with an assigned mark stands
   * `markDist′ = markDist + markSag · sagOf(slack)` on the EXISTING (mark→goal,
   * mark→ball) blend, where `slack = t_ball − t_self` (see `markSagMetres` in
   * `src/ai/actionExecutor.ts`). 0 = today's stance exactly; 1 = the frozen ceiling
   * `MARK_SAG_MAX` metres of sag at maximal slack.
   *
   * The output is CONTINUOUS tightness and NOTHING else: there is NO decline /
   * release / "放人" predicate anywhere (the #200 red line), the direction blend and
   * `laneW` are untouched, mark ASSIGNMENT (`assignMarks`) is untouched, and
   * `markingAggression` keeps its own fixed-tightness preference and its triple
   * coupling. The term only ever ADDS distance above the existing stance floor
   * (Phase 30.5) and above the Phase 31.6 distribution stand-off — it can never
   * tighten, so both prior stance reverts are respected by construction. The box
   * PRICES ITSELF: a ball 1–2 s away leaves `slack ≤ 0` ⇒ zero sag ⇒ tight marking,
   * with no carve-out.
   *
   * ⚠ DORMANT / BORN ABSENT (RNG-STREAM SAFETY, the #148.5 / #75 genre, mirrored
   * verbatim from `defLaneConvergence`): OPTIONAL and BORN ABSENT (≡ 0 at its one
   * consumer via `markSagWeight`), deliberately NOT in GENE_KEYS — so randomGenome /
   * mutateGenome / crossoverGenomes / geneDistance draw the EXACT SAME RNG in the
   * EXACT SAME order as HEAD, and the serialized genome (hence the production
   * fingerprint 57b0bdab…c673) is byte-identical (an absent optional key is omitted
   * by JSON.stringify). It gains a value ONLY when an evolution run opts in via its
   * OWN explicit `evolveMarkSag` boolean (#75: never a widening of any existing
   * opt-in), and its draws happen STRICTLY AFTER the `defLaneConvergence` block —
   * hence after both home-prior blocks too — so enabling it never re-orders an
   * existing draw. The CONSUMPTION path is separately gated by the dormant
   * `mtMarkSag` match flag — every draw AND every read is thus flag-gated.
   */
  markSag?: number;
  /**
   * CTB-T0 (CHECK-TO-BALL-CONTRACT §2 M-CTB.1, ruling #223) — THE SUPPORT-PLANE
   * DEPTH axis (回撤接应的「前后」). A SIGNED continuous shift of the support seat's
   * ahead-bias, centred EXACTLY on the incumbent mode ternary (0.75 attacking /
   * 0.35 otherwise), which is ABSORBED as the zero-point rather than deleted:
   * `aheadBias′ = aheadBias + ctbSupportDepth · CTB_DEPTH_BIAS_SPAN`
   * (see `supportSpot` / `CTB_DEPTH_BIAS_SPAN` in `src/ai/formations.ts`).
   * 0 = today's world exactly. NEGATIVE reach is the whole point: at
   * `aheadBias′ = 0` the supporter stands LEVEL with the ball and below it he
   * shows BEHIND the ball — positions no genome in the shipped space can express
   * today (the contract §0.3 code fact: 缺一条腿, 不是缺一个习惯).
   *
   * SIGNED domain [−1, +1] (not [0,1] like GENE_KEYS): the axis is a deformation
   * around an incumbent centre, so its zero must be interior. NO predicate reads
   * it and it decides nothing (the #200 red line): the shift is unconditional
   * geometry, applied on every support tick when the seam is armed.
   *
   * ⚠ DORMANT / BORN ABSENT (RNG-STREAM SAFETY, the #148.5 / #75 genre, mirrored
   * verbatim from `markSag`): OPTIONAL and BORN ABSENT (≡ 0 at its one consumer via
   * `ctbSupportDepthWeight`), deliberately NOT in GENE_KEYS — so randomGenome /
   * mutateGenome / crossoverGenomes / geneDistance draw the EXACT SAME RNG in the
   * EXACT SAME order as HEAD, and the serialized genome (hence the production
   * fingerprint 57b0bdab…c673) is byte-identical (an absent optional key is omitted
   * by JSON.stringify). It gains a value ONLY when an evolution run opts in via the
   * OWN explicit `evolveCtbSupportPlane` boolean (#75: never a widening of any
   * existing opt-in), and its draws happen STRICTLY AFTER the `markSag` block —
   * hence after the `defLaneConvergence` and both home-prior blocks too — so
   * enabling it never re-orders an existing draw. The CONSUMPTION path is separately
   * gated by the dormant `ctbSupportPlane` match flag.
   */
  ctbSupportDepth?: number;
  /**
   * CTB-T0 (CHECK-TO-BALL-CONTRACT §2 M-CTB.1, ruling #223) — THE SUPPORT-PLANE
   * WIDTH axis (回撤接应的「左右」). A SIGNED continuous deformation of the lateral
   * fan, applied as ONE coherent scale to BOTH incumbent fan constants at once:
   * `widthScale = 1 + ctbSupportWidth`, then
   * `pull′ = SUPPORT_LAT_PULL · widthScale` and
   * `cap′  = radius · SUPPORT_LAT_CAP_FRAC · widthScale`
   * (see `supportSpot` in `src/ai/formations.ts`). 0 = today's fan exactly
   * (`widthScale = 1`); −1 collapses the fan onto the BALL'S OWN LANE (pull 0,
   * cap 0 — the narrowest expressible support, right next to the carrier); +1
   * doubles both, a fan reaching for the touchline. The deformation is COHERENT by
   * construction — one gene, one factor on both constants — so the fan's shape is
   * preserved and only its scale moves; `widthScale ≥ 0` always, so the lateral
   * pull can never invert its sign.
   *
   * SIGNED domain [−1, +1], the same interior-zero reason as `ctbSupportDepth`.
   * NO predicate reads it (#200): unconditional geometry, nothing decided.
   *
   * ⚠ DORMANT / BORN ABSENT — identical birth discipline to `ctbSupportDepth`
   * above (outside GENE_KEYS, `evolveCtbSupportPlane` opt-in, draws strictly after
   * the `markSag` block, consumption gated by `ctbSupportPlane`).
   */
  ctbSupportWidth?: number;
  /**
   * OBM-T0 (OFFBALL-MOVEMENT-CONTRACT §2 M-OBM.3, ruling #227) — THE OFF-BALL
   * MOVEMENT POLICY MATRIX (前插与回撤是同一个选择). A flat, row-major
   * `OBM_OUTPUT_KEYS.length × OBM_FEATURE_KEYS.length` weight matrix
   * (`OBM_WEIGHT_SLOTS` entries, index `output * OBM_FEATURE_KEYS.length + feature`)
   * mapping the four PERCEIVED features to the four continuous outputs — see
   * `src/ai/offballEyes.ts` for the law and `OBM_WEIGHT_MIN/MAX` below for the
   * domain.
   *
   * Everything is `weight × continuous feature`; NO predicate reads it and it
   * decides nothing (the #200 red line). 前插 / 回撤 is written nowhere: it is
   * where the evolved weights put a body when the carrier's plight rises and his
   * own marker loosens. ALL-ZERO ⇒ today's world EXACTLY (the outputs are `+0`
   * and `×1`, exact in IEEE-754).
   *
   * ⚠ DORMANT / BORN ABSENT — identical birth discipline to the `ctbSupport*` pair
   * above (outside GENE_KEYS, so `randomGenome` / `mutateGenome` /
   * `crossoverGenomes` / `geneDistance` draw the EXACT same rng in the EXACT same
   * order as HEAD and `JSON.stringify` omits the key, hence the production
   * fingerprint is byte-identical). It gains values ONLY under its OWN explicit
   * `evolveOffballMovement` boolean (#75), whose draws sit STRICTLY AFTER the
   * `ctbSupportPlane` block — hence after `markSag`, `defLaneConvergence` and both
   * home-prior blocks — so enabling it never re-orders an existing draw. The
   * CONSUMPTION path is separately gated by the dormant `obmMovement` match flag.
   */
  offballMovementWeights?: number[];
  /**
   * PTP-T0 (PASS-TO-PATH-CONTRACT §2 M-PTP.2, ruling #231) — THE PASS-LEAD TRUST
   * (传球到路). ONE team-level scalar in [0, 1]: how much of a SUPPORT-mode mate's
   * projected displacement over the pass flight the carrier's pass model aims at.
   *
   * `aim = mate.pos + passLeadSupport · projectedDisplacement(mate, flight)` — see
   * `src/ai/passLeadSeat.ts` for the law and the two traced constants it reuses.
   * 0 = to feet = today's arithmetic EXACTLY (`x + 0`, an IEEE-754 identity), which
   * is what G-ZERO measures rather than asserts.
   *
   * NO predicate reads it (#200): the lead is unconditional geometry × gene, so a
   * STILL mate's led point IS his feet (his displacement is zero) — to-feet EMERGES,
   * it is never branched on.
   *
   * ⚠ DORMANT / BORN ABSENT — identical birth discipline to the `ctbSupport*` pair
   * and the OBM matrix above (outside GENE_KEYS, so `randomGenome` / `mutateGenome` /
   * `crossoverGenomes` / `geneDistance` draw the EXACT same rng in the EXACT same
   * order as HEAD and `JSON.stringify` omits the key, hence the production
   * fingerprint is byte-identical). It gains values ONLY under its OWN explicit
   * `evolvePassLeadSupport` boolean (#75), whose draws sit STRICTLY AFTER the
   * `offballMovementWeights` block — hence after `ctbSupportPlane`, `markSag`,
   * `defLaneConvergence` and both home-prior blocks. The CONSUMPTION path is
   * separately gated by the dormant `ptpPassLead` match flag.
   */
  passLeadSupport?: number;
  /**
   * DV-T0 (DELIVERY-VALUE-CONTRACT §2 M-DV.1/M-DV.3, rulings #245/#249) — THE FLIGHT-
   * EXPOSURE CARE WEIGHT (出球风险). ONE team-level scalar in [0, 1]: how much of the
   * measured flight exposure of a delivery this team subtracts from its price.
   *
   * `score′ = score − dvExposureWeight · exposure(from, aim) − …` — see
   * `src/ai/deliveryValueSeat.ts` for the law and the three traced constants it reuses.
   * 0 = today's map EXACTLY (`s − (+0)`, an IEEE-754 identity), which is what G-ZERO
   * measures rather than asserts.
   *
   * NO predicate reads it (#200): the exposure is unconditional geometry × time × gene.
   *
   * ⚠ DORMANT / BORN ABSENT — identical birth discipline to `passLeadSupport` above
   * (outside GENE_KEYS, so `randomGenome` / `mutateGenome` / `crossoverGenomes` /
   * `geneDistance` draw the EXACT same rng in the EXACT same order as HEAD and
   * `JSON.stringify` omits the key, hence the production fingerprint is byte-identical).
   * It gains values ONLY under its OWN explicit `evolveDeliveryValue` boolean (#75),
   * whose draws sit STRICTLY AFTER the `passLeadSupport` block. The CONSUMPTION path is
   * separately gated by the dormant `dvDeliveryValue` match flag.
   */
  dvExposureWeight?: number;
  /**
   * ⭐⭐ DV-T0 (DELIVERY-VALUE-CONTRACT §2 M-DV.2 **as amended by ruling #247**) — THE
   * LOSS-COST BELIEF (丢球的价钱, 挣来的). `DV_BELIEF_SLOTS` weights in [0, 1], one per
   * pitch third in the FROZEN order `['own', 'middle', 'final']` (the DV-C0 census's own
   * zoning, in the LOSING team's frame), applied to the RECEPTION zone of the candidate
   * being priced.
   *
   * ⭐⭐ THIS IS THE PROGRAMME'S FIRST EVOLVABLE WORLD-PRICE BELIEF (#248.2(v)), and it
   * is a BELIEF, not knowledge: the census's TRUE table stays instrument-side, no code
   * path reads it, and a team is BORN KNOWING NOTHING about what losing the ball
   * anywhere costs. Teams EARN the map by being punished (the goals channel); a wrong
   * belief is legal and is STYLE. DV-T2 measures whether evolution FINDS the map,
   * against DV-C0's frozen convergence yardstick (which lives with the instrument).
   *
   * ALL-ZERO ⇒ today's map EXACTLY (the term is `+0`, exact in IEEE-754).
   *
   * ⚠ DORMANT / BORN ABSENT — identical birth discipline to the OBM matrix and
   * `passLeadSupport` above. It gains values ONLY under the SAME explicit
   * `evolveDeliveryValue` boolean as `dvExposureWeight` (one opt-in for one map plus
   * the care that reads it — DV-T2 selects on them together), whose draws sit STRICTLY
   * AFTER the `passLeadSupport` block, exposure first then the three slots in zone
   * order, so enabling it never re-orders an existing draw.
   */
  dvLossBelief?: number[];
  /**
   * ⭐⭐ CB-T2 (CB-CARRY-BEAT-CONTRACT §2 M-CB.2, ruling #268.4) — THE CARRY-PRONENESS
   * STYLE WEIGHT (敢不敢过人). ONE team-level scalar in [0, 1]: how much of a touch-past's
   * OWN delivery price this team is willing to pay for the option of beating a man.
   *
   * `score_knock = groundCandidate(the knock's own reception point) · cbCarryProneness` —
   * see `src/ai/carryChoiceSeat.ts` for the candidates and `PlayerBrain` for the ONE
   * table they enter. The contract calls this the **riskTolerance FAMILY**: a taste, in
   * the same unsigned [0,1] domain as the shipped genes, and it is STYLE — a team that
   * never knocks and a team that always knocks are both legal football.
   *
   * ⭐ THE NEUTRAL FORM IS DERIVED, NOT CHOSEN. Absent ⇒ no seat ⇒ no candidate is even
   * formed. Requiring the PRESENT-AT-ZERO world to equal that absent world is what forces
   * the appetite to enter MULTIPLICATIVELY (at 0 every knock prices to exactly `0`, and
   * the candidate table's own ordering — the knock is pushed LAST, so a tie resolves to
   * the incumbent — means it can never be chosen). No weight, no base, no width: the gene
   * IS the multiplier, so this stage adds no taste constant of any kind (#200). The
   * identity is MEASURED (G-ZERO), not assumed.
   *
   * NO predicate reads it (#200): it scales a price, it never gates an action.
   *
   * ⚠ DORMANT / BORN ABSENT — identical birth discipline to `dvExposureWeight` above
   * (outside GENE_KEYS, so `randomGenome` / `mutateGenome` / `crossoverGenomes` /
   * `geneDistance` draw the EXACT same rng in the EXACT same order as HEAD and
   * `JSON.stringify` omits the key, hence the production fingerprint is byte-identical).
   * It gains values ONLY under its OWN explicit `evolveCarryChoice` boolean (#75), whose
   * draws sit STRICTLY AFTER the delivery-value block. The CONSUMPTION path is separately
   * gated by the dormant `cbChoiceSeat` match flag, which additionally requires CB-T0's
   * `cbTouchPast` door for a chosen knock to be able to fire at all.
   *
   * ⚠ NO EVOLUTION EXAM RIDES HERE (#268.4): the gene exists and is plumbed; whether
   * selection FINDS a dribbling style is a later arc's question.
   */
  cbCarryProneness?: number;
  /**
   * ⭐⭐ RA-T0 (docs/world-model/RA-T0-DORMANT-SEAM.md; rulings #358/#359/#360 — the
   * user's fork election 「①′ 接应时间入价」) — THE RECEIVER-ACCESS CARE WEIGHT
   * (接应时间的价钱). ONE team-level scalar in [0, 1]: how much of a delivery's
   * receiver-access DEFICIT — the seconds by which the intended receiver's own
   * chase arithmetic says he MISSES the elected point — this team subtracts from
   * its price.
   *
   * `score′ = score − raAccessWeight · deficit(E) · passBase` — see
   * `src/ai/receiverAccessSeat.ts` for the law and the traced account it reuses
   * (DX-C2 §P.A byte for byte: the chooser's own flight law over `interceptBall`'s
   * own time-to-point form, with the `CONTROL_RADIUS` presence clause). 0 = today's
   * map EXACTLY (`s − (+0)`, an IEEE-754 identity), which is what G-ZERO measures
   * rather than asserts. Selection sizes the price; we don't (#360 item 3(ii)).
   *
   * NO predicate reads it (#200): the deficit is unconditional geometry × time × gene.
   *
   * ⚠ DORMANT / BORN ABSENT — identical birth discipline to `cbCarryProneness` above
   * (outside GENE_KEYS, so `randomGenome` / `mutateGenome` / `crossoverGenomes` /
   * `geneDistance` draw the EXACT same rng in the EXACT same order as HEAD and
   * `JSON.stringify` omits the key, hence the production fingerprint is byte-identical).
   * It gains values ONLY under its OWN explicit `evolveReceiverAccess` boolean (#75),
   * whose draws sit STRICTLY AFTER the carry-choice block — i.e. after every existing
   * block. The CONSUMPTION path is separately gated by the dormant `raAccessPrice`
   * match flag.
   */
  raAccessWeight?: number;
  /**
   * ⭐⭐ RC-T0 (docs/world-model/RC-T0-PRECUE-SEAM.md; ruling #369 item 6; contracts
   * RC-RECEIVER-COOPERATION-CONTRACT.md §2 M-RC.4 + §2-AMENDMENT M-RC.3a and
   * PC-PERCEPTION-CONTRACT.md §2-AMENDMENT M-PC.1b) — THE ANTICIPATION WEIGHT
   * (接球人有多信出球人的身体). ONE team-level scalar in [0, 1]: how much a receiver TRUSTS
   * the outward cue that the passer's body was squared up to HIM, spent on the ONE thing the
   * pre-cue can buy — the length of his own `passRelease` reaction hold:
   *
   *   ticks = book covers ? SIMPLE : round(SIMPLE + (CHOICE − SIMPLE) · (1 − w · belief))
   *
   * with `belief` RC-C0's OWN measured table over his alignment RANK
   * (`src/ai/receiverAnticipationSeat.ts`) and SIMPLE/CHOICE the two certified PC tiers. At
   * `w = 0` the expression returns the CHOICE tier EXACTLY, which is today's world (G-ZERO
   * measures it rather than asserting it); absent ⇒ no seat is formed at all (G-BORN).
   * Selection sizes how much a receiver trusts a body cue; we don't (#200 — no taste constant
   * enters: the endpoints are certified, the table is measured, the trust is this gene).
   *
   * NO predicate reads it (#200): it scales a hold length, it never gates an action.
   *
   * ⚠ DORMANT / BORN ABSENT — identical birth discipline to `raAccessWeight` above (outside
   * GENE_KEYS, so `randomGenome` / `mutateGenome` / `crossoverGenomes` / `geneDistance` draw
   * the EXACT same rng in the EXACT same order as HEAD and `JSON.stringify` omits the key,
   * hence the production fingerprint is byte-identical). It gains values ONLY under its OWN
   * explicit `evolveReceiverAnticipation` boolean (#75), whose draws sit STRICTLY AFTER the
   * receiver-access block — i.e. after every existing block. The CONSUMPTION path is
   * separately gated by the dormant `rcAnticipate` match flag.
   */
  rcAnticipationWeight?: number;
  /**
   * ⭐⭐ LN-T0 (LN-OWN-LANE-CONTRACT.md §2 M-LN.2; ruling #393 item 5(ii)) — THE OWN-LANE
   * WEIGHT (让传球者看见自己人). How much this side's passers care that one of THEIR OWN men is
   * standing in the lane they are about to strike:
   *
   *   price = w · (1 − ownLaneOpenness(from, aim, own outfield − passer − target))
   *
   * subtracted from the score at the lane argmax and at the kick-off play-back scorer, and
   * applied as the factor `(1 − price)` to each EXECUTABLE option's price at the perceived
   * chooser (`src/ai/ownLaneSeat.ts` owns the read and the arithmetic). At `w = 0` every one
   * of those is an IEEE-exact identity — the subtraction of `+0` and the multiplication by
   * `1` — which is today's world (the identity pin MEASURES that rather than asserting it).
   * Selection sizes how much a side looks for its own men; we don't (#200 — no taste
   * constant enters: the geometry is the shipped `laneOpenness`, the care is this gene).
   *
   * NO predicate reads it (#200): it prices a line, it never bans one.
   *
   * ⚠ DORMANT / BORN ABSENT — identical birth discipline to `raAccessWeight` above (outside
   * GENE_KEYS, so `randomGenome` / `mutateGenome` / `crossoverGenomes` / `geneDistance` draw
   * the EXACT same rng in the EXACT same order as HEAD and `JSON.stringify` omits the key,
   * hence the production fingerprint is byte-identical). ⛔ NO `evolve*` opt-in exists for it
   * yet: evolution's opt-in is a LATER SLICE, so today it gains a value only from an
   * instrument's effective genome. The CONSUMPTION path is separately gated by the dormant
   * `lnOwnLanePrice` match flag.
   */
  lnOwnLaneWeight?: number;
}

/**
 * ⭐ THE FROZEN `t_ball` SPEED (MT-T0, contract §2 M-MT.1 "from the engine's EXISTING
 * kick/pass speed constant family — traced and frozen at MT-T0, no invented speeds").
 *
 * TRACED, NOT INVENTED. `16` is the engine's OWN pass FLIGHT-TIME constant — the one
 * number it already uses to turn a pass distance into a travel time, in
 * `src/sim/mechanics.ts` `performPass`:
 * `const flight = dist(passer.pos, mate.pos) / (16 * powerMul);`
 * The access-time account asks exactly that question ("how long would the ball take
 * to reach my man"), so the family member is chosen by QUESTION IDENTITY, not by
 * picking a bound: the ordinary ground-pass estimator is the only member of the
 * family that answers it. (For the record, the rest of the family: the cutback
 * estimator uses `18` at `mechanics.ts:662`; executed ground-pass strike speeds live
 * in `clamp(d·0.6 + 8.2, 9, 22)` at `mechanics.ts:377`, a band this 16 sits inside;
 * `SHOT_SPEED = 27` is a shot, not a pass.) `powerMul` is deliberately NOT read here
 * — it is a property of a specific passer's body orientation and chosen weight, and
 * M-MT.5 fixes the account at geometry only.
 *
 * Never re-cut: if MT-T1 needs a different speed, that is a fork for the commander
 * WITH numbers, not a quiet re-freeze after sight. `markSagGene.test.ts` and the
 * MT-T0 probe both assert the source line VERBATIM, so the family cannot drift.
 */
export const MARK_SAG_BALL_SPEED = 16;

/**
 * ⭐ THE FROZEN SAG CEILING (MT-T0, contract §2 M-MT.2 "capped by a frozen ceiling
 * from a traced family — the 9 m zonal engagement radius is the named neighbour").
 *
 * TRACED, NOT INVENTED. `9` is the ZONAL ENGAGEMENT RADIUS in `assignMarks` —
 * `src/ai/TeamBrain.ts:580` (re-pointed by ruling #323 §CORR 2; DF-T0 shifted the file,
 * the rule text is byte-unmoved):
 * `if (zones && !boxThreat && dist(zones.get(p.index)!, threat.pos) > 9) continue;`
 * — i.e. the engine's own standing answer to "how far from his station may a
 * defender be asked to engage a man". Sag is exactly that: how far off his man a
 * marker may stand and still be marking him. So the new axis can express EXACTLY as
 * much slack as the engine already prices for engagement, and no more. No new
 * constant is introduced by this slice.
 */
export const MARK_SAG_MAX = 9;

/**
 * MT-T0 (M-MT.3): the gene → weight map, the SINGLE owner of the expression.
 * Born absent ⇒ `0` ⇒ the sag term vanishes ⇒ byte-identical world. PURE, no rng.
 * Clamped to [0,1], so no instrument can dose past the frozen ceiling through this
 * door (the sag itself is capped at `MARK_SAG_MAX` in `markSagMetres`).
 */
export function markSagWeight(g: TacticalGenome): number {
  const v = g.markSag;
  if (v === undefined || !Number.isFinite(v)) return 0;
  return clamp01(v);
}

/**
 * ⭐ CTB-T0 (M-CTB.1): THE SIGNED GENE DOMAIN for the support-plane axis pair.
 *
 * The GENE_KEYS family lives in [0,1] because each of those genes runs from "none"
 * to "most". These two do not: they are DEFORMATIONS around an incumbent centre
 * (the ahead-bias ternary; the fan constants), so their zero must be INTERIOR and
 * their reach must be SIGNED — that is exactly what makes level-with/behind-the-ball
 * expressible (the contract §0.3 defect). ±1 is a domain, not a geometry constant:
 * the metric bounds are the traced spans in `src/ai/formations.ts`
 * (`CTB_DEPTH_BIAS_SPAN` from the incumbent lateral cap fraction; the width axis'
 * span IS each incumbent fan constant itself). The `homePriorObedienceOffset`
 * family's ±0.5 `clampOffset` is the precedent for a signed clamp living here.
 */
export const CTB_GENE_MIN = -1;
export const CTB_GENE_MAX = 1;
const clampSignedUnit = (v: number): number => clamp(v, CTB_GENE_MIN, CTB_GENE_MAX);

/**
 * CTB-T0 (M-CTB.1): the DEPTH gene → weight map, the SINGLE owner of the expression.
 * Born absent ⇒ `0` ⇒ `aheadBias′ === aheadBias` ⇒ byte-identical world. PURE, no rng.
 * Clamped to [−1,1], so no instrument can dose past the frozen span through this door.
 */
export function ctbSupportDepthWeight(g: TacticalGenome): number {
  const v = g.ctbSupportDepth;
  if (v === undefined || !Number.isFinite(v)) return 0;
  return clampSignedUnit(v);
}

/**
 * CTB-T0 (M-CTB.1): the WIDTH gene → weight map, the SINGLE owner of the expression.
 * Born absent ⇒ `0` ⇒ `widthScale === 1` ⇒ byte-identical world. PURE, no rng.
 * Clamped to [−1,1], so the coherent fan scale stays in [0,2] and can never invert.
 */
export function ctbSupportWidthWeight(g: TacticalGenome): number {
  const v = g.ctbSupportWidth;
  if (v === undefined || !Number.isFinite(v)) return 0;
  return clampSignedUnit(v);
}

/**
 * ⭐ OBM-T0 (M-OBM.2/M-OBM.3): THE POLICY MATRIX SHAPE — four PERCEIVED features
 * (rows of the input vector) × four continuous OUTPUTS. Named, not numbered: the
 * matrix size is DERIVED from these two lists in code, so no count is ever typed.
 *
 * The feature families are the contract's own §2 M-OBM.2 list and are declared as
 * slice-one BOUNDS, not an exhaustive account of what a footballer reads.
 */
export const OBM_FEATURE_KEYS = [
  'carrierPlight', // f1 — perceived opponents closing his perceived carrier
  'ownMarker', //     f2 — nearest perceived opponent to himself
  'targetCongestion', // f3 — nearest perceived opponent to his candidate target
  'readingAge', //    f4 — the AGE of his own readings (staleness IS data)
] as const;
export const OBM_OUTPUT_KEYS = [
  'planeDepth', //   the CTB plane's 前后 axis (dynamic shift on the banked limb)
  'planeWidth', //   the CTB plane's 左右 axis
  'supportScore', // the `SupportBallCarrier` candidate score
  'runScore', //     the LICENSED `MakeRun` candidate score
] as const;
export const OBM_WEIGHT_SLOTS = OBM_OUTPUT_KEYS.length * OBM_FEATURE_KEYS.length;

/**
 * ⭐ OBM-T0 (M-OBM.3): THE WEIGHT DOMAIN — the SIGNED unit domain, DERIVED IN CODE
 * from the CTB plane's own deformation-gene domain (`CTB_GENE_MIN/MAX`).
 *
 * TRACED by QUESTION IDENTITY, never invented: these weights deform the SAME plane
 * around the SAME incumbent centres that the banked axis pair deforms, so one
 * weight may express exactly as much as one static axis gene already expresses,
 * and no more. Signed because a policy must be able to pull a body BACK as readily
 * as it pushes him ON — that symmetry is the whole content of 前插与回撤是同一个选择.
 */
export const OBM_WEIGHT_MIN = CTB_GENE_MIN;
export const OBM_WEIGHT_MAX = CTB_GENE_MAX;

/**
 * OBM-T0 (M-OBM.3): the matrix → weight-vector map, the SINGLE owner of the
 * expression. Born absent ⇒ ALL ZERO ⇒ every output is `+0` / `×1` ⇒ a
 * byte-identical world. PURE, no rng. Each slot is clamped to the signed domain,
 * so no instrument can dose past the frozen bound through this door; a short,
 * long, or non-finite array is read slot by slot with the same zero guard, so a
 * malformed genome degrades to NEUTRAL rather than to nonsense.
 */
export function offballMovementWeightVector(g: TacticalGenome): number[] {
  const raw = g.offballMovementWeights;
  const out = new Array<number>(OBM_WEIGHT_SLOTS).fill(0);
  if (raw === undefined || !Array.isArray(raw)) return out;
  for (let i = 0; i < OBM_WEIGHT_SLOTS; i++) {
    const v = raw[i];
    if (v === undefined || !Number.isFinite(v)) continue;
    out[i] = clampSignedUnit(v);
  }
  return out;
}

/**
 * PTP-T0 (M-PTP.2): the pass-LEAD gene → weight map, the SINGLE owner of the
 * expression. Born absent ⇒ `0` ⇒ the projection term is exactly `+0` ⇒ the ordinary
 * pass loop's arithmetic is byte-identical (to feet). PURE, no rng. Clamped to [0,1]
 * — the domain is UNSIGNED because this gene runs from "none" (feet) to "the whole
 * projected displacement" (path); a negative lead would aim BEHIND a moving mate,
 * which is not a footballing choice, it is a mistake.
 */
export function passLeadSupportWeight(g: TacticalGenome): number {
  const v = g.passLeadSupport;
  if (v === undefined || !Number.isFinite(v)) return 0;
  return clamp01(v);
}

/**
 * ⭐ DV-T0 (M-DV.2 as amended by #247): the loss-cost BELIEF's frozen width — one weight
 * per pitch third, in the DV-C0 census's own zone order (`own`, `middle`, `final`). It is
 * the census's ZONING (the shape of the question) and NOT its hazards (the answers,
 * which stay instrument-side and are never wired into a player).
 */
export const DV_BELIEF_SLOTS = 3;

/**
 * DV-T0 (M-DV.3): the flight-EXPOSURE care gene → weight map, the SINGLE owner of the
 * expression. Born absent ⇒ `0` ⇒ the exposure term is exactly `+0` ⇒ the delivery
 * pricer's arithmetic is byte-identical. PURE, no rng. Clamped to [0,1] — the domain is
 * UNSIGNED because this gene runs from "does not price the risk at all" to "prices it
 * fully"; a negative weight would be a team that SEEKS interceptions, which is not a
 * taste, it is a bug.
 */
export function dvExposureWeightOf(g: TacticalGenome): number {
  const v = g.dvExposureWeight;
  if (v === undefined || !Number.isFinite(v)) return 0;
  return clamp01(v);
}

/**
 * DV-T0 (M-DV.2 as amended): the loss-cost BELIEF vector, the SINGLE owner of the
 * expression. Born absent ⇒ all zeros ⇒ every belief term is exactly `+0`. A short,
 * long or non-finite array is read slot by slot with the same zero guard (the OBM
 * matrix's own degradation law), so a malformed genome degrades to "believes nothing"
 * rather than to nonsense. Clamped to [0,1]: the belief is a per-zone cost weight, and a
 * negative one would be a team that WANTS to lose it there. PURE, no rng.
 */
export function dvLossBeliefVector(g: TacticalGenome): number[] {
  const raw = g.dvLossBelief;
  const out = new Array<number>(DV_BELIEF_SLOTS).fill(0);
  if (raw === undefined || !Array.isArray(raw)) return out;
  for (let i = 0; i < DV_BELIEF_SLOTS; i++) {
    const v = raw[i];
    if (v === undefined || !Number.isFinite(v)) continue;
    out[i] = clamp01(v);
  }
  return out;
}

/**
 * RA-T0 (#360 item 3): the receiver-access care gene → weight map, the SINGLE owner of
 * the expression. Born absent ⇒ `0` ⇒ the deficit term is exactly `+0` ⇒ the delivery
 * pricer's arithmetic is byte-identical (the `dvExposureWeightOf` law, verbatim). PURE,
 * no rng. Clamped to [0,1] — UNSIGNED because the gene runs from "does not price the
 * receiver's access at all" to "prices it fully"; a negative weight would be a team
 * that PREFERS balls its own man cannot reach, which is not a taste, it is a bug.
 */
export function raAccessWeightOf(g: TacticalGenome): number {
  const v = g.raAccessWeight;
  if (v === undefined || !Number.isFinite(v)) return 0;
  return clamp01(v);
}

/**
 * ⭐⭐ LN-T0 (M-LN.2; ruling #393 item 5(ii)): the OWN-LANE CARE gene → weight map, the SINGLE
 * owner of the expression. Born absent ⇒ `0` ⇒ the price `w · (1 − ownLaneOpenness)` is
 * exactly `+0`, so the two score subtractions and the perceived chooser's `(1 − price)` factor
 * are IEEE-exact identities and the world is byte-identical (the `dvExposureWeightOf` /
 * `raAccessWeightOf` law, verbatim). A present-but-non-finite value reads as `0` — a broken
 * number is "does not look for his own men", never a crash. PURE, no rng. Clamped to [0,1] —
 * UNSIGNED because the gene runs from "does not price his own men in the lane at all" to
 * "prices them fully"; a negative weight would be a side that PREFERS to strike the ball
 * through its own body, which is not a taste, it is a bug.
 */
export function lnOwnLaneWeightOf(g: TacticalGenome): number {
  const v = g.lnOwnLaneWeight;
  if (v === undefined || !Number.isFinite(v)) return 0;
  return clamp01(v);
}

/**
 * ⭐ RC-T0 (M-RC.4 / M-RC.3a): the ANTICIPATION WEIGHT accessor — the SINGLE owner of the
 * expression, and the one place ABSENT is distinguished from ZERO.
 *
 *   ABSENT  ⇒ `null` — the born-absent identity made STRUCTURAL: with no gene the arm-loop
 *             read never happens, no pre-cue reaches `PcLatencySeat.arm` and the seam's
 *             statements are unreachable rather than merely inert (G-BORN).
 *   PRESENT ⇒ the value clamped to [0, 1] — including `0`, where the interpolation returns the
 *             CHOICE tier EXACTLY and the world is byte-identical with the path LIVE (G-ZERO).
 *
 * A present-but-non-finite value reads as `0` (the `raAccessWeightOf` law, verbatim: a broken
 * number is no trust, never a crash). UNSIGNED because the gene runs from "does not read the
 * passer's body at all" to "reads it fully"; a negative weight would be a receiver who reacts
 * SLOWER the more squarely he is being faced, which is not a taste, it is a bug. PURE, no rng.
 */
export function rcAnticipationWeightOf(g: TacticalGenome): number | null {
  const v = g.rcAnticipationWeight;
  if (v === undefined) return null;
  if (!Number.isFinite(v)) return 0;
  return clamp01(v);
}

/**
 * ⭐ CB-T2 (M-CB.2): the CARRY-PRONENESS style gene → appetite map, the SINGLE owner of
 * the expression. Born absent ⇒ the seat is never formed at all; present at `0` ⇒ every
 * knock candidate prices to exactly `0` and can never win the table. Clamped to [0,1] —
 * the domain is UNSIGNED because the gene runs from "never carries past a man" to "values
 * the knock at exactly what the delivery table says it is worth"; a negative appetite
 * would be a team that pays to NOT beat a man, which is not a taste, it is a bug. PURE,
 * no rng.
 */
export function cbCarryPronenessOf(g: TacticalGenome): number {
  const v = g.cbCarryProneness;
  if (v === undefined || !Number.isFinite(v)) return 0;
  return clamp01(v);
}

/**
 * ⭐ THE FROZEN k_PM CEILING (PM-T0, contract §2 M-PM.1 "bounds frozen at the stage
 * doc from the traced constant family"). `k_PM ∈ [0, 0.25]`.
 *
 * TRACED, NOT INVENTED. 0.25 is the LEGACY per-body convergence weight that the
 * emergent rewrite dropped: `src/ai/formations.ts:209` —
 * `if (!hasBall) y += (ball.pos.y − y · attackDir) · attackDir ·
 * g.defensiveCompactness · 0.25` — i.e. the table path's own maximum lateral
 * convergence toward the ball's lane, at `defensiveCompactness = 1`. The contract
 * names that line as this term's natural neighbour (§0.4 / §2 M-PM.1), so the new
 * axis can express EXACTLY as much convergence as the branch it restores and no
 * more. No new constant is introduced by this slice, and the number is not re-cut
 * later (the never-re-cut-after-sight rule): if PM-T1 needs a different ceiling,
 * that is a fork for the commander WITH numbers.
 */
export const PM_LANE_CONVERGENCE_MAX = 0.25;

/**
 * PM-T0 (M-PM.1): the gene → `k_PM` map, the SINGLE owner of the expression.
 * Born absent ⇒ `0` ⇒ the term vanishes ⇒ byte-identical world. PURE, no rng.
 * The gene is clamped to [0,1] before scaling, so no instrument can dose past the
 * frozen ceiling through this door.
 */
export function pmLaneConvergenceK(g: TacticalGenome): number {
  const v = g.defLaneConvergence;
  if (v === undefined || !Number.isFinite(v)) return 0;
  return clamp01(v) * PM_LANE_CONVERGENCE_MAX;
}

/**
 * ⭐ THE FROZEN OFFSET BOUND (A4 S2-P2, contract M-S2.1 "bounded"). Each per-slot
 * offset lives in [−0.5, +0.5]. RATIONALE, frozen here with its provenance: the
 * obedience gene's own domain is [0,1] (0 = no agreement, 1 = the A4-P1e-certified
 * strength ceiling), so ±0.5 is exactly the amount that lets ANY body reach EITHER
 * end of the certified domain from the neutral team whisper 0.5 (#148's certified
 * PRIMARY dose) — and no more. It also covers, exactly, every vector the S2-P1
 * frozen instrument grid priced (spread ±0.3, backLoaded/frontLoaded ±0.4,
 * singleAnchor +0.5/−0.125 about the matched mean 0.5), so the gene family can
 * EXPRESS the shapes the census measured without being able to invent a dose
 * outside the certified span. The bound applies to the OFFSET; `clamp01` applies to
 * the EFFECTIVE value (obedience + offset), which is what the consumer reads.
 */
export const HOME_PRIOR_OBEDIENCE_OFFSET_MAX = 0.5;

/** Slots covered by the offset family = the squad (`TEAM_SIZE` = 6; kept a local
 *  literal so this module stays free of any `sim/**` runtime import — the tests
 *  assert it EQUALS `TEAM_SIZE`). Role-blind by contract §3: every slot is born
 *  absent and mutates under the same law, GK included (the GK never reaches the v3
 *  station eye, so his slot is inert by the world's own geometry, not by a
 *  role-derived rule written into the gene). */
export const HOME_PRIOR_OFFSET_SLOTS = 6;

const clampOffset = (v: number): number => (Number.isFinite(v)
  ? Math.max(-HOME_PRIOR_OBEDIENCE_OFFSET_MAX, Math.min(HOME_PRIOR_OBEDIENCE_OFFSET_MAX, v))
  : 0);

/**
 * A4 S2-P2 (M-S2.1/M-S2.2): the EFFECTIVE per-body obedience for one squad slot =
 * `clamp01(homePriorObedience + offset_slot)`. Both parts are born absent ⇒ this is
 * `clamp01(0) = 0` at birth, and with the offsets absent it is `clamp01(obedience)`,
 * which `homePriorStrength` already maps identically to the raw gene (its own domain
 * clamp) — i.e. offsets-absent is BIT-IDENTICAL to the uniform whisper. PURE.
 */
export function effectiveHomePriorObedience(g: TacticalGenome, slot: number): number {
  return clamp01((g.homePriorObedience ?? 0) + (g.homePriorObedienceOffset?.[slot] ?? 0));
}

/**
 * A4 S2-P4: write a per-slot offset family onto ONE genome, clamped to the frozen
 * bound. NOTHING calls this at birth or during evolution — the gene stays born
 * absent (contract §3) and mutation/crossover keep their own opt-in paths. The only
 * caller in `src/**` is the explicitly opt-in A4 play-test entry (`game/a4World.ts`),
 * which supplies a CERTIFIED, role-blind family as instrument content.
 *
 * The writer lives HERE so this module remains the single owner of the field name in
 * `src/**` (the S2-P2 birth-neutrality scan): the entry hands over content, it never
 * names the gene.
 */
export function setHomePriorOffsets(g: TacticalGenome, offsets: readonly number[]): void {
  g.homePriorObedienceOffset = offsets.map(clampOffset);
}

/** Read the family back (absent ⇒ `undefined`) — the same single-owner reason. PURE. */
export function homePriorOffsets(g: TacticalGenome): readonly number[] | undefined {
  return g.homePriorObedienceOffset;
}

export const GENE_KEYS = [
  'passBias',
  'shootBias',
  'dribbleBias',
  'pressIntensity',
  'defensiveCompactness',
  'attackingWidth',
  'riskTolerance',
  'counterAttackBias',
  'staminaConservation',
  'markingAggression',
  'keeperAggression',
  'tempo',
  'formationDepth',
  'supportDistance',
  'rotationBias',
  'underdogShift',
  'tinkerBias',
  'fitBias',
  'jockeyBias',
  'coverBias',
  'trapBias',
  'moraleSensitivity',
  'transitionPress',
] as const;

export type GeneKey = (typeof GENE_KEYS)[number];

export function randomGenome(rng: Rng): TacticalGenome {
  const g = {} as TacticalGenome;
  for (const k of GENE_KEYS) g[k] = rng.range(0.15, 0.85);
  return g;
}

export interface MutateOptions {
  /** Probability each gene mutates. */
  rate?: number;
  /** Std-dev of gaussian noise added to a mutating gene. */
  scale?: number;
  /**
   * A4-P2 (#148.5, the RNG-stream trap): opt-in that lets the dormant
   * `homePriorObedience` gene evolve. DEFAULT OFF — every production evolve.ts
   * call omits it, so the gene draws NO RNG and the flag-off random sequence
   * (mutation + crossover draws) stays byte-identical to HEAD. Its draws happen
   * ONLY when this is `true` and STRICTLY AFTER the GENE_KEYS loop, so enabling it
   * never re-orders any existing gene's draw. When shipped, an A4-P3-grade run
   * flips this together with the `eye.v4.homePrior` consumption flag.
   */
  evolveHomePrior?: boolean;
  /**
   * A4 S2-P2 (#164.3, the SAME RNG-stream trap): opt-in that lets the dormant
   * per-slot `homePriorObedienceOffset` family evolve. DEFAULT OFF — every
   * production evolve.ts call omits it, so the family draws NO RNG and the
   * flag-off random sequence stays byte-identical to HEAD. It is its OWN named
   * boolean (#75: every new gate is explicit) rather than a widening of
   * `evolveHomePrior`, so a home-prior-only run's stream is ALSO unmoved. Its
   * draws happen ONLY when this is `true` and STRICTLY AFTER the
   * `homePriorObedience` block, so enabling it never re-orders any existing draw.
   * When shipped, an S2-P3-grade run flips this together with `evolveHomePrior`
   * and the `eye.v4.homePrior` consumption flag.
   */
  evolveHomePriorOffsets?: boolean;
  /**
   * PM-T0 (#195.2, the SAME RNG-stream trap): opt-in that lets the dormant
   * `defLaneConvergence` gene evolve. DEFAULT OFF — every production evolve.ts call
   * omits it, so the gene draws NO RNG and the flag-off random sequence stays
   * byte-identical to HEAD. It is its OWN named boolean (#75) rather than a
   * widening of either home-prior opt-in, so those runs' streams are ALSO unmoved.
   * Its draws happen ONLY when this is `true` and STRICTLY AFTER both home-prior
   * blocks, so enabling it never re-orders any existing draw. When shipped, a
   * PM-T2-grade run flips this together with the `pmLaneConvergence` match flag.
   */
  evolveDefLaneConvergence?: boolean;
  /**
   * MT-T0 (#201.4, the SAME RNG-stream trap): opt-in that lets the dormant `markSag`
   * gene evolve. DEFAULT OFF — every production evolve.ts call omits it, so the gene
   * draws NO RNG and the flag-off random sequence stays byte-identical to HEAD. It is
   * its OWN named boolean (#75) rather than a widening of any existing opt-in, so
   * those runs' streams are ALSO unmoved. Its draws happen ONLY when this is `true`
   * and STRICTLY AFTER the `defLaneConvergence` block (hence after both home-prior
   * blocks), so enabling it never re-orders any existing draw. When shipped, an
   * MT-T2-grade run flips this together with the `mtMarkSag` match flag.
   */
  evolveMarkSag?: boolean;
  /**
   * CTB-T0 (#223, the SAME RNG-stream trap): opt-in that lets the dormant
   * support-plane axis pair (`ctbSupportDepth` + `ctbSupportWidth`) evolve. DEFAULT
   * OFF — every production evolve.ts call omits it, so the genes draw NO RNG and the
   * flag-off random sequence stays byte-identical to HEAD. It is its OWN named
   * boolean (#75) rather than a widening of any existing opt-in, so those runs'
   * streams are ALSO unmoved. ONE opt-in for BOTH axes on purpose: they are one
   * body's positional freedom (the user's 前后左右), not two independent tactics, and
   * CTB-T2 doses/selects the plane as a plane. Its draws happen ONLY when this is
   * `true` and STRICTLY AFTER the `markSag` block (hence after `defLaneConvergence`
   * and both home-prior blocks), depth first then width, so enabling it never
   * re-orders an existing draw. When shipped, a CTB-T2-grade run flips this together
   * with the `ctbSupportPlane` match flag.
   */
  evolveCtbSupportPlane?: boolean;
  /**
   * OBM-T0 (#227, the SAME RNG-stream trap): opt-in that lets the dormant off-ball
   * movement POLICY MATRIX (`offballMovementWeights`) evolve. DEFAULT OFF — every
   * production evolve.ts call omits it, so the matrix draws NO RNG and the flag-off
   * random sequence stays byte-identical to HEAD. It is its OWN named boolean (#75)
   * rather than a widening of any existing opt-in, so those runs' streams are ALSO
   * unmoved. ONE opt-in for the WHOLE matrix on purpose: it is one policy, and
   * OBM-T2 selects on it as a policy. Its draws happen ONLY when this is `true` and
   * STRICTLY AFTER the `ctbSupportPlane` block (hence after `markSag`,
   * `defLaneConvergence` and both home-prior blocks), in slot order, so enabling it
   * never re-orders an existing draw. When shipped, an OBM-T2-grade run flips this
   * together with the `obmMovement` match flag.
   */
  evolveOffballMovement?: boolean;
  /**
   * PTP-T0 (#231, the SAME RNG-stream trap): opt-in that lets the dormant pass-LEAD
   * trust gene (`passLeadSupport`) evolve. DEFAULT OFF — every production evolve.ts
   * call omits it, so the gene draws NO RNG and the flag-off random sequence stays
   * byte-identical to HEAD. It is its OWN named boolean (#75) rather than a widening
   * of any existing opt-in, so those runs' streams are ALSO unmoved. Its draws happen
   * ONLY when this is `true` and STRICTLY AFTER the `offballMovementWeights` block
   * (hence after `ctbSupportPlane`, `markSag`, `defLaneConvergence` and both
   * home-prior blocks), so enabling it never re-orders an existing draw. When
   * shipped, a PTP-T2-grade run flips this together with the `ptpPassLead` match flag
   * — and, per the contract's co-evolution clause, alongside `evolveOffballMovement`:
   * the passer's trust and the receiver's movement are the relational PAIR.
   */
  evolvePassLeadSupport?: boolean;
  /**
   * DV-T0 (#249, the SAME RNG-stream trap): opt-in that lets the dormant DELIVERY-VALUE
   * risk genes — the flight-exposure care weight (`dvExposureWeight`) and the three-zone
   * loss-cost BELIEF (`dvLossBelief`) — evolve. DEFAULT OFF — every production evolve.ts
   * call omits it, so they draw NO RNG and the flag-off random sequence stays
   * byte-identical to HEAD. It is its OWN named boolean (#75) rather than a widening of
   * any existing opt-in, so those runs' streams are ALSO unmoved. ONE opt-in for BOTH on
   * purpose: a risk map and the care that reads it are one disposition, and DV-T2
   * selects on them together (and measures the belief against DV-C0's yardstick). Its
   * draws happen ONLY when this is `true` and STRICTLY AFTER the `passLeadSupport` block
   * (hence after `offballMovementWeights`, `ctbSupportPlane`, `markSag`,
   * `defLaneConvergence` and both home-prior blocks), exposure first then the three
   * belief slots in zone order, so enabling it never re-orders an existing draw. When
   * shipped, a DV-T2-grade run flips this together with the `dvDeliveryValue` match flag.
   */
  evolveDeliveryValue?: boolean;
  /**
   * ⭐ CB-T2 (#268.4, the SAME RNG-stream trap): opt-in that lets the dormant
   * CARRY-PRONENESS style gene (`cbCarryProneness`) evolve. DEFAULT OFF — every
   * production evolve.ts call omits it, so it draws NO RNG and the flag-off random
   * sequence stays byte-identical to HEAD. It is its OWN named boolean (#75) rather than
   * a widening of any existing opt-in, so those runs' streams are ALSO unmoved. Its draws
   * happen ONLY when this is `true` and STRICTLY AFTER the delivery-value block (hence
   * after `passLeadSupport`, `offballMovementWeights`, `ctbSupportPlane`, `markSag`,
   * `defLaneConvergence` and both home-prior blocks), so enabling it never re-orders an
   * existing draw. NO evolution exam rides on it in this stage.
   */
  evolveCarryChoice?: boolean;
  /**
   * RA-T0 (#360 item 3): opt-in for the receiver-access care weight (`raAccessWeight`).
   * DEFAULT OFF — every production evolve run's rng stream is byte-identical; its
   * draws sit STRICTLY AFTER the carry-choice block, i.e. after every existing block.
   */
  evolveReceiverAccess?: boolean;
  /**
   * RC-T0 (#369 item 6): opt-in for the receiver ANTICIPATION weight
   * (`rcAnticipationWeight`). DEFAULT OFF — every production evolve run's rng stream is
   * byte-identical; its draws sit STRICTLY AFTER the receiver-access block, i.e. after every
   * existing block, in BOTH mutate and crossover.
   */
  evolveReceiverAnticipation?: boolean;
}

/** Returns a new genome; genes are clamped back to [0, 1]. */
export function mutateGenome(g: TacticalGenome, rng: Rng, opts: MutateOptions = {}): TacticalGenome {
  const rate = opts.rate ?? 0.45;
  const scale = opts.scale ?? 0.14;
  const out = { ...g };
  for (const k of GENE_KEYS) {
    if (rng.chance(rate)) out[k] = clamp01(out[k] + rng.gaussian() * scale);
  }
  // A4-P2 (#148.5): the home-prior gene mutates ONLY under its explicit opt-in and
  // ONLY here — after the GENE_KEYS loop — so flag-off runs consume ZERO extra RNG
  // draws and stay byte-identical to HEAD. `{ ...g }` above already carried the
  // gene through untouched (born-absent ⇒ stays absent) in the flag-off path.
  if (opts.evolveHomePrior === true && rng.chance(rate)) {
    out.homePriorObedience = clamp01((out.homePriorObedience ?? 0) + rng.gaussian() * scale);
  }
  // A4 S2-P2 (#164.3): the per-slot OFFSET family mutates ONLY under its OWN explicit
  // opt-in and ONLY here — after the GENE_KEYS loop AND after the homePriorObedience
  // block — so flag-off runs consume ZERO extra RNG draws (byte-identical to HEAD) and
  // a homePrior-only run's draw sequence is unmoved too. `{ ...g }` above already
  // carried the family through untouched (born-absent ⇒ stays absent) in the flag-off
  // path. Role-BLIND (contract §3 BIRTH NEUTRALITY): the same rate/scale law runs over
  // every squad slot in slot order; each offset is clamped to the frozen ±0.5 bound.
  if (opts.evolveHomePriorOffsets === true) {
    const base = out.homePriorObedienceOffset;
    const next = Array.from(
      { length: HOME_PRIOR_OFFSET_SLOTS }, (_, i) => clampOffset(base?.[i] ?? 0),
    );
    for (let i = 0; i < HOME_PRIOR_OFFSET_SLOTS; i++) {
      if (rng.chance(rate)) next[i] = clampOffset(next[i] + rng.gaussian() * scale);
    }
    out.homePriorObedienceOffset = next;
  }
  // PM-T0 (#195.2): the defensive lane-convergence gene mutates ONLY under its OWN
  // explicit opt-in and ONLY here — after the GENE_KEYS loop AND after BOTH
  // home-prior blocks — so flag-off runs consume ZERO extra RNG draws
  // (byte-identical to HEAD) and neither home-prior run's draw sequence moves.
  // `{ ...g }` above already carried the gene through untouched (born-absent ⇒
  // stays absent) in the flag-off path.
  if (opts.evolveDefLaneConvergence === true && rng.chance(rate)) {
    out.defLaneConvergence = clamp01((out.defLaneConvergence ?? 0) + rng.gaussian() * scale);
  }
  // MT-T0 (#201.4): the mark-SAG gene mutates ONLY under its OWN explicit opt-in and
  // ONLY here — after the GENE_KEYS loop, after BOTH home-prior blocks AND after the
  // defLaneConvergence block — so flag-off runs consume ZERO extra RNG draws
  // (byte-identical to HEAD) and no existing opt-in run's draw sequence moves.
  // `{ ...g }` above already carried the gene through untouched (born-absent ⇒ stays
  // absent) in the flag-off path.
  if (opts.evolveMarkSag === true && rng.chance(rate)) {
    out.markSag = clamp01((out.markSag ?? 0) + rng.gaussian() * scale);
  }
  // CTB-T0 (#223): the SUPPORT-PLANE axis pair mutates ONLY under its OWN explicit
  // opt-in and ONLY here — after the GENE_KEYS loop, after BOTH home-prior blocks,
  // after the defLaneConvergence block AND after the markSag block — so flag-off runs
  // consume ZERO extra RNG draws (byte-identical to HEAD) and no existing opt-in run's
  // draw sequence moves. `{ ...g }` above already carried both genes through untouched
  // (born-absent ⇒ stay absent) in the flag-off path. DEPTH first, then WIDTH: one
  // fixed order, so the pair's own stream is stable too. Clamped to the SIGNED domain.
  if (opts.evolveCtbSupportPlane === true) {
    if (rng.chance(rate)) {
      out.ctbSupportDepth = clampSignedUnit((out.ctbSupportDepth ?? 0) + rng.gaussian() * scale);
    }
    if (rng.chance(rate)) {
      out.ctbSupportWidth = clampSignedUnit((out.ctbSupportWidth ?? 0) + rng.gaussian() * scale);
    }
  }
  // OBM-T0 (#227): the off-ball movement POLICY MATRIX mutates ONLY under its OWN
  // explicit opt-in and ONLY here — after the GENE_KEYS loop, after BOTH home-prior
  // blocks, after the defLaneConvergence block, after the markSag block AND after the
  // ctbSupportPlane block — so flag-off runs consume ZERO extra RNG draws
  // (byte-identical to HEAD) and no existing opt-in run's draw sequence moves.
  // `{ ...g }` above already carried the matrix through untouched (born-absent ⇒
  // stays absent) in the flag-off path. SLOT ORDER is fixed (row-major, output by
  // output), so the matrix's own stream is stable too. The per-slot rate/scale law is
  // the offset FAMILY's verbatim (#164.3), clamped to the SIGNED domain.
  if (opts.evolveOffballMovement === true) {
    const next = offballMovementWeightVector(out);
    for (let i = 0; i < OBM_WEIGHT_SLOTS; i++) {
      if (rng.chance(rate)) next[i] = clampSignedUnit(next[i] + rng.gaussian() * scale);
    }
    out.offballMovementWeights = next;
  }
  // PTP-T0 (#231): the pass-LEAD trust gene mutates ONLY under its OWN explicit
  // opt-in and ONLY here — after the GENE_KEYS loop, after BOTH home-prior blocks,
  // after the defLaneConvergence block, after the markSag block, after the
  // ctbSupportPlane block AND after the offballMovement block — so flag-off runs
  // consume ZERO extra RNG draws (byte-identical to HEAD) and no existing opt-in
  // run's draw sequence moves. `{ ...g }` above already carried the gene through
  // untouched (born-absent ⇒ stays absent) in the flag-off path.
  if (opts.evolvePassLeadSupport === true && rng.chance(rate)) {
    out.passLeadSupport = clamp01((out.passLeadSupport ?? 0) + rng.gaussian() * scale);
  }
  // DV-T0 (#249): the DELIVERY-VALUE risk genes mutate ONLY under their OWN explicit
  // opt-in and ONLY here — after the GENE_KEYS loop, after BOTH home-prior blocks, after
  // the defLaneConvergence block, after the markSag block, after the ctbSupportPlane
  // block, after the offballMovement block AND after the passLeadSupport block — so
  // flag-off runs consume ZERO extra RNG draws (byte-identical to HEAD) and no existing
  // opt-in run's draw sequence moves. `{ ...g }` above already carried both through
  // untouched (born-absent ⇒ stay absent) in the flag-off path. EXPOSURE first, then the
  // three BELIEF slots in the frozen zone order, so the pair's own stream is stable too.
  // The per-slot rate/scale law is the OBM matrix's verbatim (#227), clamped to [0,1].
  if (opts.evolveDeliveryValue === true) {
    if (rng.chance(rate)) {
      out.dvExposureWeight = clamp01((out.dvExposureWeight ?? 0) + rng.gaussian() * scale);
    }
    const belief = dvLossBeliefVector(out);
    for (let i = 0; i < DV_BELIEF_SLOTS; i++) {
      if (rng.chance(rate)) belief[i] = clamp01(belief[i] + rng.gaussian() * scale);
    }
    out.dvLossBelief = belief;
  }
  // CB-T2 (#268.4): the CARRY-PRONENESS style gene mutates ONLY under its OWN explicit
  // opt-in and ONLY here — after every block above, the delivery-value pair included — so
  // flag-off runs consume ZERO extra RNG draws (byte-identical to HEAD) and no existing
  // opt-in run's draw sequence moves. `{ ...g }` above already carried it through
  // untouched (born-absent ⇒ stays absent) in the flag-off path. The rate/scale law is
  // the DV exposure weight's verbatim, clamped to [0,1].
  if (opts.evolveCarryChoice === true) {
    if (rng.chance(rate)) {
      out.cbCarryProneness = clamp01((out.cbCarryProneness ?? 0) + rng.gaussian() * scale);
    }
  }
  // RA-T0 (#360.3): the RECEIVER-ACCESS care gene mutates ONLY under its OWN explicit
  // opt-in and ONLY here — after every block above, the carry-choice scalar included — so
  // flag-off runs consume ZERO extra RNG draws (byte-identical to HEAD) and no existing
  // opt-in run's draw sequence moves. `{ ...g }` above already carried it through
  // untouched (born-absent ⇒ stays absent) in the flag-off path. The rate/scale law is
  // the carry-proneness gene's verbatim, clamped to [0,1].
  if (opts.evolveReceiverAccess === true) {
    if (rng.chance(rate)) {
      out.raAccessWeight = clamp01((out.raAccessWeight ?? 0) + rng.gaussian() * scale);
    }
  }
  // RC-T0 (#369 item 6): the ANTICIPATION gene mutates ONLY under its OWN explicit opt-in and
  // ONLY here — after every block above, the receiver-access scalar included, so it is LAST —
  // so flag-off runs consume ZERO extra RNG draws (byte-identical to HEAD) and no existing
  // opt-in run's draw sequence moves. `{ ...g }` above already carried it through untouched
  // (born-absent ⇒ stays absent) in the flag-off path. The rate/scale law is the
  // receiver-access gene's verbatim, clamped to [0,1].
  if (opts.evolveReceiverAnticipation === true) {
    if (rng.chance(rate)) {
      out.rcAnticipationWeight = clamp01((out.rcAnticipationWeight ?? 0) + rng.gaussian() * scale);
    }
  }
  return out;
}

/** Uniform crossover with occasional blending — child gene is from a, from b, or their mean. */
export function crossoverGenomes(
  a: TacticalGenome, b: TacticalGenome, rng: Rng, evolveHomePrior = false,
  evolveHomePriorOffsets = false, evolveDefLaneConvergence = false, evolveMarkSag = false,
  evolveCtbSupportPlane = false, evolveOffballMovement = false,
  evolvePassLeadSupport = false, evolveDeliveryValue = false, evolveCarryChoice = false,
  evolveReceiverAccess = false, evolveReceiverAnticipation = false,
): TacticalGenome {
  const out = {} as TacticalGenome;
  for (const k of GENE_KEYS) {
    const r = rng.next();
    out[k] = r < 0.4 ? a[k] : r < 0.8 ? b[k] : (a[k] + b[k]) / 2;
  }
  // A4-P2 (#148.5): the home-prior gene crosses over ONLY under its explicit opt-in
  // and ONLY here — after the GENE_KEYS loop — so flag-off runs draw ZERO extra RNG
  // and stay byte-identical to HEAD. Flag-off ⇒ carry parent A's value through with
  // NO draw (born-absent ⇒ the key stays absent ⇒ serialization unchanged).
  if (evolveHomePrior) {
    const r = rng.next();
    const av = a.homePriorObedience ?? 0;
    const bv = b.homePriorObedience ?? 0;
    out.homePriorObedience = r < 0.4 ? av : r < 0.8 ? bv : (av + bv) / 2;
  } else if (a.homePriorObedience !== undefined) {
    out.homePriorObedience = a.homePriorObedience;
  }
  // A4 S2-P2 (#164.3): the per-slot OFFSET family crosses over ONLY under its OWN
  // explicit opt-in and ONLY here — after the GENE_KEYS loop AND after the
  // homePriorObedience block — so flag-off runs draw ZERO extra RNG and a
  // homePrior-only run is unmoved. ONE draw for the whole family, mirroring the
  // scalar gene's single from-a / from-b / blend law (the family is one agreement,
  // not six independent ones). Flag-off ⇒ carry parent A's family through with NO
  // draw (born-absent ⇒ the key stays absent ⇒ serialization unchanged).
  if (evolveHomePriorOffsets) {
    const r = rng.next();
    const av = a.homePriorObedienceOffset;
    const bv = b.homePriorObedienceOffset;
    out.homePriorObedienceOffset = Array.from(
      { length: HOME_PRIOR_OFFSET_SLOTS },
      (_, i) => {
        const ai = clampOffset(av?.[i] ?? 0);
        const bi = clampOffset(bv?.[i] ?? 0);
        return r < 0.4 ? ai : r < 0.8 ? bi : (ai + bi) / 2;
      },
    );
  } else if (a.homePriorObedienceOffset !== undefined) {
    out.homePriorObedienceOffset = a.homePriorObedienceOffset;
  }
  // PM-T0 (#195.2): the lane-convergence gene crosses over ONLY under its OWN
  // explicit opt-in and ONLY here — after the GENE_KEYS loop AND after BOTH
  // home-prior blocks — so flag-off runs draw ZERO extra RNG and neither
  // home-prior run is moved. Flag-off ⇒ carry parent A's value through with NO
  // draw (born-absent ⇒ the key stays absent ⇒ serialization unchanged).
  if (evolveDefLaneConvergence) {
    const r = rng.next();
    const av = a.defLaneConvergence ?? 0;
    const bv = b.defLaneConvergence ?? 0;
    out.defLaneConvergence = r < 0.4 ? av : r < 0.8 ? bv : (av + bv) / 2;
  } else if (a.defLaneConvergence !== undefined) {
    out.defLaneConvergence = a.defLaneConvergence;
  }
  // MT-T0 (#201.4): the mark-SAG gene crosses over ONLY under its OWN explicit opt-in
  // and ONLY here — after the GENE_KEYS loop, after BOTH home-prior blocks AND after
  // the defLaneConvergence block — so flag-off runs draw ZERO extra RNG and no
  // existing opt-in run is moved. Flag-off ⇒ carry parent A's value through with NO
  // draw (born-absent ⇒ the key stays absent ⇒ serialization unchanged).
  if (evolveMarkSag) {
    const r = rng.next();
    const av = a.markSag ?? 0;
    const bv = b.markSag ?? 0;
    out.markSag = r < 0.4 ? av : r < 0.8 ? bv : (av + bv) / 2;
  } else if (a.markSag !== undefined) {
    out.markSag = a.markSag;
  }
  // CTB-T0 (#223): the SUPPORT-PLANE axis pair crosses over ONLY under its OWN
  // explicit opt-in and ONLY here — after the GENE_KEYS loop, after BOTH home-prior
  // blocks, after the defLaneConvergence block AND after the markSag block — so
  // flag-off runs draw ZERO extra RNG and no existing opt-in run is moved. TWO draws,
  // depth then width: unlike the offset FAMILY (one agreement, one draw), these are
  // two independent axes of one plane and may be inherited from different parents.
  // Flag-off ⇒ carry parent A's values through with NO draw (born-absent ⇒ the keys
  // stay absent ⇒ serialization unchanged).
  if (evolveCtbSupportPlane) {
    const rd = rng.next();
    const ad = a.ctbSupportDepth ?? 0;
    const bd = b.ctbSupportDepth ?? 0;
    out.ctbSupportDepth = rd < 0.4 ? ad : rd < 0.8 ? bd : (ad + bd) / 2;
    const rw = rng.next();
    const aw = a.ctbSupportWidth ?? 0;
    const bw = b.ctbSupportWidth ?? 0;
    out.ctbSupportWidth = rw < 0.4 ? aw : rw < 0.8 ? bw : (aw + bw) / 2;
  } else {
    if (a.ctbSupportDepth !== undefined) out.ctbSupportDepth = a.ctbSupportDepth;
    if (a.ctbSupportWidth !== undefined) out.ctbSupportWidth = a.ctbSupportWidth;
  }
  // OBM-T0 (#227): the off-ball movement POLICY MATRIX crosses over ONLY under its
  // OWN explicit opt-in and ONLY here — after every block above, the ctbSupportPlane
  // pair included — so flag-off runs draw ZERO extra RNG and no existing opt-in run
  // is moved. ONE draw for the WHOLE matrix, the offset FAMILY's law (#164.3): a
  // policy is ONE agreement about how to read a situation, not sixteen independent
  // ones, so a child inherits a coherent policy rather than a mosaic of two. Flag-off
  // ⇒ carry parent A's matrix through with NO draw (born-absent ⇒ the key stays
  // absent ⇒ serialization unchanged).
  if (evolveOffballMovement) {
    const r = rng.next();
    const av = offballMovementWeightVector(a);
    const bv = offballMovementWeightVector(b);
    out.offballMovementWeights = Array.from(
      { length: OBM_WEIGHT_SLOTS },
      (_, i) => (r < 0.4 ? av[i] : r < 0.8 ? bv[i] : (av[i] + bv[i]) / 2),
    );
  } else if (a.offballMovementWeights !== undefined) {
    // ⭐ COPIED, never ALIASED (the OBM-T0 verify catch, LOW): value-identical to
    // parent A and therefore RNG- and byte-neutral, but the child no longer SHARES
    // parent A's array — an in-place write on either (e.g. the arming checklist's
    // three-view dosing, #196.3-D6) can no longer reach through into the other.
    out.offballMovementWeights = [...a.offballMovementWeights];
  }
  // PTP-T0 (#231): the pass-LEAD trust gene crosses over ONLY under its OWN explicit
  // opt-in and ONLY here — after every block above, the offballMovement matrix
  // included — so flag-off runs draw ZERO extra RNG and no existing opt-in run is
  // moved. ONE draw, the scalar law (`markSag`'s verbatim): from A, from B, or their
  // mean. Flag-off ⇒ carry parent A's value through with NO draw (born-absent ⇒ the
  // key stays absent ⇒ serialization unchanged).
  if (evolvePassLeadSupport) {
    const r = rng.next();
    const av = a.passLeadSupport ?? 0;
    const bv = b.passLeadSupport ?? 0;
    out.passLeadSupport = r < 0.4 ? av : r < 0.8 ? bv : (av + bv) / 2;
  } else if (a.passLeadSupport !== undefined) {
    out.passLeadSupport = a.passLeadSupport;
  }
  // DV-T0 (#249): the DELIVERY-VALUE risk genes cross over ONLY under their OWN explicit
  // opt-in and ONLY here — after every block above, the passLeadSupport scalar included —
  // so flag-off runs draw ZERO extra RNG and no existing opt-in run is moved. TWO draws:
  // the scalar law for the exposure weight (`markSag`'s verbatim), then ONE draw for the
  // WHOLE belief vector (the offset FAMILY's law, #164.3) — a risk MAP is one agreement
  // about the world, not three independent ones, so a child inherits a coherent map
  // rather than a mosaic of two. Flag-off ⇒ carry parent A's values through with NO draw
  // (born-absent ⇒ the keys stay absent ⇒ serialization unchanged); the array is COPIED,
  // never ALIASED (the OBM-T0 verify catch).
  if (evolveDeliveryValue) {
    const re = rng.next();
    const ae = a.dvExposureWeight ?? 0;
    const be = b.dvExposureWeight ?? 0;
    out.dvExposureWeight = re < 0.4 ? ae : re < 0.8 ? be : (ae + be) / 2;
    const rb = rng.next();
    const ab = dvLossBeliefVector(a);
    const bb = dvLossBeliefVector(b);
    out.dvLossBelief = Array.from(
      { length: DV_BELIEF_SLOTS },
      (_, i) => (rb < 0.4 ? ab[i] : rb < 0.8 ? bb[i] : (ab[i] + bb[i]) / 2),
    );
  } else {
    if (a.dvExposureWeight !== undefined) out.dvExposureWeight = a.dvExposureWeight;
    if (a.dvLossBelief !== undefined) out.dvLossBelief = [...a.dvLossBelief];
  }
  // CB-T2 (#268.4): the carry-proneness gene, LAST and behind its own opt-in — flag-off
  // ⇒ carry parent A's value through with NO draw (born-absent ⇒ the key stays absent ⇒
  // serialization unchanged), so no existing run's crossover stream moves.
  if (evolveCarryChoice) {
    const rc = rng.next();
    const ac = a.cbCarryProneness ?? 0;
    const bc = b.cbCarryProneness ?? 0;
    out.cbCarryProneness = rc < 0.4 ? ac : rc < 0.8 ? bc : (ac + bc) / 2;
  } else if (a.cbCarryProneness !== undefined) out.cbCarryProneness = a.cbCarryProneness;
  // RA-T0 (#360.3): the receiver-access gene, LAST and behind its own opt-in — flag-off
  // ⇒ carry parent A's value through with NO draw (born-absent ⇒ the key stays absent ⇒
  // serialization unchanged), so no existing run's crossover stream moves.
  if (evolveReceiverAccess) {
    const rr = rng.next();
    const ar = a.raAccessWeight ?? 0;
    const br = b.raAccessWeight ?? 0;
    out.raAccessWeight = rr < 0.4 ? ar : rr < 0.8 ? br : (ar + br) / 2;
  } else if (a.raAccessWeight !== undefined) out.raAccessWeight = a.raAccessWeight;
  // RC-T0 (#369 item 6): the anticipation gene, LAST and behind its own opt-in — flag-off ⇒
  // carry parent A's value through with NO draw (born-absent ⇒ the key stays absent ⇒
  // serialization unchanged), so no existing run's crossover stream moves.
  if (evolveReceiverAnticipation) {
    const rn = rng.next();
    const an = a.rcAnticipationWeight ?? 0;
    const bn = b.rcAnticipationWeight ?? 0;
    out.rcAnticipationWeight = rn < 0.4 ? an : rn < 0.8 ? bn : (an + bn) / 2;
  } else if (a.rcAnticipationWeight !== undefined) {
    out.rcAnticipationWeight = a.rcAnticipationWeight;
  }
  return out;
}

/** Euclidean distance in gene space — used to report drift across generations. */
export function geneDistance(a: TacticalGenome, b: TacticalGenome): number {
  let s = 0;
  for (const k of GENE_KEYS) s += (a[k] - b[k]) ** 2;
  return Math.sqrt(s);
}

/**
 * Human-readable tactical identity, derived from the most extreme genes.
 * Shown on team cards so evolution is explainable at a glance.
 */
export function describeIdentity(g: TacticalGenome): string[] {
  const tags: string[] = [];
  // 'Gegenpress' moved to transitionPress at Phase 112 — counter-pressing
  // the LOSS is what the word means; steady-state pressing is a high press.
  if (g.pressIntensity > 0.68) tags.push('High press');
  if (g.passBias > 0.68 && g.tempo < 0.55) tags.push('Possession game');
  if (g.passBias > 0.68 && g.tempo >= 0.55) tags.push('Fast combinations');
  if (g.counterAttackBias > 0.65) tags.push('Counter-attack');
  if (g.defensiveCompactness > 0.68 && g.riskTolerance < 0.4) tags.push('Low block');
  if (g.riskTolerance > 0.72) tags.push('High risk / chaos');
  // 32.2: the genes that price the back-pass outlet and the keeper's feet
  // — an identity that is VISIBLE in play (the press-escape through him).
  if ((g.passBias + g.riskTolerance) / 2 > 0.62) tags.push('Ball-playing keeper');
  if (g.shootBias > 0.7) tags.push('Shoot on sight');
  if (g.dribbleBias > 0.7) tags.push('Street dribblers');
  if (g.attackingWidth > 0.7) tags.push('Wide play');
  if (g.formationDepth > 0.7) tags.push('High line');
  if (g.formationDepth < 0.3) tags.push('Deep block');
  if (g.staminaConservation > 0.72) tags.push('Energy misers');
  if ((g.rotationBias ?? 0.5) > 0.72) tags.push('Fresh legs');
  if ((g.underdogShift ?? 0) > 0.72) tags.push('Cup fighter');
  if ((g.tinkerBias ?? 0.5) > 0.72) tags.push('Tinkerman');
  if ((g.tinkerBias ?? 0.5) < 0.28) tags.push('Trusts the XI');
  if ((g.fitBias ?? 0.5) > 0.72) tags.push('System signings');
  if ((g.fitBias ?? 0.5) < 0.28) tags.push('Galactico board');
  if ((g.jockeyBias ?? 0.5) > 0.72) tags.push('Contains & delays');
  if ((g.jockeyBias ?? 0.5) < 0.28) tags.push('Dives in');
  if ((g.coverBias ?? 0.5) > 0.72) tags.push('Libero');
  if ((g.coverBias ?? 0.5) < 0.28) tags.push('Stopper steps up');
  if ((g.trapBias ?? 0.5) > 0.72) tags.push('Offside trap');
  if ((g.trapBias ?? 0.5) < 0.28) tags.push('Tracks runners home');
  if ((g.moraleSensitivity ?? 0.5) > 0.72) tags.push('Confidence team');
  if ((g.moraleSensitivity ?? 0.5) < 0.28) tags.push('Steady pros');
  if ((g.transitionPress ?? 0.5) > 0.72) tags.push('Gegenpress');
  if ((g.transitionPress ?? 0.5) < 0.28) tags.push('Drops & recovers');
  if (tags.length === 0) tags.push('Balanced');
  return tags.slice(0, 3);
}
