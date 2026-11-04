// STAGE III P2 — THE DORMANT EYE (the chooser)
// Contract: docs/world-model/STAGE3-P2-DORMANT-EYE.md §2.3-§2.5, as amended by
// commander ruling #43.3.
//
// A body at a decision instant prices the SAME 18-candidate ball-local lattice
// P1R censused, reading his OWN percept for the context and the committed
// approach table for the value, and commits his window to the best-priced
// approach — or to the incumbent, which is the table's own control arm and is
// therefore a first-class choice rather than a fallback.
//
// The table's meaning is ruling #41.2's and no other: the signed value of
// committing W to APPROACHING candidate X. Nothing here reads "standing".
//
// PURE. No world mutation, no RNG, no truth lookups except in the ORACLE-CTX
// arm, which is a probe-only diagnostic (contract §2.5) and never reachable
// from a production path.
import { BOX_WIDTH, HALF_L } from '../sim/constants';
import { TEAM_SIZE, type Role } from '../sim/types';
import type { TacticalGenome } from '../evolution/genome';
import type { PerceptionSnapshot } from './perceptionSnapshot';
import { beyondLineBit, type BitValue } from './eyeContextBitsV4';

/** One census cell, exactly as P1R committed it. */
export interface ApproachCell {
  readonly n: number;
  readonly score: number;
  readonly concede: number;
  readonly value: number;
  readonly underPowered?: boolean;
}
/** context key → candidate id (incl. 'control') → cell. */
export type ApproachTable = Readonly<Record<string, Readonly<Record<string, ApproachCell>>>>;

export type StationEyeArm = 'neutral' | 'gene' | 'oracleCtx' | 'inverted';

/** §2.4: the census's own floor. An UNDER-POWERED cell is not a price. */
export const CELL_FLOOR = 150;
/** §2.2: W, inherited from P1R §2.3 with its P0-anchored derivation. */
export const EYE_W_S = 3.0;
/** V2-P2 §2.2 / V2-P0 §2.1: the OTHERS-GOING region radius, FROZEN at 4.0 m. */
export const EYE_R_M = 4.0;
/** §2.3: the density feature's radius, P1R §3.2 verbatim. */
const DENSITY_RADIUS = 9;
const CONTROL_ID = 'control';

// ===========================================================================
// A4-P1c (ruling #137) — THE DORMANT BACK-HOME-REGION GRANT (the M1′ soft-bias
// instrument form). A distance-decayed SOFT bias toward a coarse back home
// region, ADDED to a granted body's per-candidate station value at the
// ESTABLISHED v3 consumption point (docs/world-model/A4-P1C-GRANT-CENSUS.md).
// Hand-built here = the COORDINATE FRAME + the BLENDING RULE ONLY (I-A2/I-A4
// 诚实张力 — 涌现的是权重,不是维度本身); the STRENGTH is a pre-registered DOSE in
// instruments (a gene when shipped, never a hand knob — I-A3). NO clamps (M3′:
// the clamp is the P1b-certified disease — a strong local gradient must still be
// able to win). The region is anchored on PUBLISHED constants ONLY:
//   center     = -12 local  (= -8 - 0.5·8, the neutral-coverBias rest-defence
//                clamp depth, formations.ts formationSpot/emergentStation; the
//                Phase-31 "-12 not -5" pin the #130 challenge named)
//   half-depth = 4           (= 8/2, half the coverBias clamp span [-16, -8])
//   decay      = HALF_L/3    (REST_THIRD, the own-third depth scale)
// Convex-region SOFT decay: the full `strength` inside the region, exp-decayed by
// local-DEPTH distance OUTSIDE it. DEPTH-ONLY — a back home region is a depth
// prior (the §7 non-claim: width / bimodal homes are named later slices). PURE:
// no world read, no clamp, no mutation; the caller supplies the candidate's own
// team-local depth. Dormant in production (Match.homeRegionGrant is null).
/** the back home region's depth centre in the team-local (attack-relative) frame. */
export const HOME_REGION_CENTER_LOCAL_X = -12;
/** the back home region's depth half-extent (half the coverBias clamp span). */
export const HOME_REGION_HALF_DEPTH = 4;
/** the soft-decay length scale = REST_THIRD = HALF_L/3 (own-third depth). */
export const HOME_REGION_DECAY_M = HALF_L / 3;

/**
 * The M3′ soft bias: `strength` inside the back home region, exp-decayed by the
 * candidate's team-local depth distance outside it. Added to the per-candidate
 * advantage at the v3 consumption point (positive ⇒ home-ward candidates score
 * higher ⇒ the granted body stations deeper). `strength === 0` ⇒ 0 (inert).
 */
export function backHomeRegionBias(strength: number, candLocalX: number): number {
  if (strength === 0 || !Number.isFinite(candLocalX) || !Number.isFinite(strength)) return 0;
  const outside = Math.max(0, Math.abs(candLocalX - HOME_REGION_CENTER_LOCAL_X) - HOME_REGION_HALF_DEPTH);
  return strength * Math.exp(-outside / HOME_REGION_DECAY_M);
}

// ===========================================================================
// A4-P1d (ruling #143) — THE DORMANT HOME-MAP GRANT (the WHOLE-DISTRIBUTION
// form of the M1′ soft-bias instrument; docs/world-model/A4-P1D-MAP-GRANT-CENSUS.md).
// P1c granted ONE body a single back home region; P1d grants EVERY side-d
// outfielder his OWN coarse 2D home, centred on HIS formation base spot (the
// world's own per-body variable — ATTACK_FORMATIONS in formations.ts, the
// team's evolved formation, NOT a hand-authored distribution — M2′ gen-0
// content #136.3), and prices a distance-decayed SOFT bias toward it. The P1c
// single-body flag (Match.homeRegionGrant + backHomeRegionBias) is BANKED
// UNTOUCHED; this is a NEW, parallel form.
//
// Hand-built here = the COORDINATE FRAME + the BLENDING RULE ONLY (I-A2/I-A4
// 诚实张力): the per-body CENTER is the world's own formation variable; the
// EXTENTS are pre-registered from PUBLISHED pitch constants on BOTH axes (#136 —
// depth AND width, the deconfliction定义 needs lateral separation); the STRENGTH
// is a pre-registered DOSE (a gene when shipped — I-A3). NO clamps (M3′: the
// clamp is the P1b-certified disease). The bias is the P1c distance-decayed soft
// EXPONENTIAL extended to 2D: full `strength` inside the axis-aligned home box
// [homeX ± half-depth] × [homeY ± half-width], exp-decayed by the EUCLIDEAN
// distance to that box outside it. PURE: no world read, no clamp, no mutation;
// the caller supplies the candidate's own team-local (depth, width) and the
// body's own home (from the formation table). Dormant in production
// (Match.homeMapGrant is null).
//
// EXTENTS — published-anchored, BOTH axes (FLAGGED derivation, executor's choice):
//   half-depth = HALF_L / 6   (a coarse depth band — half of the own-third scale)
//   half-width = BOX_WIDTH / 4 (a coarse lateral band — a quarter of the box width)
//   decay      = HALF_L / 3    (REST_THIRD; the SAME soft-decay scale as P1c)
/** the home-box depth half-extent (published: half the own-third depth scale). */
export const HOME_MAP_HALF_DEPTH = HALF_L / 6;
/** the home-box width half-extent (published: a quarter of the penalty-box width). */
export const HOME_MAP_HALF_WIDTH = BOX_WIDTH / 4;
/** the soft-decay length scale = REST_THIRD = HALF_L/3 (the P1c decay, reused). */
export const HOME_MAP_DECAY_M = HALF_L / 3;

/**
 * The M3′ soft 2D bias: `strength` inside the body's axis-aligned home box
 * (centred on his formation base spot, both team-local coords), exp-decayed by
 * the Euclidean distance to that box outside it. Added to the per-candidate
 * advantage at the v3 consumption point (positive ⇒ home-ward candidates score
 * higher ⇒ the body stations toward his home). `strength === 0` ⇒ 0 (inert).
 * All coordinates are team-local (localX = worldX·attackDir, localY = worldY).
 */
export function homeMapBias(
  strength: number, candLocalX: number, candLocalY: number,
  homeLocalX: number, homeLocalY: number,
): number {
  if (strength === 0 || !Number.isFinite(strength)
    || !Number.isFinite(candLocalX) || !Number.isFinite(candLocalY)
    || !Number.isFinite(homeLocalX) || !Number.isFinite(homeLocalY)) return 0;
  const outX = Math.max(0, Math.abs(candLocalX - homeLocalX) - HOME_MAP_HALF_DEPTH);
  const outY = Math.max(0, Math.abs(candLocalY - homeLocalY) - HOME_MAP_HALF_WIDTH);
  const outside = Math.hypot(outX, outY);
  return strength * Math.exp(-outside / HOME_MAP_DECAY_M);
}

// ---------------------------------------------------------------------------
// A4-P2 (ruling #148) — THE SHIPPED-FORM STRENGTH SCALE for the home-map bias.
// P1c/P1d/P1e priced the map grant's strength in DOSE units of `VAL_SCALE` — the
// SD of the neutral-weight station value, derived IN-PROBE (not a src constant)
// and pinned at `0.163494` (docs/world-model/A4-P1E-LOWDOSE-CENSUS.md §"Strengths",
// the same value the P1c/P1d/P1e probes recomputed and asserted). A4-P1e (#148)
// CERTIFIED the non-harmful strength span as (0, 0.5]×VAL_SCALE with the resolved
// discipline benefit at the low end; the whole grid {0.125..0.5}× was point-
// beneficial, none resolved harm. For the SHIPPED mechanism the strength is no
// longer an injected dose but a GENE (I-A3: genes are evolution's seat), so the
// certified UPPER bound is pinned here as a NAMED FROZEN src constant with its
// provenance: 0.5 × 0.163494 = 0.081747. The per-team obedience gene ∈ [0, 1]
// maps LINEARLY onto [0, HOME_MAP_STRENGTH_MAX] — 1 = the certified ceiling,
// 0 = no agreement (the born value; the incumbent world, byte-identical). The
// certified PRIMARY (0.25× = 0.0409) sits at obedience 0.5.
/** the certified home-prior strength ceiling = 0.5 × VAL_SCALE(0.163494); the
 *  A4-P1e non-harmful span's upper bound (docs/world-model/A4-P1E-LOWDOSE-CENSUS.md,
 *  ruling #148). The obedience gene ∈ [0,1] scales linearly onto [0, this]. */
export const HOME_MAP_STRENGTH_MAX = 0.5 * 0.163494;

/**
 * Map a per-team home-prior OBEDIENCE gene value (∈ [0,1], the shipped form of
 * the M3′ dose) to the eye-native bias strength ∈ [0, HOME_MAP_STRENGTH_MAX].
 * PURE, linear, no clamp beyond the gene's own [0,1] domain (obedience 0 ⇒ 0 ⇒
 * inert ⇒ the incumbent world). Out-of-domain / non-finite ⇒ 0 (defensive: a
 * born-absent gene reads 0 at the caller via `?? 0`).
 */
export function homePriorStrength(obedience: number): number {
  if (!Number.isFinite(obedience) || obedience <= 0) return 0;
  const v = obedience > 1 ? 1 : obedience;
  return v * HOME_MAP_STRENGTH_MAX;
}

/** The 18-candidate lattice, byte-for-byte P1R's (§2.3 of that contract). */
export interface EyeCandidate { readonly id: string; readonly dx: number; readonly dy: number }
export const EYE_LATTICE: readonly EyeCandidate[] = (() => {
  const out: EyeCandidate[] = [];
  for (const r of [7, 14, 21]) {
    for (const a of [0, 60, 120, 180, 240, 300]) {
      const rad = (a * Math.PI) / 180;
      out.push({
        id: `r${r}a${a}`,
        dx: Number((r * Math.cos(rad)).toFixed(9)),
        dy: Number((r * Math.sin(rad)).toFixed(9)),
      });
    }
  }
  return out;
})();

/**
 * §2.5 / P1 §4.7, frozen before P1R's results existed so it could not be
 * fitted to them. Existing tactical genes only; a neutral genome lands exactly
 * at (0.5, 0.5), i.e. on the census's own unweighted signed axis.
 */
export function faceWeights(arm: StationEyeArm, g: TacticalGenome): { ws: number; wc: number } {
  if (arm !== 'gene') return { ws: 0.5, wc: 0.5 };
  return {
    ws: 0.5 + 0.5 * (g.tempo * 0.5 + g.attackingWidth * 0.5 - 0.5),
    wc: 0.5 + 0.5 * (g.defensiveCompactness * 0.5 + (g.coverBias ?? 0.5) * 0.5 - 0.5),
  };
}

export type ThreatBand = 'ownThird' | 'middle' | 'theirThird';
export const localXBand = (localX: number): ThreatBand => (
  localX < -HALF_L / 3 ? 'ownThird' : localX > HALF_L / 3 ? 'theirThird' : 'middle'
);

/** What the body believes about the moment. Face is undefined when unpriced. */
export interface PerceivedContext {
  readonly key: string;
  readonly face: 'ours' | 'theirs';
  readonly ballX: number;
  /** Diagnostics only (M-CTX): how the three features were read. */
  readonly threat: ThreatBand;
  readonly crowded: boolean;
}

/**
 * §2.3 — the perceived context, from the body's OWN pulled snapshot. No truth
 * by the back door (#8(l)): if the snapshot carries no ball, or the ball it
 * carries has no owner, there is no cell to price and the caller abstains.
 *
 * `localXOf` is the observer team's own local transform, passed in so this
 * module never reaches into the sim.
 */
export function perceivedContext(
  snap: PerceptionSnapshot | null,
  observerGid: number,
  observerSide: 0 | 1,
  observerPos: { readonly x: number; readonly y: number },
  localXOf: (worldX: number) => number,
): PerceivedContext | null {
  if (snap === null || snap.ball === null) return null;
  const ownerGid = snap.ball.ownerGid;
  if (ownerGid === null) return null;
  const ownerSide = Math.floor(ownerGid / TEAM_SIZE);
  const face = ownerSide === observerSide ? 'ours' : 'theirs';
  // §2.3: teammates the body BELIEVES are near him — remembered positions
  // included, since his memory is his belief. The snapshot cannot report
  // sent-off status, so a sent-off teammate still inside retention counts;
  // disclosed rather than patched with truth.
  let near = 0;
  for (const q of snap.players) {
    if (q.gid === observerGid) continue;
    if (q.side !== observerSide) continue;
    if (q.gid % TEAM_SIZE === 0) continue; // keeper, excluded as P1R excludes him
    if (Math.hypot(q.pos.x - observerPos.x, q.pos.y - observerPos.y) <= DENSITY_RADIUS) near += 1;
  }
  const threat = localXBand(localXOf(snap.ball.pos.x));
  const crowded = near >= 2;
  return {
    key: `${face}|${threat}|${crowded ? 'crowded' : 'sparse'}`,
    face, threat, crowded, ballX: snap.ball.pos.x,
  };
}

/**
 * Probe observability only — the sim writes, nothing in the sim reads it back
 * (the `c4Trace` pattern). Present ⇔ a probe asked for it, so the live path
 * pays nothing and the M-* mediators of contract §3.5 have a source.
 */
export interface StationEyeTrace {
  decisions: number;
  deviate: number;
  abstainNoSnapshot: number;
  abstainNoBall: number;
  abstainNoOwner: number;
  noCell: number;
  tie: number;
  /** ticks where a committed body's action left the station family */
  nonStationTicks: number;
  /** override ticks, and the ones where a clamp rewrote the target (#43.3) */
  overrideTicks: number;
  byCandidate: Map<string, number>;
  byContext: Map<string, number>;
  /** M-CTX: perceived vs true context, per feature (probe-only truth read) */
  ctxSeen: number;
  ctxAgree: number;
  ctxAgreeFace: number;
  ctxAgreeThreat: number;
  ctxAgreeDensity: number;
  // --- V2-P2R §4: the abort ledger (D-ABORT is a sub-tally of `deviate`) --------
  /** D-ABORT: deviation windows that LAPSED mid-window via D3-DUPLICATE. */
  abort: number;
  /** time-to-abort histogram: commit→abort elapsed TICKS → count (p50/p90/min/max). */
  abortTicks: Map<number, number>;
  /** wasted ticks summed = ticks spent chasing X* before the lapse (== time-to-abort). */
  abortWastedTicks: number;
  /** contributor churn at abort: Σ|G_commit|, Σ|G_mid|, Σ|G_mid\G_commit|. */
  abortGCommit: number;
  abortGMid: number;
  abortNewContributors: number;
  /** distinct NEW-contributor identities that drove aborts: gid → count. */
  abortDrivers: Map<number, number>;
  // --- V4-P3-PARTIAL §2/§3 (P3p-0): the dormant law + two-bit observability ------
  // Written ONLY when the matching `eye.v4` flag is set (absent in production and
  // in every v1/v2/v3 arm ⇒ these stay 0, X-OFF-IDENT). The counters expose the
  // in-support classification and each bit's tri-state to the P3p-1 census / the
  // P3p-2 consumer (the `c4Trace`/StationEyeTrace write-only precedent).
  /** §2: in-support-law classification tallies (one per consulted decision). */
  v4InSupport: number;
  v4OosPhase: number;
  v4OosUnseen: number;
  v4OosInflight: number;
  v4OosStale: number;
  /** §3.1: delivery wide-occupancy bit tri-state (per decision, one MOMENT value). */
  v4WidthHeld0: number;
  v4WidthHeld1: number;
  v4WidthHeldUnknown: number;
  /** §3.2: offside beyond-line bit tri-state (summed over the 18 per-CANDIDATE reads). */
  v4BeyondLine0: number;
  v4BeyondLine1: number;
  v4BeyondLineUnknown: number;
  // --- V4-P3p-2a §4 (the consumption ledger): child-vs-base read counts by family.
  // Over in-scope PRICED candidates (a child entry exists for this ctx‖role×cand
  // AND the base candidate is eligible), how often the resolved cell was a CHILD
  // refinement vs the retained v3 BASE. Written ONLY when that family's bit flag is
  // armed AND the merged children are injected. A remedy whose child count is ≈ 0
  // never fires at consumption (reading (C), STAGE3-V4-P3P2-CONSUMER §6.2).
  v4DeliveryChild: number;
  v4DeliveryBase: number;
  v4OffsideChild: number;
  v4OffsideBase: number;
}

export const newStationEyeTrace = (): StationEyeTrace => ({
  decisions: 0, deviate: 0, abstainNoSnapshot: 0, abstainNoBall: 0, abstainNoOwner: 0,
  noCell: 0, tie: 0, nonStationTicks: 0, overrideTicks: 0,
  byCandidate: new Map(), byContext: new Map(),
  ctxSeen: 0, ctxAgree: 0, ctxAgreeFace: 0, ctxAgreeThreat: 0, ctxAgreeDensity: 0,
  abort: 0, abortTicks: new Map(), abortWastedTicks: 0,
  abortGCommit: 0, abortGMid: 0, abortNewContributors: 0, abortDrivers: new Map(),
  v4InSupport: 0, v4OosPhase: 0, v4OosUnseen: 0, v4OosInflight: 0, v4OosStale: 0,
  v4WidthHeld0: 0, v4WidthHeld1: 0, v4WidthHeldUnknown: 0,
  v4BeyondLine0: 0, v4BeyondLine1: 0, v4BeyondLineUnknown: 0,
  v4DeliveryChild: 0, v4DeliveryBase: 0, v4OffsideChild: 0, v4OffsideBase: 0,
});

/** §2.2: the station families. Ball-directed jobs are never overridden. */
export const STATION_FAMILY: ReadonlySet<string> = new Set([
  'MoveToFormationSpot', 'HoldPosition', 'SupportBallCarrier', 'MakeRun', 'MarkOpponent',
]);

export type EyeOutcome =
  /** an override was issued */
  | { kind: 'deviate'; candidate: EyeCandidate; context: string; advantage: number }
  /** the percept carried no priceable ball (E-ABSTAIN-UNSEEN) */
  | { kind: 'abstainUnseen'; reason: 'noSnapshot' | 'noBall' | 'noOwner' }
  /** no candidate in the perceived cell met the n >= 150 floor (E-NOCELL) */
  | { kind: 'noCell'; context: string }
  /** the best advantage was <= 0 — the eye chose the incumbent (E-TIE) */
  | { kind: 'tie'; context: string; best: number };

/**
 * §2.4 — the selection rule, frozen: price every eligible candidate against
 * the census's own control arm and deviate iff the advantage is strictly
 * positive. Ties, an empty eligible set and abstention all resolve to NO
 * OVERRIDE, each in its own counted class.
 *
 * The INVERTED arm takes the argmin instead: §3.4's positive control, which
 * must measurably hurt.
 */
export function priceApproaches(
  table: ApproachTable,
  contextKey: string,
  arm: StationEyeArm,
  genome: TacticalGenome,
): EyeOutcome {
  const cells = table[contextKey];
  if (cells === undefined) return { kind: 'noCell', context: contextKey };
  const control = cells[CONTROL_ID];
  if (control === undefined) return { kind: 'noCell', context: contextKey };
  const { ws, wc } = faceWeights(arm, genome);
  const value = (c: ApproachCell): number => ws * c.score - wc * c.concede;
  const base = value(control);
  const invert = arm === 'inverted';
  let best: EyeCandidate | null = null;
  let bestAdv = 0;
  let eligible = 0;
  for (const cand of EYE_LATTICE) {
    const cell = cells[cand.id];
    if (cell === undefined || cell.n < CELL_FLOOR) continue;
    eligible += 1;
    const adv = value(cell) - base;
    const rank = invert ? -adv : adv;
    if (best === null || rank > (invert ? -bestAdv : bestAdv)) { best = cand; bestAdv = adv; }
  }
  if (eligible === 0) return { kind: 'noCell', context: contextKey };
  if (best === null) return { kind: 'noCell', context: contextKey };
  // Strict positivity for the ordinary arms; the inverted control commits to
  // its worst candidate whatever the sign, which is what makes it a power
  // instrument rather than a second copy of the eye.
  if (!invert && bestAdv <= 0) return { kind: 'tie', context: contextKey, best: bestAdv };
  return { kind: 'deviate', candidate: best, context: contextKey, advantage: bestAdv };
}

// ===========================================================================
// STAGE III V2-P2 — THE GOING-CONDITIONED CONSUMER (the ONE amendment, §2.2/§2.4)
//
// V2-P1 built a going-conditioned table: each context carries a going0 and a
// going1 cell per candidate, keyed on the candidate's TRUE OTHERS-GOING bit. The
// V2-P2 chooser reads the body's OWN perceived going-bit per candidate and prices
// each candidate through its going-conditioned cell against the incumbent control
// priced in the SAME (context × going-bit) — the composition price, consumed. The
// table is TRUE-keyed; the eye reads PERCEIVED (the perception exchange is the
// ORACLE-CTX arm's price, never smuggled away). Nothing here is reachable from a
// production path; the eye is null in the shipped game.
// ===========================================================================

/** One going-split census cell — the committed V2-P1 table's cell shape. */
export interface GoingCell {
  readonly n: number;
  readonly score: number;
  readonly concede: number;
  readonly value: number;
  readonly underPowered?: boolean;
}
/** context key → {going0, going1} → candidate id → cell. The committed table. */
export type GoingConditionedTable =
  Readonly<Record<string, { readonly going0: Readonly<Record<string, GoingCell>>; readonly going1: Readonly<Record<string, GoingCell>> }>>;
/** context key → {going0, going1} → the recovered control level (§2.4a). */
export type ControlLevels =
  Readonly<Record<string, { readonly going0: GoingCell; readonly going1: GoingCell }>>;

/** A remembered / true teammate motion fix, ball-local going-bit input (§2.2). */
export interface TeammateMotion {
  readonly px: number; readonly py: number; readonly vx: number; readonly vy: number;
}

/**
 * V2-P2R §1.4: the same motion fix, carrying the teammate's identity. The abort's
 * contributor scan (`goingContributors`) tracks WHICH teammates are going into the
 * committed region so the set-difference G_mid \ G_commit can be computed; the
 * bit-only `goingBits` ignores identity, so a `TeammateMotionId[]` is accepted there
 * unchanged (it is a `TeammateMotion`).
 */
export interface TeammateMotionId extends TeammateMotion { readonly gid: number }

/**
 * §2.2 — the PERCEIVED going-bit per candidate, from the body's OWN snapshot
 * (V2-P1's PERCEIVED column verbatim: R = 4.0 m, W = 3.0 s advance, TRUE ball-
 * local candidate points, remembered teammate velocities). A teammate with no
 * remembered fix contributes nothing (the caller passes only remembered fixes).
 * The ORACLE-CTX arm passes TRUE teammate motion and gets the TRUE bit.
 */
export function goingBits(
  ballX: number, ballY: number, attackDir: number, teammates: readonly TeammateMotion[],
): Record<string, 0 | 1> {
  const out: Record<string, 0 | 1> = {};
  for (const cand of EYE_LATTICE) {
    const cx = ballX + attackDir * cand.dx;
    const cy = ballY + cand.dy;
    let bit: 0 | 1 = 0;
    for (const t of teammates) {
      if (Math.hypot(t.px + t.vx * EYE_W_S - cx, t.py + t.vy * EYE_W_S - cy) <= EYE_R_M) { bit = 1; break; }
    }
    out[cand.id] = bit;
  }
  return out;
}

/**
 * V2-P2R §1.1/§1.2 — the going-CONTRIBUTOR set for ONE ball-local region (the
 * chosen candidate's offset `o*`), returning teammate IDENTITIES rather than a bit.
 * Byte-identical geometry to `goingBits` (W = 3.0 s velocity advance, R = 4.0 m,
 * TRUE ball-local candidate point, the ball's current position as the region
 * centre) — it is that scan tracking gids, per §1.4. `G_commit` is this evaluated
 * at commit against the commit-time ball; `G_mid` is it evaluated at a mid-window
 * re-read against the CURRENT ball (the region tracks the ball). The abort fires iff
 * `G_mid \ G_commit ≠ ∅`. A teammate with no remembered fix is simply absent from
 * the supplied list and contributes nothing (percept-honest; the ORACLE-CTX arm
 * passes TRUE motion).
 */
export function goingContributors(
  ballX: number, ballY: number, attackDir: number,
  offset: { readonly dx: number; readonly dy: number },
  teammates: readonly TeammateMotionId[],
): Set<number> {
  const cx = ballX + attackDir * offset.dx;
  const cy = ballY + offset.dy;
  const out = new Set<number>();
  for (const t of teammates) {
    if (Math.hypot(t.px + t.vx * EYE_W_S - cx, t.py + t.vy * EYE_W_S - cy) <= EYE_R_M) out.add(t.gid);
  }
  return out;
}

/** §2.3 repair 1 result: a perceived context, plus whether the FACE was retained
 *  from an in-flight last-perceived owner (the `inflight` marker, auditable). */
export interface PerceivedContextV2 extends PerceivedContext { readonly inflight: boolean }

/**
 * §2.3 (repair 1) — the perceived context with the in-flight FACE repair. When the
 * perceived ball carries no owner (ball in flight) the LAST-PERCEIVED owner is
 * used (`inflight = true`); with neither a live nor a retained owner there is no
 * priceable context and the caller abstains (E-ABSTAIN-UNSEEN). No truth by the
 * back door: the retained owner is one the body itself perceived.
 */
export function perceivedContextV2(
  snap: PerceptionSnapshot | null,
  observerGid: number,
  observerSide: 0 | 1,
  observerPos: { readonly x: number; readonly y: number },
  localXOf: (worldX: number) => number,
  retainedOwnerGid: number | null,
): PerceivedContextV2 | null {
  if (snap === null || snap.ball === null) return null;
  const liveOwner = snap.ball.ownerGid;
  const ownerGid = liveOwner ?? retainedOwnerGid;
  if (ownerGid === null) return null;
  const ownerSide = Math.floor(ownerGid / TEAM_SIZE);
  const face = ownerSide === observerSide ? 'ours' : 'theirs';
  let near = 0;
  for (const q of snap.players) {
    if (q.gid === observerGid) continue;
    if (q.side !== observerSide) continue;
    if (q.gid % TEAM_SIZE === 0) continue; // keeper, excluded as P1R excludes him
    if (Math.hypot(q.pos.x - observerPos.x, q.pos.y - observerPos.y) <= DENSITY_RADIUS) near += 1;
  }
  const threat = localXBand(localXOf(snap.ball.pos.x));
  const crowded = near >= 2;
  return {
    key: `${face}|${threat}|${crowded ? 'crowded' : 'sparse'}`,
    face, threat, crowded, ballX: snap.ball.pos.x, inflight: liveOwner === null,
  };
}

/** V2-P2 §2.4: is this candidate priceable? IN-POWER = both going splits hold. */
export function candidateInPower(cells: { going0: Readonly<Record<string, GoingCell>>; going1: Readonly<Record<string, GoingCell>> }, candId: string): boolean {
  const c0 = cells.going0[candId];
  const c1 = cells.going1[candId];
  return c0 !== undefined && c1 !== undefined
    && c0.n >= CELL_FLOOR && c1.n >= CELL_FLOOR
    && c0.underPowered !== true && c1.underPowered !== true;
}

/**
 * §2.4 (going-conditioned) — the selection rule. For the perceived context, over
 * IN-POWER candidates, read each candidate's PERCEIVED going-bit and look up the
 * going-conditioned cell; price it against the incumbent control priced in the
 * SAME (context × going-bit); deviate iff the best advantage is strictly positive.
 * INVERTED takes the argmin (the PC). Ties / empty set / abstention resolve to NO
 * OVERRIDE, each its own counted class — v1 priceApproaches semantics, exactly.
 */
export function priceApproachesV2(
  goingTable: GoingConditionedTable,
  control: ControlLevels,
  contextKey: string,
  arm: StationEyeArm,
  genome: TacticalGenome,
  bits: Record<string, 0 | 1>,
): EyeOutcome {
  const cells = goingTable[contextKey];
  const ctrl = control[contextKey];
  if (cells === undefined || ctrl === undefined) return { kind: 'noCell', context: contextKey };
  const { ws, wc } = faceWeights(arm, genome);
  const val = (c: GoingCell): number => ws * c.score - wc * c.concede;
  const invert = arm === 'inverted';
  let best: EyeCandidate | null = null;
  let bestAdv = 0;
  let eligible = 0;
  for (const cand of EYE_LATTICE) {
    if (!candidateInPower(cells, cand.id)) continue;
    const b = bits[cand.id] ?? 0;
    const cell = b === 1 ? cells.going1[cand.id] : cells.going0[cand.id];
    const base = b === 1 ? ctrl.going1 : ctrl.going0;
    if (cell === undefined || base === undefined || !Number.isFinite(base.value)) continue;
    eligible += 1;
    const adv = val(cell) - val(base);
    const rank = invert ? -adv : adv;
    if (best === null || rank > (invert ? -bestAdv : bestAdv)) { best = cand; bestAdv = adv; }
  }
  if (eligible === 0 || best === null) return { kind: 'noCell', context: contextKey };
  if (!invert && bestAdv <= 0) return { kind: 'tie', context: contextKey, best: bestAdv };
  return { kind: 'deviate', candidate: best, context: contextKey, advantage: bestAdv };
}

// ===========================================================================
// STAGE III V3-P2 — THE ROLE-CONDITIONED CONSUMER (the ONE amendment, §3.2)
//
// V3-P1 built a role-conditioned table: each context carries a per-ROLE column
// (DF/MF/WG/ST), each column an 18-candidate approach value keyed on the TRUE
// role of the forced body. The V3-P2 chooser is strictly SIMPLER than v2's: each
// body reads HIS OWN role's column — role is the world's own immutable own-state
// (`Player.role`, read never authored, A4-honoured trivially, no percept) — and
// argmaxes the value advantage vs the incumbent control recovered per
// (context × role). There is NO going-bit (#77.2(ii): the going axis is out of the
// v3 table), so the only perceived feature is the CONTEXT (face/third/density), as
// in v1. A DF and an ST at the same moment read DIFFERENT columns and argmax to
// different candidates BY CONSTRUCTION. Nothing here is reachable from a production
// path; the eye is null in the shipped game; the table + control are INJECTED by
// the probe, never bundled in `src/**`.
// ===========================================================================

/** One role-conditioned census cell — the committed V3-P1 table's cell shape. */
export interface RoleCell {
  readonly n: number;
  readonly score: number;
  readonly concede: number;
  readonly value: number;
  readonly underPowered?: boolean;
}
/** context key → role (DF|MF|WG|ST) → candidate id → cell. The committed table. */
export type RoleConditionedTable =
  Readonly<Record<string, Readonly<Record<string, Readonly<Record<string, RoleCell>>>>>>;
/** context key → role → the recovered control level (§4). */
export type RoleControlLevels =
  Readonly<Record<string, Readonly<Record<string, RoleCell>>>>;

/**
 * STAGE III V4-P3p-2 (STAGE3-V4-P3P2-CONSUMER §2.3): the P3p-1 MERGED table's
 * `children` sub-object verbatim — the bit-split EXTENSION of the v3 role table.
 * Shape `children[family][ctx‖role][cand][bit]`, where `family ∈ {delivery,
 * offside}`, the ctx‖role key is `${contextKey}||${role}`, and `bit ∈ {'0','1'}`.
 * Under STRICT keying (#115.1) the delivery family carries ONLY the `'1'` child,
 * so the bit level is `Partial` — a `'0'` delivery lookup hits `undefined` and
 * falls to BASE by the ordinary fallback (no code special-case, §2.2). INJECTED
 * by the probe as a sibling of `roleTable`; NEVER bundled in `src/**`.
 */
export type MergedChildTable = Readonly<Record<
  'delivery' | 'offside',
  Readonly<Record<string, Readonly<Record<string, Partial<Record<'0' | '1', RoleCell>>>>>>
>>;

/** §3.4: is this candidate priceable in this role's column? IN-POWER = the census
 *  resolved the contrast there (n ≥ floor, not under-powered). */
export function candidateInPowerRole(
  cells: Readonly<Record<string, RoleCell>>, candId: string,
): boolean {
  const c = cells[candId];
  return c !== undefined && c.n >= CELL_FLOOR && c.underPowered !== true;
}

/**
 * §3.4 (role-conditioned) — the selection rule. For the perceived context and the
 * body's OWN role, over IN-POWER candidates in that role's column, price each
 * candidate against the incumbent control recovered for the SAME (context × role);
 * deviate iff the best advantage is strictly positive. INVERTED takes the argmin
 * (the PC). Ties / empty set / abstention resolve to NO OVERRIDE, each its own
 * counted class — v1 priceApproaches semantics, exactly. A `(context, role)` with
 * no in-power candidate (incl. the 3 published under-powered DF pairs) resolves
 * `noCell` (E-NOCELL for that role) and is never pooled with another role (#77.2 / I7).
 */
export function priceApproachesV3(
  roleTable: RoleConditionedTable,
  control: RoleControlLevels,
  contextKey: string,
  role: Role,
  arm: StationEyeArm,
  genome: TacticalGenome,
  /** A4-P1c (#137): optional per-candidate SOFT home-region bias (dormant grant;
   *  undefined in production ⇒ +0 ⇒ byte-identical). Added to the advantage. */
  homeBias?: (cand: EyeCandidate) => number,
): EyeOutcome {
  const byRole = roleTable[contextKey];
  const ctrlByRole = control[contextKey];
  if (byRole === undefined || ctrlByRole === undefined) return { kind: 'noCell', context: contextKey };
  const cells = byRole[role];
  const ctrl = ctrlByRole[role];
  if (cells === undefined || ctrl === undefined || !Number.isFinite(ctrl.value)) {
    return { kind: 'noCell', context: contextKey };
  }
  const { ws, wc } = faceWeights(arm, genome);
  const val = (c: RoleCell): number => ws * c.score - wc * c.concede;
  const base = val(ctrl);
  const invert = arm === 'inverted';
  let best: EyeCandidate | null = null;
  let bestAdv = 0;
  let eligible = 0;
  for (const cand of EYE_LATTICE) {
    if (!candidateInPowerRole(cells, cand.id)) continue;
    const cell = cells[cand.id];
    eligible += 1;
    const adv = val(cell) - base + (homeBias?.(cand) ?? 0);
    const rank = invert ? -adv : adv;
    if (best === null || rank > (invert ? -bestAdv : bestAdv)) { best = cand; bestAdv = adv; }
  }
  if (eligible === 0 || best === null) return { kind: 'noCell', context: contextKey };
  if (!invert && bestAdv <= 0) return { kind: 'tie', context: contextKey, best: bestAdv };
  return { kind: 'deviate', candidate: best, context: contextKey, advantage: bestAdv };
}

// ===========================================================================
// STAGE III V4-P3p-2 — THE EXTENDED-KEY (PARTIAL) CONSUMER (§2.2, behind the
// EXISTING eye.v4 flags; ratified #117.3/#117.4)
//
// A thin refinement of priceApproachesV3: the ELIGIBLE SET and the ARGMAX are
// UNCHANGED (every base-in-power candidate stays eligible; the children only
// refine the priced VALUE, never eligibility). Per candidate the priced cell
// resolves by the FROZEN fallback order (§2.2):
//   family(cand) = cand.dx > 0 ? offside : delivery   (no dx=0 in the lattice)
//   NOT in-scope (no child entry for this ctx‖role×cand) → BASE
//   bit UNKNOWN (widthHeld for delivery / a per-candidate beyondLine for offside) → BASE
//   child absent / n < CELL_FLOOR / underPowered → BASE
//   else → the CHILD refinement
// Base is the universal retained anchor; abstention NEVER invents a value. The
// control is NOT bit-split (#117.3): adv = val(resolved) − val(the v3 per-(ctx×role)
// control). Ties / empty set / abstention resolve to NO OVERRIDE, each its own
// counted class — priceApproachesV3 semantics verbatim, only the per-candidate
// value SOURCE is refined. The per-family child/base read counts (over in-scope
// PRICED candidates) ride out in the result for the consumption ledger (§4). PURE
// — returns a value; the caller writes the trace.
// ===========================================================================

/** The percept-honest bit inputs for one moment (§2.2), computed at the decision. */
export interface PartialBitInputs {
  /** the delivery bit flag is armed (else the delivery family never consults a child). */
  readonly deliveryOn: boolean;
  /** the offside bit flag is armed (else the offside family never consults a child). */
  readonly offsideOn: boolean;
  /** §3.1 the MOMENT's wide-occupancy bit, shared by every delivery candidate
   *  (undefined ⇔ deliveryOn is false — never consulted in that case). */
  readonly widthHeld: BitValue | undefined;
  /** §3.2 the perceived second-last-opponent line (null ⇒ UNKNOWN), for beyondLine. */
  readonly offsideLine: number | null;
  /** §3.2 the perceived ball local-x, the beyondLine origin. */
  readonly ballLocalX: number;
}

/**
 * priceApproachesV3Partial's result: the v3-shaped `outcome` plus the per-family
 * child-vs-base read counts over IN-SCOPE PRICED candidates (§4 ledger). The
 * caller folds the four counts into the StationEyeTrace.
 */
export interface PartialEyeResult {
  readonly outcome: EyeOutcome;
  readonly deliveryChild: number;
  readonly deliveryBase: number;
  readonly offsideChild: number;
  readonly offsideBase: number;
}

export function priceApproachesV3Partial(
  roleTable: RoleConditionedTable,
  control: RoleControlLevels,
  children: MergedChildTable,
  contextKey: string,
  role: Role,
  arm: StationEyeArm,
  genome: TacticalGenome,
  bits: PartialBitInputs,
  /** A4-P1c (#137): optional per-candidate SOFT home-region bias (dormant grant;
   *  undefined in production ⇒ +0 ⇒ byte-identical). Added to the advantage. */
  homeBias?: (cand: EyeCandidate) => number,
): PartialEyeResult {
  let deliveryChild = 0; let deliveryBase = 0;
  let offsideChild = 0; let offsideBase = 0;
  const noCell = (context: string): PartialEyeResult => ({
    outcome: { kind: 'noCell', context }, deliveryChild, deliveryBase, offsideChild, offsideBase,
  });
  const byRole = roleTable[contextKey];
  const ctrlByRole = control[contextKey];
  if (byRole === undefined || ctrlByRole === undefined) return noCell(contextKey);
  const cells = byRole[role];
  const ctrl = ctrlByRole[role];
  if (cells === undefined || ctrl === undefined || !Number.isFinite(ctrl.value)) {
    return noCell(contextKey);
  }
  const { ws, wc } = faceWeights(arm, genome);
  const val = (c: RoleCell): number => ws * c.score - wc * c.concede;
  const base = val(ctrl);
  const invert = arm === 'inverted';
  const ckRole = `${contextKey}||${role}`;
  let best: EyeCandidate | null = null;
  let bestAdv = 0;
  let eligible = 0;
  for (const cand of EYE_LATTICE) {
    if (!candidateInPowerRole(cells, cand.id)) continue;   // §2.2: eligibility is v3's (BASE cells), unchanged
    eligible += 1;
    // §2.2 resolve(cand): default to the retained v3 BASE cell; refine to the CHILD
    // only through the frozen fallback order (family flag on → in-scope → bit known
    // → child in-power).
    let priced = cells[cand.id];
    const family: 'delivery' | 'offside' = cand.dx > 0 ? 'offside' : 'delivery';
    const flagOn = family === 'delivery' ? bits.deliveryOn : bits.offsideOn;
    if (flagOn) {
      const candChildren = children[family]?.[ckRole]?.[cand.id];
      if (candChildren !== undefined) {                    // IN-SCOPE — this family's ledger tracks it
        const bit: BitValue = family === 'delivery'
          ? (bits.widthHeld ?? 'UNKNOWN')
          : beyondLineBit(bits.offsideLine, bits.ballLocalX, cand.dx);
        let usedChild = false;
        if (bit !== 'UNKNOWN') {
          const child = candChildren[bit === 1 ? '1' : '0'];
          if (child !== undefined && child.n >= CELL_FLOOR && child.underPowered !== true) {
            priced = child;
            usedChild = true;
          }
        }
        if (usedChild) {
          if (family === 'delivery') deliveryChild += 1; else offsideChild += 1;
        } else if (family === 'delivery') { deliveryBase += 1; } else { offsideBase += 1; }
      }
    }
    const adv = val(priced) - base + (homeBias?.(cand) ?? 0);
    const rank = invert ? -adv : adv;
    if (best === null || rank > (invert ? -bestAdv : bestAdv)) { best = cand; bestAdv = adv; }
  }
  if (eligible === 0 || best === null) return noCell(contextKey);
  if (!invert && bestAdv <= 0) {
    return {
      outcome: { kind: 'tie', context: contextKey, best: bestAdv },
      deliveryChild, deliveryBase, offsideChild, offsideBase,
    };
  }
  return {
    outcome: { kind: 'deviate', candidate: best, context: contextKey, advantage: bestAdv },
    deliveryChild, deliveryBase, offsideChild, offsideBase,
  };
}
